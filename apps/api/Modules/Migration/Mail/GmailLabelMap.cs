namespace TatvaOS.Api.Modules.Migration.Mail;

/// <summary>
/// Where a Gmail message goes in our Dovecot, from its labels (migration
/// design, section 5).
///
/// ─────────────────────────────────────────────────────────────────────────
///  Gmail has LABELS, not folders. One message with three labels is one
///  message in three places, and "All Mail" holds everything again. So:
///
///   * system labels with an IMAP meaning become those folders:
///       INBOX -> INBOX, SENT -> Sent, DRAFT -> Drafts, SPAM -> Junk,
///       TRASH -> Trash  (the special-use folders local/dovecot/dovecot.conf
///       already creates)
///   * system labels that are STATE, not place, become FLAGS:
///       STARRED -> \Flagged; UNREAD absent -> \Seen; DRAFT -> \Draft
///   * the rest are not folders and are dropped: IMPORTANT, CHAT, and every
///     CATEGORY_* (Promotions, Social ...) - Gmail's tabs over the inbox,
///     which the INBOX label already places
///   * USER labels become folders. "Clients/Acme" nests, because Dovecot's
///     separator is "/" too, exactly as Gmail draws it
///   * a message with NO folder label was ARCHIVED in Gmail - it lives only
///     in All Mail. It goes to "Archive" rather than being lost or put back
///     in the inbox.
///
///  ONE COPY, SEVERAL FOLDERS. The first folder (in the order below) gets the
///  APPEND; the others get an IMAP COPY of it. Dovecot hardlinks a copy
///  within one mail store, so the disk holds the bytes once.
///  KNOWN, NOT SOLVED HERE: MaildirIngestWorker indexes each folder's copy as
///  its own mail.messages row, so webmail will show it in each folder and
///  the database holds it per folder. Section 5's "one message the user can
///  find in three places" holds for IMAP; for webmail it is a question for
///  Mr. Singh, alongside 7.1.
///
///  Spam and Trash win: a message labelled TRASH goes to Trash and nowhere
///  else, whatever else it carries - Gmail hides it everywhere else too.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class GmailLabelMap
{
    public const string Archive = "Archive";

    private static readonly Dictionary<string, string> SystemFolders = new(StringComparer.Ordinal)
    {
        ["INBOX"] = "INBOX", ["SENT"] = "Sent", ["DRAFT"] = "Drafts", ["SPAM"] = "Junk", ["TRASH"] = "Trash",
    };

    /// <param name="labelIds">The message's labelIds as Gmail returns them.</param>
    /// <param name="userLabelNames">Gmail label id -> its name, for the person's USER labels.</param>
    public static GmailPlacement Place(IReadOnlyCollection<string> labelIds, IReadOnlyDictionary<string, string> userLabelNames)
    {
        var flags = new List<string>();
        if (!labelIds.Contains("UNREAD")) flags.Add(@"\Seen");
        if (labelIds.Contains("STARRED")) flags.Add(@"\Flagged");
        if (labelIds.Contains("DRAFT")) flags.Add(@"\Draft");

        if (labelIds.Contains("TRASH")) return new(["Trash"], flags);
        if (labelIds.Contains("SPAM")) return new(["Junk"], flags);

        var folders = new List<string>();
        // System folders first, in a fixed order, so a message's APPEND
        // target does not depend on the order Gmail listed its labels.
        foreach (var sys in new[] { "INBOX", "SENT", "DRAFT" })
            if (labelIds.Contains(sys)) folders.Add(SystemFolders[sys]);
        foreach (var id in labelIds.Where(l => userLabelNames.ContainsKey(l)).Order(StringComparer.Ordinal))
            if (FolderName(userLabelNames[id]) is { } f && !folders.Contains(f, StringComparer.Ordinal)) folders.Add(f);

        if (folders.Count == 0) folders.Add(Archive);
        return new(folders, flags);
    }

    /// <summary>
    /// A user label's name as a folder. Null for a name that cannot be one.
    /// Gmail allows names IMAP would choke on: empty path parts ("a//b"),
    /// leading/trailing slashes, and names that collide with our special
    /// folders. Those are kept, but moved under "Labels/".
    /// </summary>
    public static string? FolderName(string label)
    {
        var parts = label.Split('/').Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
        if (parts.Count == 0) return null;
        var name = string.Join('/', parts);
        var reserved = SystemFolders.Values.Append(Archive)
            .Any(r => string.Equals(r, parts[0], StringComparison.OrdinalIgnoreCase));
        return reserved ? $"Labels/{name}" : name;
    }
}

/// <param name="Folders">Where the message goes; the first one gets the APPEND, the rest a COPY.</param>
/// <param name="Flags">IMAP flags to set on it.</param>
public sealed record GmailPlacement(IReadOnlyList<string> Folders, IReadOnlyList<string> Flags);
