using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Admin.Endpoints;
using TatvaOS.Api.Modules.Auth.Endpoints;
using TatvaOS.Api.Modules.Core;
using TatvaOS.Api.Modules.Core.Endpoints;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Modules.Mail.Endpoints;
using TatvaOS.Api.Modules.Family;
using TatvaOS.Api.Modules.Family.Endpoints;
using TatvaOS.Api.Modules.Space.Endpoints;
using TatvaOS.Api.Modules.Calendar.Endpoints;
using TatvaOS.Api.Modules.Connect.Endpoints;
using TatvaOS.Api.Workers;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------------------
//  Tenancy — registered first because everything below depends on it
// ---------------------------------------------------------------------------
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<TenantContext>();
builder.Services.AddScoped<TenantConnectionInterceptor>();

// ---------------------------------------------------------------------------
//  Database
// ---------------------------------------------------------------------------
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    options.UseNpgsql(builder.Configuration.GetConnectionString("Postgres"));

    // The interceptor sets app.tenant_id on every connection. Without it, RLS
    // has nothing to compare against and every query returns zero rows.
    //
    // The connection string MUST use the tatvaos_app role, which is created
    // NOBYPASSRLS. Connecting as postgres or any BYPASSRLS role silently
    // disables tenant isolation — the queries succeed and return everything.
    options.AddInterceptors(sp.GetRequiredService<TenantConnectionInterceptor>());

    if (builder.Environment.IsDevelopment())
    {
        options.EnableSensitiveDataLogging();
        options.EnableDetailedErrors();
    }
});

// ---------------------------------------------------------------------------
//  Authentication and authorisation
// ---------------------------------------------------------------------------
var jwtKey = builder.Configuration["Jwt:SigningKey"]
             ?? Environment.GetEnvironmentVariable("JWT_SIGNING_KEY")
             ?? throw new InvalidOperationException(
                 "JWT signing key is not configured. Set Jwt:SigningKey or JWT_SIGNING_KEY. " +
                 "There is deliberately no default — a hardcoded fallback would ship to production.");

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidAudience = builder.Configuration["Jwt:Audience"],
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });

builder.Services.AddAuthorizationBuilder()
    .AddPolicy("SuperAdmin", p => p.RequireRole("super_admin"))
    .AddPolicy("OrgAdmin", p => p.RequireRole("super_admin", "org_owner", "org_admin"))
    .AddPolicy("User", p => p.RequireAuthenticatedUser());

// ---------------------------------------------------------------------------
//  Application services
// ---------------------------------------------------------------------------
builder.Services.AddScoped<IPasswordHasher, Argon2PasswordHasher>();
builder.Services.AddScoped<TokenIssuer>();
// Two-step verification. Scoped for consistency with the other auth
// services; it holds no state beyond the configured encryption key.
builder.Services.AddScoped<TotpService>();
builder.Services.AddScoped<StorageAllocator>();
builder.Services.AddScoped<AuditWriter>();

// Where Space's bytes live. Singleton — it holds only the root path; key
// format and path validation live inside. Swapping to S3-compatible object
// storage later is a new implementation of this interface, not an endpoint
// change. The volume behind Space:BlobRoot must be writable by UID 5000.
builder.Services.AddSingleton<TatvaOS.Api.Modules.Space.IBlobStore,
                              TatvaOS.Api.Modules.Space.FileSystemBlobStore>();

// The surface OTHER PRODUCTS call to read and store Space content — Mail's
// "attach from Space", Family's photos. Scoped: it runs on the caller's
// TenantContext, so every read is permission-checked as the signed-in user.
// Contract: docs/SPACE_ATTACH.md.
builder.Services.AddScoped<TatvaOS.Api.Modules.Space.SpaceContentGateway>();

// Connect. The token service is the ONLY holder of the LiveKit API secret —
// a browser never receives anything but a short-lived, room-scoped JWT it
// mints. Singleton because it holds configuration and no request state; the
// room client is typed-HttpClient so host controls are decided server-side
// rather than trusted from a caller's token.
builder.Services.AddSingleton<TatvaOS.Api.Modules.Connect.LiveKitTokenService>();
builder.Services.AddHttpClient<TatvaOS.Api.Modules.Connect.LiveKitRoomClient>();

// Connect recording. The options object is read ONCE at start and shared, like
// LiveKitOptions — a setting that can change under a running request is a
// setting two requests can disagree about.
builder.Services.AddSingleton(
    TatvaOS.Api.Modules.Connect.ConnectRecordingOptions.Read(builder.Configuration));
// Typed HttpClients: the egress client speaks Twirp to livekit:7880, and the
// other two speak to whatever transcription and notes endpoints are
// configured — which is nothing at all by default, so neither is ever called.
builder.Services.AddHttpClient<TatvaOS.Api.Modules.Connect.LiveKitEgressClient>();
builder.Services.AddHttpClient<TatvaOS.Api.Modules.Connect.ConnectTranscriber>();
builder.Services.AddHttpClient<TatvaOS.Api.Modules.Connect.ConnectNotesComposer>();

// The signed download ticket. Singleton because it derives one HMAC key from
// configuration and holds no request state.
//
// ─────────────────────────────────────────────────────────────────────────
//  THIS LINE'S ABSENCE TOOK THE WHOLE API DOWN, and it is worth knowing how.
//
//  ConnectDownloadTicket was written, built and unit-tested without ever
//  being registered. An unregistered type is not an error to ASP.NET's
//  minimal-API binder: it cannot resolve it as a service, so it INFERS it as
//  the request BODY. On the POST routes that would merely have failed at
//  request time. The download route is a GET, a GET may not have an inferred
//  body, and that is thrown while the endpoint graph is being built — before
//  a single request, taking mail, calendar and space down with it.
//
//  Nothing in a normal build catches this. `dotnet build` is happy, and so is
//  every unit test, because the binder only runs when the app starts.
// ─────────────────────────────────────────────────────────────────────────
builder.Services.AddSingleton<TatvaOS.Api.Modules.Connect.ConnectDownloadTicket>();

// Scoped: it writes through the request's AppDbContext and reads its
// TenantContext. A singleton holding either would serve one tenant's scope to
// whichever request arrived next.
builder.Services.AddScoped<ContactAutoSave>();

// Singleton: it holds a DNS client with its own connection handling, and a
// new resolver per request would discard that for no benefit.
builder.Services.AddSingleton<DomainVerifier>();

// Scoped, not singleton: it writes through AppDbContext and reads TenantContext,
// both of which are per-request. A singleton holding either would serve one
// tenant's scope to the next request that arrived.
builder.Services.AddScoped<TatvaOS.Api.Shared.Mail.DkimKeyService>();
builder.Services.AddSingleton<SignupVerifier>();
// Scoped, not singleton: both read platform settings from the database, so a
// credential saved in the console takes effect on the next request with no
// cache to invalidate and no restart.
builder.Services.AddHttpClient();
builder.Services.AddScoped<SettingsReader>();
builder.Services.AddScoped<SystemMailer>();
builder.Services.AddScoped<ISmsSender, SmsSender>();

// Indexes delivered mail from the Dovecot maildir into mail.messages so the
// webmail can read it. Hosted service, not scoped — it creates its own scope
// per mailbox because tenant context must change between mailboxes.
builder.Services.AddHostedService<MaildirIngestWorker>();

// Keeps core.storage_allocations.used_bytes derived from the mailbox figures.
// The storage endpoints reconcile the tenant being viewed, so this covers the
// readers with no human present: the add-user gate and the quota check.
builder.Services.AddHostedService<StorageReconcileWorker>();

// Answers Postfix's quota question at RCPT time — the last moment a refusal
// still leaves the message with the sender. Starts in observe-only mode and
// refuses nothing until Mail:QuotaEnforcement is set to "enforce".
builder.Services.AddHostedService<PostfixPolicyWorker>();

// OFF unless Mail:ThreadBackfill says otherwise. A one-off repair that fills
// thread_id on mail stored before threading existed - "report" to see what it
// would do, "run" to commit it. Left unset it returns immediately, which is
// how it should sit between the one time it is needed and every deploy after.
builder.Services.AddHostedService<ThreadBackfillWorker>();

// Scans stored attachments against clamd and records what it actually said.
// OFF until Mail:ClamAv points at a scanner: no configuration, no scanning,
// and never a fallback to "clean" - that assumption is the bug it removes.
builder.Services.AddScoped<ClamAvScanner>();
builder.Services.AddHostedService<AttachmentScanWorker>();

// Calendar reminders. Polls every minute and records every send, rather than
// scheduling in-memory timers that a deploy would silently swallow.
builder.Services.AddHostedService<CalendarReminderWorker>();

// Connect's recordings become transcripts, and transcripts become notes.
// Hosted service, not scoped — it creates its own scope per meeting because
// tenant context must change between them, and it returns immediately when
// Connect:Recording:Enabled is false. It also REPAIRS: anything LiveKit never
// finished telling us about is asked about directly, so a lost webhook costs
// a delay rather than a recording that never appears.
builder.Services.AddHostedService<ConnectNotesWorker>();

// The public-link resolve is the one anonymous, internet-reachable route
// on the platform. Per-IP fixed window. Behind Caddy the peer address is
// the proxy, so the client is the LAST entry of X-Forwarded-For — Caddy
// appends the real peer there; anything earlier is client-supplied and
// spoofable, which is why [^1] and not [0].
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    // Connect's guest join is the SECOND anonymous, internet-reachable route
    // on the platform, and it gets the same treatment for the same reasons —
    // including the [^1] on X-Forwarded-For. Same numbers deliberately: two
    // limits that drift apart are two behaviours to reason about.
    o.AddPolicy("connect-guest", httpContext =>
    {
        var xff = httpContext.Request.Headers["X-Forwarded-For"].ToString();
        var client = string.IsNullOrEmpty(xff)
            ? httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
        return RateLimitPartition.GetFixedWindowLimiter($"connect:{client}",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 60,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            });
    });

    o.AddPolicy("space-public-links", httpContext =>
    {
        var xff = httpContext.Request.Headers["X-Forwarded-For"].ToString();
        var client = string.IsNullOrEmpty(xff)
            ? httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
        return RateLimitPartition.GetFixedWindowLimiter(client,
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 60,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            });
    });
});

builder.Services.AddOpenApi();

builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:3000"])
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();

// ---------------------------------------------------------------------------
//  Pipeline — order matters
// ---------------------------------------------------------------------------
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
else
{
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseCors();

app.UseAuthentication();
// AFTER authentication — it reads the tenant claim from the validated principal.
// BEFORE the endpoints — they hit the database and need the context set.
app.UseMiddleware<TenantMiddleware>();
app.UseAuthorization();
app.UseRateLimiter();

// Reads Auth:CookieDomain. Unset locally and on staging (one host serves
// everything); ".tatvaos.com" in production, so a session started in Core is
// carried to Mail. See the cookie-domain block in AuthEndpoints.
TatvaOS.Api.Modules.Auth.Endpoints.AuthEndpoints.ConfigureCookies(app.Configuration);

app.MapAuthEndpoints();
app.MapMfaEndpoints();
app.MapOrganisationEndpoints();
app.MapUserEndpoints();
app.MapDomainEndpoints();
app.MapSignupEndpoints();
app.MapSettingsEndpoints();
app.MapDepartmentEndpoints();
app.MapStorageEndpoints();
app.MapAuditEndpoints();
// Shared mailboxes are PROVISIONING — the same act as creating a person, so
// Core owns it. Mail owns who may read one.
app.MapSharedMailboxEndpoints();
// "How much room do I have left?" — one answer for every product's meter.
app.MapMyStorageEndpoints();
// Calendar. Recurrence is expanded at read time, never stored — see
// Modules/Calendar/Recurrence.cs.
app.MapCalendarEndpoints();
app.MapMailEndpoints();
app.MapFamilyEndpoints();
app.MapSpaceEndpoints();
app.MapSpaceDriveEndpoints();
app.MapSpaceLinkEndpoints();

// Connect. Meetings live in this monolith; only the MEDIA is a separate
// container. The guest group and the LiveKit webhook are anonymous and
// rate-limited — see the header of ConnectGuestEndpoints.cs, and note that
// docs/CONNECT_BRIEF.md §8 requires Core's line-by-line review of that path
// before it is deployed.
app.MapConnectEndpoints();
app.MapConnectGuestEndpoints();
app.MapConnectWebhookEndpoints();
// Recording, transcripts and automatic notes. Signed-in only, and gated
// three times over — the organisation, the person, and the disk. See the
// header of ConnectRecordingEndpoints.cs.
app.MapConnectRecordingEndpoints();

// ---------------------------------------------------------------------------
//  Bootstrap the first super admin
// ---------------------------------------------------------------------------
//  A fresh database has no way in. Passwords are Argon2id, so they cannot be
//  seeded from SQL — there is no way to write a valid hash by hand — and a
//  seeded default password would be the same on every install, which is worse
//  than no login at all.
//
//  So: if no super admin exists AND both variables are set, create one. Runs
//  once; on every later start the account exists and this does nothing. Unset
//  the variables after the first start.
// ---------------------------------------------------------------------------
await BootstrapAdmin.EnsureAsync(app.Services, app.Logger);

app.MapGet("/health", () => Results.Ok(new { status = "ok" }))
   .AllowAnonymous()
   .WithTags("Operations");

app.MapGet("/health/db", async (AppDbContext db, CancellationToken ct) =>
{
    var canConnect = await db.Database.CanConnectAsync(ct);
    return canConnect ? Results.Ok(new { database = "ok" })
                      : Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
}).AllowAnonymous().WithTags("Operations");

app.Run();

/// <summary>Exposed so the integration and isolation tests can boot the app.</summary>
public partial class Program;
