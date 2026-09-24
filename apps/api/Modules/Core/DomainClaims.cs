namespace TatvaOS.Api.Modules.Core;

/// <summary>
/// Who may claim a domain, who wins it, and which claims have gone stale.
///
/// ── THE PROBLEM THIS EXISTS FOR ──────────────────────────────────────────
///
///  Mr. Singh, 24 September 2026: an unverified claim used to lock a domain
///  name platform-wide, so anyone with an account could add the domains of
///  every school in a district and stop all of them onboarding. The victim
///  saw "already in use", could not prove ownership through the product, and
///  had to find support.
///
///  Exclusivity now comes from VERIFICATION, not from claiming.
///
/// ── WHY THE RULES LIVE HERE AND NOT IN THE ENDPOINT ──────────────────────
///
///  Because they are the part worth testing, and the endpoint needs a
///  database, a tenant and live DNS to run at all. Every decision below is a
///  pure function of rows already loaded: what the endpoint does with the
///  answer is its business.
/// </summary>
public static class DomainClaims
{
    /// <summary>
    /// How long an unverified claim stands before it is swept. Thirty days is
    /// Mr. Singh's number: long enough for a school's DNS to be changed by
    /// whoever does that for them, short enough that a squatter's holdings
    /// evaporate rather than accumulate.
    /// </summary>
    public static readonly TimeSpan PendingClaimLifetime = TimeSpan.FromDays(30);

    /// <summary>
    /// The most domains one organisation may have claimed but not verified.
    /// A school adding five hundred domains in an hour is not a school.
    /// </summary>
    public const int MaxPendingPerTenant = 10;

    /// <summary>The state of a claim, as the decisions here need to see it.</summary>
    public readonly record struct Claim(Guid Id, Guid TenantId, bool Verified, bool Superseded, DateTimeOffset CreatedAt);

    /// <summary>
    /// Why an addition is refused, or null to allow it. The wording is the
    /// customer's, so it says what to do next and never names another
    /// organisation.
    /// </summary>
    public static string? RefusalToAdd(
        IReadOnlyCollection<Claim> claimsOnThisFqdn, Guid tenantId, int pendingForThisTenant)
    {
        // Someone has proved they own it. That is the ONLY thing that blocks
        // a claim now, and the message must not say who: naming them tells a
        // squatter which school they were targeting.
        if (claimsOnThisFqdn.Any(c => c.Verified && !c.Superseded))
            return "This domain is already verified by its owner on TatvaOS. "
                 + "If that is your organisation, sign in with that account. "
                 + "If you believe this is wrong, contact support — we check ownership before moving a domain.";

        // The same organisation asking twice. Not an attack; just tell them.
        if (claimsOnThisFqdn.Any(c => c.TenantId == tenantId && !c.Superseded))
            return "You have already added this domain. Open it to see the record to publish.";

        if (pendingForThisTenant >= MaxPendingPerTenant)
            return $"You have {pendingForThisTenant} domains waiting to be verified. "
                 + "Verify one of those before adding another, or contact support if you genuinely need more.";

        return null;
    }

    /// <summary>
    /// The claims that lose when <paramref name="winnerId"/> verifies: every
    /// other live claim on the same fqdn. Already-superseded rows are left
    /// alone so a second verification cannot re-stamp them with a later time.
    /// </summary>
    public static IReadOnlyList<Guid> LosersOf(IReadOnlyCollection<Claim> claimsOnThisFqdn, Guid winnerId) =>
        claimsOnThisFqdn
            .Where(c => c.Id != winnerId && !c.Superseded)
            .Select(c => c.Id)
            .ToList();

    /// <summary>
    /// Pending claims old enough to be treated as abandoned. Verified and
    /// superseded rows are never swept: one is somebody's live domain, the
    /// other is the record of why their claim ended.
    /// </summary>
    public static IReadOnlyList<Guid> Expired(IReadOnlyCollection<Claim> claims, DateTimeOffset now) =>
        claims
            .Where(c => !c.Verified && !c.Superseded && now - c.CreatedAt > PendingClaimLifetime)
            .Select(c => c.Id)
            .ToList();

    /// <summary>
    /// What a losing organisation is told. Deliberately free of any detail
    /// about the winner (Mr. Singh, 24 Sept): "naming the organisation tells
    /// one customer who their competitor's customer is, or tells a squatter
    /// which school they were targeting."
    /// </summary>
    public const string SupersededNotice =
        "This domain was verified by its owner in another organisation, so this claim is closed. "
        + "If you believe the domain is yours, contact support — we check ownership before moving a domain.";
}
