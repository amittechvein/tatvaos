namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// The scopes TatvaOS may ask Google for. ALL READ-ONLY, and enforced here
/// rather than promised in a document: GoogleTokenSource refuses any scope not
/// in <see cref="Allowed"/> before it signs anything.
///
/// Migration design, section 2: "Ask for nothing writable - we never need to
/// change anything in their Google account, and a read-only grant is a far
/// easier conversation with a customer's IT person." These are also exactly
/// the scopes the customer's admin is told to paste into the Admin console
/// when granting domain-wide delegation, so one list serves both.
///
/// Adding a scope here is a change to what we ask every customer to grant.
/// It is a review, not an edit.
/// </summary>
public static class GoogleScopes
{
    public const string GmailReadOnly    = "https://www.googleapis.com/auth/gmail.readonly";
    public const string CalendarReadOnly = "https://www.googleapis.com/auth/calendar.readonly";
    public const string ContactsReadOnly = "https://www.googleapis.com/auth/contacts.readonly";
    public const string DriveReadOnly    = "https://www.googleapis.com/auth/drive.readonly";
    /// <summary>To list the people in the customer's domain, to know whom to migrate.</summary>
    public const string DirectoryUsersReadOnly = "https://www.googleapis.com/auth/admin.directory.user.readonly";

    public static readonly IReadOnlySet<string> Allowed = new HashSet<string>(StringComparer.Ordinal)
    {
        GmailReadOnly, CalendarReadOnly, ContactsReadOnly, DriveReadOnly, DirectoryUsersReadOnly,
    };
}
