namespace TatvaOS.Api.Modules.Migration;

// ============================================================================
//  ONE DATA TYPE FROM ONE SOURCE - what the job runner asks of it
// ============================================================================
//
//  The runner (MigrationJobRunner) owns everything that is the same for every
//  type: claiming a job, the lease, the items ledger, the counts, retries and
//  the cursor. A source owns only the two things that differ:
//
//    FetchAsync   the next page of items after a cursor, and the cursor that
//                 follows it. Reads the SOURCE. Writes nothing.
//    WriteAsync   put one item into TatvaOS. Writes the DESTINATION.
//
//  THE CONTRACT THAT MAKES RESUMING SAFE. The runner records a page's items
//  and its new cursor in one transaction, AFTER WriteAsync has run for every
//  item on the page. A process killed between the two leaves the old cursor,
//  so the same page is fetched and written again on resume. Therefore:
//
//    * FetchAsync from the same cursor must return the same items (or a
//      superset - a mailbox can grow while it is being migrated).
//    * WriteAsync must be safe to repeat for an item it already wrote. For
//      mail that means looking for the Message-ID in the destination folder
//      before APPEND; for Drive, the file's Google id on the Space row.
//
//  The ledger catches every repeat the runner can see (an item already
//  recorded is never written again); the rule above covers the one it cannot,
//  the page in flight when the process died.
// ============================================================================

public interface IMigrationSource
{
    /// <summary>'google_workspace' or 'synthetic' - migration.jobs.source.</summary>
    string Source { get; }
    /// <summary>'mail', 'contacts', 'calendar' or 'drive' - migration.jobs.data_type.</summary>
    string DataType { get; }

    Task<MigrationPage> FetchAsync(MigrationJobView job, CancellationToken ct);

    Task<MigrationWriteResult> WriteAsync(MigrationJobView job, MigrationSourceItem item, CancellationToken ct);
}

/// <summary>What a source is told about the job. No credentials: it gets those itself.</summary>
public sealed record MigrationJobView(
    Guid Id,
    Guid TenantId,
    string Source,
    string DataType,
    string SourceUser,
    Guid TargetUserId,
    string? Cursor,
    long? ItemsTotal,
    long ItemsDone);

/// <param name="SourceId">The source's id for the item. Unique within the job.</param>
/// <param name="DedupeKey">What makes two different source items one thing here (Message-ID).</param>
/// <param name="Payload">Whatever the source's own WriteAsync needs. The runner never looks.</param>
public sealed record MigrationSourceItem(string SourceId, string? DedupeKey, object? Payload = null);

/// <param name="NextCursor">The cursor after this page. Stored only once the page is recorded.</param>
/// <param name="IsLast">No more items after this page: the job completes when it is recorded.</param>
/// <param name="ItemsTotal">The source's estimate of the whole job, if it has one.</param>
public sealed record MigrationPage(
    IReadOnlyList<MigrationSourceItem> Items,
    string? NextCursor,
    bool IsLast,
    long? ItemsTotal = null);

/// <param name="Outcome">'done', 'skipped' or 'failed' - migration.items.outcome.</param>
/// <param name="Reason">Why skipped or failed. Short, and never carrying a credential.</param>
public sealed record MigrationWriteResult(string Outcome, long Bytes = 0, string? Reason = null)
{
    public static MigrationWriteResult Done(long bytes) => new("done", bytes);
    public static MigrationWriteResult Skipped(string reason) => new("skipped", 0, reason);
    public static MigrationWriteResult Failed(string reason) => new("failed", 0, reason);
}
