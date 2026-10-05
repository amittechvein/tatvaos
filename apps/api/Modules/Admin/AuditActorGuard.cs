namespace TatvaOS.Api.Modules.Admin;

/// <summary>
/// Whether an audit line may be written under the actor it was given. Its own
/// file, with nothing but this decision in it, so tests/audit-actor/gates can
/// compile it and ask it every question (AuditWriter itself needs a database).
///
/// AN OPERATOR'S ACTION MUST NAME THE OPERATOR. For weeks it did not: the
/// operator endpoints read the person's id from a claim the JWT handler had
/// renamed, got Guid.Empty, and every platform:… line was written under an
/// all-zero actor (see Shared/Auth/SignedIn.cs). An audit line naming nobody
/// is worse than none, because it looks like one. So a signed-in person
/// acting in platform scope with no id is refused, loudly, and the request
/// fails (Mr. Singh, 29 Sept 2026).
///
/// The platform acting with NO person signed in (a sign-up, a personal
/// account joining, the first operator being made) has nobody to name and is
/// not refused.
/// </summary>
public static class AuditActorGuard
{
    /// <summary>Null when the line may be written; otherwise why not.</summary>
    public static string? Refusal(bool platformScope, bool signedIn, Guid? actor, string action)
    {
        if (!platformScope || !signedIn) return null;
        if (actor is Guid id && id != Guid.Empty) return null;
        return $"Refusing to write the audit line '{action}': a signed-in operator is acting in " +
               "platform scope and the line would name nobody. EnterPlatformScope was given " +
               "Guid.Empty — read the operator with SignedIn.UserIdOrEmpty(http).";
    }
}
