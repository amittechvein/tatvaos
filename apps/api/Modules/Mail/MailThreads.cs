using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// Works out which conversation a message belongs to.
///
/// ─────────────────────────────────────────────────────────────────────────
///  HEADERS ONLY — NOT SUBJECT MATCHING.
///
///  mail.messages has carried a thread_id column since the first schema and
///  nothing ever set it, so every message was its own conversation.
///
///  Threading here follows In-Reply-To and References, which is what those
///  headers are for. The tempting shortcut — also grouping by matching
///  subject — is what makes other clients merge two strangers who both wrote
///  "Re: invoice" into one thread, and in a shared mailbox that shows one
///  customer another customer's reply. A missed thread is a small annoyance;
///  a wrongly merged one is a disclosure.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailThreads
{
    /// <summary>
    /// Message-Id values travel wrapped in angle brackets on the wire, and
    /// MimeKit hands them back either way depending on the header. Everything
    /// stored and compared here is bare, so one form cannot miss the other.
    /// </summary>
    private static string Normalise(string id) => id.Trim().Trim('<', '>');

    /// <summary>
    /// The conversation this message joins, or a fresh one if it starts a
    /// conversation.
    /// </summary>
    /// <param name="pending">
    /// Message-Id to thread for messages added in the current batch but not yet
    /// saved. Without this, a reply that arrives in the same ingest sweep as the
    /// message it answers cannot see its parent — the parent is still only in
    /// the change tracker — and the two would split into separate threads.
    /// </param>
    public static async Task<Guid> ResolveAsync(
        AppDbContext db,
        Guid mailboxId,
        MimeMessage mime,
        IReadOnlyDictionary<string, Guid> pending,
        CancellationToken ct)
    {
        // In-Reply-To is the direct parent; References is the ancestry, most
        // distant first. Checking the direct parent first keeps a reply with
        // the branch it actually answers.
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(mime.InReplyTo))
            candidates.Add(Normalise(mime.InReplyTo));
        foreach (var r in mime.References)
            candidates.Add(Normalise(r));

        if (candidates.Count == 0) return Guid.NewGuid();

        foreach (var id in candidates)
            if (pending.TryGetValue(id, out var known)) return known;

        // Tracked, not AsNoTracking: an ancestor from before threading existed
        // has no thread of its own, and the fix is to give it this one rather
        // than leave the pair permanently split.
        var parent = await db.Messages
            .Where(m => m.MailboxId == mailboxId
                        && m.MessageIdHeader != null
                        && candidates.Contains(m.MessageIdHeader))
            .OrderByDescending(m => m.ReceivedAt)
            .FirstOrDefaultAsync(ct);

        if (parent is null) return Guid.NewGuid();

        if (parent.ThreadId is Guid existing) return existing;

        var thread = Guid.NewGuid();
        parent.ThreadId = thread;
        return thread;
    }
}
