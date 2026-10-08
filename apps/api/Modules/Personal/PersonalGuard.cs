using Microsoft.AspNetCore.Routing.Patterns;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// Strangers must not see each other (build plan §6, part C).
///
/// ─────────────────────────────────────────────────────────────────────────
///  Everyone in the personal house shares ONE tenant, and the product was
///  built for colleagues who are MEANT to see each other: a directory, name
///  suggestions, free/busy, an Organisation folder, delegation. In the house
///  every one of those is a stranger reading a stranger.
///
///  This middleware is the first of three layers, and the bluntest:
///
///   1. HERE — whole routes refused for anyone in the house: the ones whose
///      only purpose is organisation-wide (the list below).
///   2. In the handlers — routes that serve BOTH "mine" and "the
///      organisation's" (contact suggestions, calendars, Space scopes, Connect
///      joins) keep the first half and drop the second when
///      PersonalHouse.IsPersonalHouseAsync says so.
///   3. In the database — where a rule can be a constraint (the house can
///      never have AI switched on at organisation level).
///
///  The list is in ONE place so a reviewer can read it, and it is CHECKED AT
///  STARTUP against the routes actually mapped (Verify): a renamed route that
///  silently stopped being refused is the failure this guards against, and it
///  now fails the boot instead.
///
///  Answer: 403 with a plain sentence. Not 404 — the route exists for
///  organisation accounts, and a personal user whose app calls it by mistake
///  should see why, not a broken link.
///
///  Platform scope (the operator acting on the house) is not a personal user
///  and passes; the operator console has its own SuperAdmin fence.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class PersonalGuard(RequestDelegate next)
{
    /// <summary>A refused route: method (null = any) and the route template as mapped.</summary>
    public sealed record Refused(string? Method, string Template, string Why);

    /// <summary>
    /// Whole routes a personal account may never call. Templates are exactly
    /// as mapped (RoutePattern.RawText), constraints included.
    /// </summary>
    public static readonly IReadOnlyList<Refused> Routes =
    [
        // Mail — the directory is every mailbox in the tenant; delegation
        // lets one stranger grant another a view of their mail (and the
        // grant form confirms which user ids exist).
        new("GET",    "/api/mail/directory", "the people directory"),
        new("GET",    "/api/mail/mailboxes/{id:guid}/permissions", "mailbox delegation"),
        new("POST",   "/api/mail/mailboxes/{id:guid}/permissions", "mailbox delegation"),
        new("DELETE", "/api/mail/mailboxes/{id:guid}/permissions/{userId:guid}/{permission}", "mailbox delegation"),

        // Calendar — anyone's busy times by user id.
        new("GET",    "/api/calendar/freebusy", "other people's free/busy"),

        // Contacts — groups and labels are TENANT-wide (EF and RLS): one
        // stranger could read, rename or empty another's groups.
        new("GET",    "/api/family/groups", "contact groups"),
        new("POST",   "/api/family/groups", "contact groups"),
        new("PATCH",  "/api/family/groups/{groupId:guid}", "contact groups"),
        new("DELETE", "/api/family/groups/{groupId:guid}", "contact groups"),
        new("PUT",    "/api/family/groups/{groupId:guid}/members/{id:guid}", "contact groups"),
        new("DELETE", "/api/family/groups/{groupId:guid}/members/{id:guid}", "contact groups"),
        new("POST",   "/api/family/contacts/labels", "contact groups"),

        // Space — the people picker lists every user, with ids.
        new("GET",    "/api/space/directory", "the people directory"),

        // Photos — the bulk lookup turns any address into that person's user
        // id. A person's OWN photo (PUT/DELETE/GET on their own id) is handled
        // in InvokeAsync, not here.
        new("POST",   "/api/org/users/photos", "other people's photos"),
    ];

    /// <summary>
    /// Whole prefixes: organisation administration, Hire, the organisation
    /// API. A personal account has no organisation to administer; its role is
    /// employee so OrgAdmin refuses these already — this holds even if a
    /// house account were ever given an admin role by mistake.
    /// </summary>
    public static readonly IReadOnlyList<string> RefusedPrefixes =
    [
        "/api/org/",
        "/api/hire/",
        "/api/hire",
        "/api/mail/api-keys",
        "/api/v1/",
    ];

    public const string Sentence = "That isn't available on personal accounts.";

    public async Task InvokeAsync(HttpContext context, TenantContext tenant, PersonalHouse houses)
    {
        if (!tenant.HasTenant || tenant.IsPlatformScope || tenant.UserId is not Guid me
            || !await houses.IsPersonalHouseAsync(tenant.TenantId, context.RequestAborted))
        {
            await next(context);
            return;
        }

        var template = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;
        var method = context.Request.Method;
        var path = context.Request.Path.Value ?? "";

        // Their own photo: set, remove, read. Nobody else's.
        if (template == "/api/org/users/{id:guid}/avatar")
        {
            var id = context.GetRouteValue("id")?.ToString();
            if (Guid.TryParse(id, out var target) && target == me) { await next(context); return; }
            await RefuseAsync(context, "other people's photos");
            return;
        }

        var hit = Routes.FirstOrDefault(r =>
            r.Template == template && (r.Method is null || string.Equals(r.Method, method, StringComparison.OrdinalIgnoreCase)));
        if (hit is not null) { await RefuseAsync(context, hit.Why); return; }

        if (RefusedPrefixes.Any(p => path.Equals(p.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)
                                     || path.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
        {
            await RefuseAsync(context, "organisation administration");
            return;
        }

        await next(context);
    }

    private static async Task RefuseAsync(HttpContext context, string what)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(new { error = Sentence, personal = true, what });
    }

    /// <summary>
    /// Fail the boot if any refused route is not actually mapped — a rename
    /// would otherwise leave the new route open and this list guarding a
    /// ghost. Called once from Program.cs after the endpoints are mapped.
    /// </summary>
    public static void Verify(IEnumerable<EndpointDataSource> sources)
    {
        var mapped = sources.SelectMany(s => s.Endpoints).OfType<RouteEndpoint>()
            .SelectMany(e =>
            {
                var methods = e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [];
                return methods.Select(m => (Method: m, Template: e.RoutePattern.RawText));
            })
            .ToHashSet();

        var missing = Routes
            .Where(r => !mapped.Any(m => m.Template == r.Template
                                         && (r.Method is null || string.Equals(m.Method, r.Method, StringComparison.OrdinalIgnoreCase))))
            .Select(r => $"{r.Method} {r.Template}")
            .ToList();
        if (missing.Count > 0)
            throw new InvalidOperationException(
                "PersonalGuard refuses routes that are not mapped — a route was renamed or removed and its "
                + "replacement is now OPEN to personal accounts. Update PersonalGuard.Routes: "
                + string.Join("; ", missing));
    }
}
