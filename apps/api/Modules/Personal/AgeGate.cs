namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// The age step (build plan §3.3, decision D7: adults only at launch, unless
/// the lawyer's answer changes it).
///
/// Built so that answer is a change HERE and nowhere else: Decide returns a
/// verdict, not a bool, and a future NeedsParentalConsent verdict slots in
/// beside Minor without the endpoint's shape changing. The date of birth is
/// used for this one calculation and NEVER stored — the account keeps only
/// the time the declaration was made (personal_accounts.adult_declared_at).
///
/// Ages are counted in India time: the day someone turns 18 is their
/// birthday in Mumbai, not in UTC, which for a signup just after midnight
/// IST is still the day before.
/// </summary>
public static class AgeGate
{
    public const int AdultAge = 18;

    public enum Verdict { Adult, Minor, Invalid }

    public const string MinorMessage =
        "TatvaOS personal accounts are for adults. If your school uses TatvaOS, ask it for a school account.";

    public const string NotDeclaredMessage =
        "Please confirm you are 18 or older, and enter your date of birth.";

    private static readonly TimeZoneInfo India = FindIndia();

    public static Verdict Decide(bool declaredAdult, DateOnly? dateOfBirth, DateTimeOffset now)
    {
        if (dateOfBirth is not DateOnly dob) return Verdict.Invalid;
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, India).DateTime);
        if (dob > today || dob.Year < today.Year - 120) return Verdict.Invalid;

        var age = today.Year - dob.Year;
        if (dob > today.AddYears(-age)) age--;

        if (age < AdultAge) return Verdict.Minor;
        // The date says adult; the tick box must say so too. Both, because
        // the declaration is what the terms rely on, and the date is what
        // catches the reflexive tick.
        return declaredAdult ? Verdict.Adult : Verdict.Invalid;
    }

    private static TimeZoneInfo FindIndia()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata"); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.FindSystemTimeZoneById("India Standard Time"); }
    }
}
