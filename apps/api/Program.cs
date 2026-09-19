using Microsoft.AspNetCore.HttpOverrides;
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
using TatvaOS.Api.Shared.Auth.Oidc;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------------------
//  `TatvaOS.Api --oidc-rotate` — the key-rotation runbook's one step. Runs in
//  the API container against the same key directory, generates a new signing
//  key, marks the previous one retired (still published for a day), prints
//  the two kids and exits. Nothing private is printed. Restart the API after.
//  docs/runbooks/oidc-key-rotation.md.
// ---------------------------------------------------------------------------
var oidcKeyDirectory = builder.Configuration["Oidc:KeyDirectory"] ?? "/oidc";
if (args.Contains("--oidc-rotate"))
{
    var (newKid, retiredKid) = TatvaOS.Api.Shared.Auth.Oidc.OidcKeyRing.Rotate(oidcKeyDirectory);
    Console.WriteLine($"oidc: new signing key {newKid} is active; " +
                      (retiredKid is null ? "no previous key to retire." : $"{retiredKid} retired, published for one more day."));
    Console.WriteLine("Restart the API for the change to take effect.");
    return;
}

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

// ---- OpenID Connect provider (decision 0004) — stage 1: the stores -------
// OpenIddict's core with EF Core storage on our own entities, and the two
// pre-tenant lookups replaced by tenant-safe stores that consult SECURITY
// DEFINER resolvers (option (b)). The server half follows below: stage 2
// (keys, discovery, the key set) and stage 3 (authorize, token, userinfo).
// OPENIDDICT LOGS AT "Warning" AND NOT "Information" (appsettings.json).
// At Information its dispatcher prints every extracted request and every
// response. It redacts the code, the tokens and the client secret — and NOT
// the PKCE code_verifier, which stage 3's log check found in the clear four
// times on the first run (17 Sept 2026). A verifier without its code opens
// nothing, but 0004 says verifiers never appear in a log, and a log is read
// by more people than a database.
//
// WHAT THIS TRADES (CTO, 17 Sept 2026): OpenIddict's Information diagnostics
// are silenced in production too, so when SSO misbehaves in front of a
// customer, the detail is not in the log. Safe and blunt over clever and
// leaky, made deliberately. Diagnosing a production SSO problem means
// temporarily raising this level — and every minute it is raised, PKCE
// verifiers are written to the log until it is lowered again. Prefer
// reproducing the flow on a laptop with tests/oidc/stage3-flow.sh.
builder.Services.AddOpenIddict()
    .AddCore(o =>
    {
        o.UseEntityFrameworkCore()
         .UseDbContext<AppDbContext>()
         .ReplaceDefaultEntities<OidcApplication, OidcAuthorization, OidcScope, OidcToken, Guid>();
        o.ReplaceApplicationStore<OidcApplication, TenantSafeApplicationStore>();
        o.ReplaceTokenStore<OidcToken, TenantSafeTokenStore>();
    })
    // ---- stage 2: the issuer, its keys, discovery and the key set ---------
    // One issuer for every organisation. Discovery sits at the root, where
    // the standard says; everything else the document advertises lives under
    // /api/oauth/, which Caddy already routes to the API — except authorize,
    // whose advertised address is a web page (OidcEndpoints.cs, stage 3).
    .AddServer(o =>
    {
        var issuer = builder.Configuration["Oidc:Issuer"]
                     ?? builder.Configuration["Jwt:Issuer"]
                     ?? "https://core.tatvaos.com";
        o.SetIssuer(new Uri(issuer.TrimEnd('/') + "/"));
        o.SetConfigurationEndpointUris("/.well-known/openid-configuration");

        // The protocol shape of v1 (0004): authorization code with PKCE S256
        // required for every client, refresh tokens, nothing else. Declared
        // here because OpenIddict refuses to serve even discovery with no
        // flow enabled.
        o.AllowAuthorizationCodeFlow()
         .RequireProofKeyForCodeExchange()
         .AllowRefreshTokenFlow();
        o.RegisterScopes("openid", "profile", "email", "offline_access");
        // S256 only. OpenIddict also offers "plain" by default, which sends
        // the verifier itself as the challenge and protects nothing.
        o.Configure(options => options.CodeChallengeMethods.Remove(
            OpenIddict.Abstractions.OpenIddictConstants.CodeChallengeMethods.Plain));

        // Where the flow's endpoints live — under /api/oauth/, which Caddy
        // already routes to the API, and authorize under /api/auth/ so the
        // session cookie reaches it (OidcEndpoints.cs).
        //
        // PINNED TO THE ISSUER. Each endpoint is registered twice: first the
        // absolute URI on the issuer, second the bare path. OpenIddict
        // publishes only the FIRST in the discovery document, so every URL a
        // relying party stores is https://core.tatvaos.com/… whatever the
        // request's Host header or forwarded host said — issuer confusion is
        // a real attack on relying parties, and the forwarded-headers trust
        // below is defence in depth rather than the only defence (CTO, 17
        // Sept 2026). The bare path is what an incoming request is matched
        // on, so a laptop with no proxy still reaches the endpoints.
        var issuerUri = new Uri(issuer.TrimEnd('/') + "/");
        Uri[] Pinned(string path) => [new Uri(issuerUri, path), new Uri(path, UriKind.Relative)];
        // Authorize is TWO addresses on purpose (OidcEndpoints.cs): the
        // advertised one is the web page relying parties send people to, and
        // the matched one is the API endpoint under /api/auth/ that the page
        // hops to same-site, so the Strict session cookie arrives.
        o.SetAuthorizationEndpointUris(
            new Uri(issuerUri, OidcEndpoints.AuthorizePagePath),
            new Uri(OidcEndpoints.AuthorizePath, UriKind.Relative));
        o.SetTokenEndpointUris(Pinned(OidcEndpoints.TokenPath));
        o.SetUserInfoEndpointUris(Pinned(OidcEndpoints.UserInfoPath));
        o.SetIntrospectionEndpointUris(Pinned(OidcEndpoints.IntrospectionPath));
        o.SetRevocationEndpointUris(Pinned(OidcEndpoints.RevocationPath));
        o.SetJsonWebKeySetEndpointUris(Pinned(OidcEndpoints.JwksPath));

        // The token shape of 0004: codes, access and refresh tokens are OPAQUE
        // references stored hashed and revocable at once; only the ID token is
        // a JWT, and it lives five minutes because it cannot be recalled.
        o.UseReferenceAccessTokens();
        o.UseReferenceRefreshTokens();
        o.SetAuthorizationCodeLifetime(TimeSpan.FromSeconds(60));
        o.SetIdentityTokenLifetime(TimeSpan.FromMinutes(5));
        o.SetAccessTokenLifetime(TimeSpan.FromMinutes(10));
        o.SetRefreshTokenLifetime(TimeSpan.FromDays(14));
        // "A refresh token used twice revokes its whole chain" (0004).
        // OpenIddict's default forgives a second use within thirty seconds,
        // for clients that retry a lost response; here the second use is the
        // signal, as it is for core.refresh_tokens families.
        o.SetRefreshTokenReuseLeeway(TimeSpan.Zero);

        // The keys, from the oidckeys volume and nowhere else. Newest active
        // first: that is the one OpenIddict signs with; the rest — earlier
        // actives and keys retired within the last day — are published so
        // anything they signed still verifies. The encryption key is for
        // OpenIddict's own token payloads and is never published.
        var ring = TatvaOS.Api.Shared.Auth.Oidc.OidcKeyRing.Load(oidcKeyDirectory, Console.WriteLine);
        foreach (var k in ring.Signing) o.AddSigningKey(k.Key);
        foreach (var k in ring.Encryption) o.AddEncryptionKey(k.Key);
        Console.WriteLine($"oidc: issuer {issuer}; signing with {ring.Current.Kid}; " +
                          $"{ring.Signing.Count} signing key(s) published");

        var aspnet = o.UseAspNetCore()
            // Authorize is ours: a person in a browser, sign-in, consent.
            .EnableAuthorizationEndpointPassthrough()
            // Token and userinfo are ours too, for one reason each: liveness.
            // A code or refresh token is minted from only after the person's
            // and the organisation's status are read again; a claim is
            // answered only after the application's and the person's are.
            .EnableTokenEndpointPassthrough()
            .EnableUserInfoEndpointPassthrough();

        // OpenIddict refuses anything that is not HTTPS, and it is right to:
        // codes and tokens travel in these requests. On the box Caddy
        // terminates TLS and forwards the scheme, which the forwarded-headers
        // middleware turns back into an HTTPS request. On a laptop there is no
        // Caddy, so Development alone may speak plain HTTP to it. Never in
        // production: the startup guard above already refuses a production
        // process that thinks it is Development.
        if (builder.Environment.IsDevelopment())
            aspnet.DisableTransportSecurityRequirement();
    })
    // ---- stage 3: validating our own access tokens at userinfo ---------
    // The access token is an opaque reference (0004): validation finds its
    // row by hash — through the token store's resolver, which names the
    // tenant — and refuses it the moment the row says revoked. Authorization
    // entries are checked too, so revoking an application's authorizations
    // refuses every token under them at once, not at expiry.
    .AddValidation(o =>
    {
        o.UseLocalServer();
        o.UseAspNetCore();
        o.EnableTokenEntryValidation();
        o.EnableAuthorizationEntryValidation();
    });

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
// Scoped since 27 Aug 2026, following the gateway it wraps: consent went
// per-organisation, the gateway reads the tenant's flag per scope, and a
// composer holding a scoped gateway must be scoped itself. (It lost its own
// HttpClient on the 24th — key, timeout and token accounting all live in
// the gateway.)
builder.Services.AddScoped<TatvaOS.Api.Modules.Connect.ConnectNotesComposer>();

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
//  Scoped (was singleton until 27 Aug 2026): it still reads its three
//  settings per construction, but it now also reads the CURRENT TENANT's
//  allow_ai consent flag — which lives behind the scoped TenantContext and
//  AppDbContext. HttpClient still comes from the factory, so sockets are
//  pooled rather than exhausted.
//
//  Unset key is NOT an error. IsConfigured goes false, every feature built on
//  it degrades to what it did before, and the API starts normally. Refusing
//  to boot over an optional key would take mail and calendar down with it.
// ---------------------------------------------------------------------------
builder.Services.AddHttpClient();
// SCOPED since 27 Aug 2026: consent is per-organisation, so the gateway
// reads the current tenant's allow_ai flag (fail-closed) — which needs the
// scoped TenantContext and AppDbContext. Nothing else changed.
builder.Services.AddScoped<IAiGateway, OpenAiGateway>();

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

// Receives the accepted, RCPT-validated bounce over LMTP (master.cf routes
// bounces.tatvaos.com here), parses the DSN, and records it idempotently on
// the api_sends row its VERP address named. Dormant until the bounce domain
// and keyset are set, like the rest of the pipeline.
builder.Services.AddHostedService<BounceIntakeWorker>();

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

    // The handoff redeem (decision 0003) is anonymous and internet-reachable —
    // the browser presenting the code has no session yet, which is the entire
    // point of it. Five a minute per IP, from the decision: a person opening a
    // product from the phone redeems once, and the only caller who wants more
    // is someone spraying guesses at a 256-bit code.
    //
    // Per-IP and not per-code, unlike connect-wait: a code is single-use, so a
    // code-keyed bucket would cap a credential that already cannot be used
    // twice, and leave the spraying it is meant to stop unbounded. Same
    // X-Forwarded-For rule as the policies above — Caddy appends the real peer
    // LAST, and anything earlier is client-supplied.
    o.AddPolicy("auth-handoff-redeem", httpContext =>
    {
        var xff = httpContext.Request.Headers["X-Forwarded-For"].ToString();
        var client = string.IsNullOrEmpty(xff)
            ? httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
        return RateLimitPartition.GetFixedWindowLimiter($"handoff:{client}",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 5,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            });
    });

    // Same shape and reasoning as auth-handoff-redeem: per-IP, because the
    // token is single-use and a token-keyed bucket would bound nothing.
    // ------------------------------------------------------------------
    //  The organisation API (/api/v1/org/*). Anonymous, internet-reachable,
    //  and it CREATES PEOPLE, so it is limited harder than the read paths:
    //  30 a minute per address. A real onboarding run adds tens of people,
    //  not hundreds a minute, and anything faster is either a mistake worth
    //  interrupting or somebody enumerating.
    //
    //  Keyed on the address rather than the key: keying on the key would let
    //  anyone who learns a customer's key id exhaust that customer's budget,
    //  and the key is not in the URL to key on anyway.
    // ------------------------------------------------------------------
    o.AddPolicy("org-api", httpContext =>
    {
        var xff = httpContext.Request.Headers["X-Forwarded-For"].ToString();
        var client = string.IsNullOrEmpty(xff)
            ? httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
        return RateLimitPartition.GetFixedWindowLimiter($"org-api:{client}",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            });
    });

    o.AddPolicy("auth-invite-accept", httpContext =>
    {
        var xff = httpContext.Request.Headers["X-Forwarded-For"].ToString();
        var client = string.IsNullOrEmpty(xff)
            ? httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
        return RateLimitPartition.GetFixedWindowLimiter($"invite:{client}",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            });
    });

    // The handoff MINT (decision 0003). Authenticated, and until 16 Sept 2026
    // unlimited — while every successful call is a live sixty-second
    // credential. A loop in the app, or one stolen bearer token, could mint
    // thousands. The CTO's ruling, 16 Sept: per-user limit beside the others.
    //
    // Per USER, not per IP, unlike the redeem above. Mint always has a user;
    // an IP key would make a whole office behind one NAT share a budget, and
    // would hand a stolen token a fresh budget on every network it moved to.
    // The id is read the way TenantMiddleware reads it. There is no anonymous
    // fallback bucket to share: RequireAuthorization answers 401 before a
    // request without a user reaches this, so "unknown" is unreachable and is
    // only here so the partition can never throw.
    //
    // Ten a minute: a person opening products from the phone mints one per
    // tap. HandoffMintPerMinute has a second copy in
    // infra/scripts/verify-handoff-e2e.sh (MINT_LIMIT), which proves the
    // limit refuses — change both, and that script fails if you change one.
    const int HandoffMintPerMinute = 10;
    o.AddPolicy("auth-handoff-mint", httpContext =>
    {
        var user = httpContext.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
                   ?? httpContext.User.FindFirst("sub")?.Value
                   ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter($"handoff-mint:{user}",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = HandoffMintPerMinute,
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
//  Refuse to start as production with Development-only logging switched on.
//
//  EF's EnableSensitiveDataLogging prints every query parameter in the clear —
//  in this codebase that means hashed client secrets, token hashes, e-mail
//  addresses — and it is enabled above only under IsDevelopment(). That makes
//  ASPNETCORE_ENVIRONMENT, one hand-edited variable in a .env file that has
//  been copied around, the only thing between a secret and the log. CTO,
//  17 Sept 2026: assert it, so a wrong environment on the box is a loud
//  failure at startup rather than a quiet leak into `docker logs`.
//
//  Read from the OPTIONS that were actually built, not from the environment
//  name, so the check cannot drift from the code it guards.
// ---------------------------------------------------------------------------
using (var startupScope = app.Services.CreateScope())
{
    var dbOptions = startupScope.ServiceProvider.GetRequiredService<DbContextOptions<AppDbContext>>();
    var core = dbOptions.FindExtension<Microsoft.EntityFrameworkCore.Infrastructure.CoreOptionsExtension>();
    if (!app.Environment.IsDevelopment() && core?.IsSensitiveDataLoggingEnabled == true)
        throw new InvalidOperationException(
            "Refusing to start: EF Core sensitive-data logging is enabled but " +
            $"ASPNETCORE_ENVIRONMENT is '{app.Environment.EnvironmentName}'. That logging prints every " +
            "query parameter — hashed secrets and token hashes included — and is only ever meant for " +
            "Development. Fix the environment on this box, or the code that enabled it.");
}

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

// ---------------------------------------------------------------------------
//  Trust the scheme and host Caddy forwards. Caddy terminates TLS and proxies
//  to api:8080 over plain HTTP, so without this every request looks like
//  http://api:8080 to the API. Nothing minded until the OpenID Connect
//  provider (decision 0004): OpenIddict refuses non-HTTPS requests and builds
//  every URL in the discovery document from the request, so it would refuse
//  every call and advertise an address nobody can reach. With these headers
//  applied the request is https://core.tatvaos.com/… again.
//
//  SCHEME AND HOST ONLY — deliberately not X-Forwarded-For. The rate limiters
//  above read that header themselves and take its LAST entry, which is the
//  one Caddy appended; this middleware would consume that entry and leave any
//  client-supplied ones in front of it for the limiters to trust. Audit rows
//  keep recording Caddy's address as they do today; a real-client-IP change
//  is its own decision, not a side effect of the provider.
//
//  No known-proxy list, on purpose: the API publishes no port, so the only
//  thing that can reach it is Caddy on the compose network, whose container
//  address changes on every recreate. ForwardLimit 1: the nearest proxy only.
// ---------------------------------------------------------------------------
var forwarded = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost,
    ForwardLimit = 1,
};
forwarded.KnownIPNetworks.Clear();
forwarded.KnownProxies.Clear();
app.UseForwardedHeaders(forwarded);

app.UseHttpsRedirection();
app.UseCors();

// OIDC's two public paths are limited HERE, before UseAuthentication, because
// that is where OpenIddict finds the client (a database round trip) — a limit
// at the endpoint would sit behind the cost it exists to cap. The rest of the
// platform's limits are endpoint policies below, after the user is known.
app.UseWhen(ctx => OidcEndpoints.IsRateLimitedPath(ctx.Request.Path),
    branch => branch.UseRateLimiter(OidcEndpoints.RateLimiterOptions(builder.Configuration)));

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
app.MapOidcApplicationEndpoints();
app.MapOidcEndpoints();
app.MapDomainEndpoints();
app.MapSignupEndpoints();
app.MapSettingsEndpoints();
app.MapDepartmentEndpoints();
app.MapStorageEndpoints();
app.MapAuditEndpoints();
// Shared mailboxes are PROVISIONING — the same act as creating a person, so
// Core owns it. Mail owns who may read one.
app.MapSharedMailboxEndpoints();
// App passwords for third-party SMTP/IMAP clients — new file, Core-authored
// as a declared lane exception (see the endpoint header).
app.MapMailAppPasswordEndpoints();
app.MapMailApiKeyEndpoints();
// An organisation's own key, and the public call it authenticates.
app.MapOrgApiKeyEndpoints();
app.MapOrgApiEndpoints();
app.MapOrgMeetingApiEndpoints();
app.MapMailSendApiEndpoints();
// "How much room do I have left?" — one answer for every product's meter.
app.MapMyStorageEndpoints();
// The organisation's AI consent switch — the screen for allow_ai, so "can we
// turn it off ourselves" is answered by a toggle rather than a promise.
app.MapOrgAiEndpoints();
// Calendar. Recurrence is expanded at read time, never stored — see
// Modules/Calendar/Recurrence.cs.
app.MapCalendarEndpoints();
app.MapMailEndpoints();
// Mail categories - the colour system. A name and a colour somebody made for
// themselves; filters apply them, nothing infers them (see the endpoint header).
app.MapMailCategoryEndpoints();
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
// Sharing a recording outward. Written on 26 August and deliberately NOT
// registered until 9 September, because the organisation switch gating its
// fourth level - anyone holding the link - had nowhere to live and an
// ungated level 4 cannot be recalled. The switch now exists
// (connect.tenant_settings) and is enforced in the database, not here.
app.MapConnectShareEndpoints();

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
