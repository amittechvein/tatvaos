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
using TatvaOS.Api.Shared.Ai;
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
// A plain singleton since 24 Aug 2026: the composer no longer owns an
// HttpClient — its one network call goes through IAiGateway, which is
// where the key, the timeout and the token accounting live.
builder.Services.AddSingleton<TatvaOS.Api.Modules.Connect.ConnectNotesComposer>();

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

// The Private-meeting media key. Singleton for the same reason as the ticket
// above: it reads one secret at start and holds no request state.
//
// ─────────────────────────────────────────────────────────────────────────
//  THIS LINE IS LOAD-BEARING FOR THE SAME REASON THE ONE ABOVE IS.
//
//  ConnectRoomKey is a handler parameter on /api/connect/g/wait/{waitToken},
//  which is a GET. An unregistered type is not an error to the minimal-API
//  binder — it cannot resolve it as a service, so it INFERS it as the request
//  BODY, and a GET may not have an inferred body. That throws while the
//  endpoint graph is being built, before a single request, taking mail,
//  calendar, space and login down with it. Exactly what the absence of the
//  ConnectDownloadTicket registration did.
//
//  `dotnet build` is happy without this line, and so is every unit test,
//  because the binder only runs when the app starts.
// ─────────────────────────────────────────────────────────────────────────
builder.Services.AddSingleton<TatvaOS.Api.Modules.Connect.ConnectRoomKey>();

// ---------------------------------------------------------------------------
//  THE AI GATEWAY — the one place this platform talks to a language model.
//
//  Registered as the INTERFACE, deliberately. Mail, Connect and later Space
//  take IAiGateway and know nothing else: not the provider, not the key, not
//  the model. That is what makes moving to Azure OpenAI in an India region a
//  settings change, and what makes extracting this into a separate
//  tatvaos-ai-service later a second implementation plus this one line.
//
//  Singleton: it reads three settings at startup and holds no request state,
//  the same shape as ConnectRoomKey above. HttpClient comes from the factory
//  so sockets are pooled rather than exhausted.
//
//  Unset key is NOT an error. IsConfigured goes false, every feature built on
//  it degrades to what it did before, and the API starts normally. Refusing
//  to boot over an optional key would take mail and calendar down with it.
// ---------------------------------------------------------------------------
builder.Services.AddHttpClient();
builder.Services.AddSingleton<TatvaOS.Api.Shared.Ai.IAiGateway,
                              TatvaOS.Api.Shared.Ai.OpenAiGateway>();

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

// The disk-versus-database check: removes abandoned .part uploads, and
// REPORTS (never deletes) blobs no row points at. SPACE_FAULT_MATRIX #1 and
// #3 — both invisible failures on the filesystem Mail also writes to.
builder.Services.AddHostedService<SpaceBlobSweepWorker>();

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

// Sends out-of-office replies. Every rule inside it exists because of a
// specific loop - two responders answering each other, a mailing list, a
// bounce. Read the block at the top before relaxing any of them.
builder.Services.AddHostedService<VacationReplyWorker>();

// Calendar reminders. Polls every minute and records every send, rather than
// scheduling in-memory timers that a deploy would silently swallow.
builder.Services.AddHostedService<CalendarReminderWorker>();

// iMIP: what Mail's ingest calls when a delivered message carries a calendar
// reply (docs/MAIL_IMIP_SEAM.md §4). Scoped, because it runs inside the
// ingest worker's own scope and reads its TenantContext and DbContext.
//
// Registered NOW, in the same commit as the class, rather than when Mail's
// patch starts calling it. An unregistered service is not a compile error in
// this codebase — the minimal-API binder infers it as a request body, and on
// a GET that throws while the endpoint graph is built, before any request,
// taking the whole API down. That happened on 19 August. Register when you
// write, not when you wire.
builder.Services.AddScoped<TatvaOS.Api.Modules.Calendar.ICalendarImipSink,
                           TatvaOS.Api.Modules.Calendar.CalendarImipSink>();

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

    // F1 from Core's guest-path review (docs/reviews/CONNECT_GUEST_PATH.md):
    // /wait/{waitToken} polls every ~2 seconds, so a per-IP window rate-limits
    // a shared office NAT off its own admission — three waiting guests behind
    // one firewall exceed 60/min while doing exactly what the page told them
    // to do. The wait TOKEN is the better key: a bearer credential unique to
    // one waiting person, so it caps the individual poller, cannot be shared
    // by an office, and cannot be inflated by a stranger who does not hold it.
    //
    // Keyed by the token's SHA-256, not its plaintext: partition keys sit in
    // memory and can surface in diagnostics, and the plaintext of a bearer
    // credential is stored nowhere on this platform — ConnectCodes' rule.
    //
    // A request with NO well-formed token falls back to the per-IP key, or a
    // scanner spraying garbage would get a fresh bucket per request. (A
    // well-formed RANDOM token does get its own bucket; each such probe costs
    // one indexed hash lookup answering the one failure sentence, against a
    // 128-bit token space. Bounded by the shape check, that is accepted.)
    o.AddPolicy("connect-wait", httpContext =>
    {
        var token = httpContext.GetRouteValue("waitToken")?.ToString();
        if (TatvaOS.Api.Modules.Connect.ConnectCodes.IsWellFormed(token))
        {
            return RateLimitPartition.GetFixedWindowLimiter(
                $"connect-wait:tok:{TatvaOS.Api.Modules.Connect.ConnectCodes.HashToken(token!)}",
                _ => new FixedWindowRateLimiterOptions
                {
                    // The page's own cadence is ~30/minute; the rest is
                    // headroom for retries, never a second poller.
                    PermitLimit = 45,
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                });
        }
        var xff = httpContext.Request.Headers["X-Forwarded-For"].ToString();
        var client = string.IsNullOrEmpty(xff)
            ? httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
        return RateLimitPartition.GetFixedWindowLimiter($"connect-wait:ip:{client}",
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

// Translates message bodies through a translator in our own stack. OFF
// until Translate:Endpoint is set - the status endpoint says so plainly, so
// the client hides the control rather than offering one that fails.
builder.Services.AddScoped<TranslateService>();

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
app.MapSpaceThumbnailEndpoints();

// Connect. Meetings live in this monolith; only the MEDIA is a separate
// container. The guest group and the LiveKit webhook are anonymous and
// rate-limited - see the header of ConnectGuestEndpoints.cs. Core's
// line-by-line review of that path is docs/reviews/CONNECT_GUEST_PATH.md
// (pass, three findings, all closed). Note for the record that it shipped
// BEFORE that review rather than after, which the brief required.
app.MapConnectEndpoints();
app.MapConnectGuestEndpoints();
app.MapConnectWebhookEndpoints();
// Recording, transcripts and automatic notes. Signed-in only, and gated
// three times over - the organisation, the person, and the disk. See the
// header of ConnectRecordingEndpoints.cs.
app.MapConnectRecordingEndpoints();
app.MapConnectCaptionEndpoints();

// Operational: does the AI actually answer? SuperAdmin only, real round trip.
app.MapAiStatusEndpoints();

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
