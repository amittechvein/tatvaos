using System.Security.Claims;

namespace TatvaOS.Api.Shared.Auth;

/// <summary>
/// Who is signed in, read from the request's token. ONE place, because
/// fourteen copies of the wrong answer is how this was found.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHAT WENT WRONG (found 29 Sept 2026, while building organisation delete:
///  the database refused "an operator" it could not find).
///
///  The token carries the person's id as "sub". The JWT handler renames
///  inbound claims by default, so by the time an endpoint looks, "sub" has
///  become ClaimTypes.NameIdentifier and FindFirst("sub") returns NULL. Every
///  operator endpoint read it as
///
///      Guid.TryParse(http.User.FindFirst("sub")?.Value, out var id) ? id : Guid.Empty
///
///  which therefore answered Guid.Empty, always, and said nothing. That value
///  went into EnterPlatformScope, and from there into every audit line an
///  operator's action wrote: 303's reads of a customer's mail IDs, feature
///  overrides, plan changes, invoices issued and voided. All of them recorded,
///  none of them naming anybody. Invoices carry the same all-zero id in
///  created_by.
///
///  TenantMiddleware always read it correctly (NameIdentifier, then "sub"),
///  which is why an organisation's OWN administrators were named and only the
///  operator routes, which enter platform scope by hand, were not.
///
///  The order below is TenantMiddleware's. "sub" stays as the fallback so
///  that turning the handler's renaming off one day does not bring this back.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class SignedIn
{
    /// <summary>The person's id, or null when the request carries none.</summary>
    public static Guid? UserId(ClaimsPrincipal? user)
    {
        var raw = user?.FindFirst(ClaimTypes.NameIdentifier)?.Value
                  ?? user?.FindFirst("sub")?.Value;
        return Guid.TryParse(raw, out var id) && id != Guid.Empty ? id : null;
    }

    public static Guid? UserId(HttpContext http) => UserId(http.User);

    /// <summary>
    /// For the operator endpoints, which pass a Guid to EnterPlatformScope.
    /// Guid.Empty still means "nobody", and AuditWriter refuses to write a
    /// signed-in operator's action under it — so a token with no id is a loud
    /// failure at the first audited act, not a silent line naming no one.
    /// </summary>
    public static Guid UserIdOrEmpty(HttpContext http) => UserId(http.User) ?? Guid.Empty;
}
