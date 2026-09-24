using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Auth.Endpoints;

/// <summary>
/// A LOCAL-ONLY way to sign in as a platform operator without typing a
/// password anywhere. Never on in production — and built so that it cannot be.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Why this exists. Mr. Singh's ruling, 24 Sept 2026.
///
///  The operator console (apps/web/app/admin/organisations) is reached only
///  by a super_admin, and the only super_admin a local stack has is the one
///  BootstrapAdmin creates: a password from an environment variable, forced
///  into a reset on first sign-in. An agent correctly refuses to type a
///  password into a sign-in form, so nobody could look at that console
///  locally — and the Docs and Sheets per-organisation switches shipped to
///  production unseen because of it. The ruling: a development-only way in
///  that needs no password typed in a browser and is not forced into a
///  reset, impossible in production, and proven off by a test.
///
///  HOW. POST /api/dev/operator-session signs in ONE dedicated account,
///  dev-operator@tatvaos.test, through the same CompleteSignInAsync tail as
///  every other credential — so the session it issues is an ordinary session
///  and the console is exercised exactly as an operator would reach it. The
///  account is created here on first use with NO password, NO phone and NO
///  invitation, so no other door can open it: login refuses a null hash,
///  OTP needs a phone, invite/accept needs a token. It is never the real
///  bootstrap operator, whose row this never reads or writes. ".test" is a
///  reserved top-level domain (RFC 2606); mail to it cannot be delivered.
///
///  FOUR GATES, each sufficient on its own, all fail closed. Every one of
///  them is decided in DevOperatorGate.cs and nowhere else:
///
///   1. STARTUP. The switch (DevOperatorSignIn__Enabled=true, an
///      environment variable, deliberately NOT in any appsettings file)
///      turned on in any environment but Development refuses to boot.
///      A wrong ASPNETCORE_ENVIRONMENT on the box becomes a crash at start,
///      not a quiet operator door — same reasoning as the sensitive-data
///      logging check in Program.cs.
///   2. ROUTING. The route is mapped only when the environment is
///      Development AND the switch is on. Development alone is not enough:
///      CI runs the API as Development (.github/workflows/ci.yml) and must
///      not grow an operator door because of it. Unmapped means 404, and
///      the handler's code is unreachable.
///   3. REQUEST. The handler asks the host environment again. Belt and
///      braces against a future refactor that maps it somewhere else.
///   4. LOOPBACK. Only a caller on this machine. In production the only
///      thing that reaches the API is Caddy on the compose network, whose
///      address is never loopback — and the forwarded-headers middleware
///      forwards scheme and host only, never the client address, so no
///      header can make a remote caller look local.
///
///  Every use is logged as a warning and written to the audit trail.
///
///  Proven by tests/dev-operator/: gates/ compiles DevOperatorGate.cs and
///  checks every answer, including production's own caller address;
///  test.sh runs the built API — refused to boot as Production and as
///  Staging with the switch on, route absent as Production and as
///  Development with it off, and the positive case (a real operator session
///  that opens /api/admin/organisations) so the absences are known to be the
///  gates and not a wrong URL.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class DevOperatorSignIn
{
    public const string Route = "/api/dev/operator-session";

    public const string OperatorEmail = "dev-operator@tatvaos.test";

    /// <summary>
    /// Gate 2. Maps the route only in Development with the switch on; in
    /// every other case there is no route and the request is a 404.
    /// </summary>
    public static void MapDevOperatorSignIn(this WebApplication app)
    {
        if (!DevOperatorGate.IsOpen(app.Environment, app.Configuration))
            return;

        app.MapPost(Route, SignInAsync).AllowAnonymous().WithTags("Development only");

        app.Logger.LogWarning(
            "DEVELOPMENT ONLY: {Route} is mapped — a password-less platform-operator sign-in " +
            "for this machine. It exists because DevOperatorSignIn__Enabled is on.", Route);
    }

    private static async Task<IResult> SignInAsync(
        AppDbContext db, TenantContext tenant, TokenIssuer tokens, AuditWriter audit,
        HttpContext http, IServiceScopeFactory scopeFactory, IConfiguration config,
        IHostEnvironment env, TotpService totp, ILoggerFactory loggers, CancellationToken ct)
    {
        // Gate 3. 404, not 403: outside Development this route does not exist.
        if (!DevOperatorGate.IsOpen(env, config))
            return Results.NotFound();

        // Gate 4.
        var remote = http.Connection.RemoteIpAddress;
        if (!DevOperatorGate.IsLocalCaller(remote))
            return Results.NotFound();

        var log = loggers.CreateLogger("DevOperatorSignIn");

        // Platform-wide, like BootstrapAdmin: there is no tenant yet.
        var user = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.Email == OperatorEmail, ct);

        if (user is not null)
        {
            // Only ever the account this file made. If something else holds
            // the address, or it has somehow gained a credential, do not sign
            // it in — never overwrite, the same rule as BootstrapAdmin.
            if (user.Role != "super_admin" || user.PasswordHash is not null
                || user.Status is "suspended" or "deleted")
                return Results.Conflict(new
                {
                    error = $"{OperatorEmail} exists but is not the password-less local operator " +
                            "this endpoint creates. Not touching it.",
                });
        }
        else
        {
            var first = await db.Tenants.IgnoreQueryFilters()
                .OrderBy(t => t.CreatedAt)
                .FirstOrDefaultAsync(ct);
            if (first is null)
                return Results.Conflict(new
                {
                    error = "No organisation exists yet to attach the operator to. Apply the seed first.",
                });

            tenant.EnterPlatformScope(first.Id, Guid.Empty);
            await db.SyncTenantAsync(ct);

            user = new User
            {
                TenantId = first.Id,
                Email = OperatorEmail,
                DisplayName = "Local operator (development sign-in)",
                Role = "super_admin",
                Status = "active",
                PasswordHash = null,
                MustChangePassword = false,
            };
            db.Users.Add(user);
            db.Calendars.Add(TatvaOS.Api.Modules.Calendar.CalendarProvisioning.PrimaryFor(first.Id, user.Id));
            await db.SaveChangesAsync(ct);
        }

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        if (org?.Status is "suspended" or "deleted")
            return Results.Conflict(new { error = "The operator's organisation is suspended." });

        log.LogWarning(
            "DEVELOPMENT ONLY: issued a platform-operator session for {Email} from {Remote}.",
            OperatorEmail, remote);
        await audit.WriteAsync("auth.dev_operator_session", "user", user.Id.ToString(), ct: ct);

        // The same tail as password, OTP and invitation sign-in. totp is
        // passed so this door cannot skip a second factor if one is ever set.
        return await AuthEndpoints.CompleteSignInAsync(
            user, org, db, tokens, http, scopeFactory, config, ct, totp);
    }
}
