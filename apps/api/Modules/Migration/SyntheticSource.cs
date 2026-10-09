using System.Collections.Concurrent;
using System.Globalization;

namespace TatvaOS.Api.Modules.Migration;

/// <summary>
/// A fake Google that produces numbered items, so the runner's resume, dedupe
/// and retry can be proven with nothing outside the machine.
///
/// ─────────────────────────────────────────────────────────────────────────
///  DEVELOPMENT ONLY. Registered for every data type, but the runner refuses
///  a 'synthetic' job outside Development and marks it failed with a reason,
///  so a stray row on production does nothing but say why.
///
///  ITS ITEMS. Item n (1-based, up to the job's items_total) has source id
///  "syn-n". Every tenth item carries the SAME dedupe key as the item before
///  it - "syn-10" is a duplicate of "syn-9" - which is the shape of a Gmail
///  message reached twice, and must arrive once (design section 5). So a job
///  of 500 items ends with 450 done and 50 skipped, and those two numbers are
///  what tests/migration/test-job-runner.sh asserts.
///
///  ITS CURSOR is the number of the last item on the page, as text.
///
///  KNOBS, all under Migration:Synthetic:
///    PageSize        items per page (default 25)
///    DelayMs         per item written, so a test can kill a run half-way
///    FailOnceAtItem  WriteAsync throws on this item number, once per process
///                    per job: the retry path, which must not lose or repeat
///                    an item, and the redaction of last_error
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class SyntheticSource(string dataType, IConfiguration config) : IMigrationSource
{
    public string Source => "synthetic";
    public string DataType => dataType;

    // "Once per process": the item numbers this process has already failed on.
    private static readonly ConcurrentDictionary<(Guid, long), bool> FailedOnce = new();

    private int PageSize => Math.Clamp(config.GetValue("Migration:Synthetic:PageSize", 25), 1, 1000);
    private int DelayMs => Math.Clamp(config.GetValue("Migration:Synthetic:DelayMs", 0), 0, 10_000);
    private long FailOnceAtItem => config.GetValue("Migration:Synthetic:FailOnceAtItem", 0L);

    public Task<MigrationPage> FetchAsync(MigrationJobView job, CancellationToken ct)
    {
        var total = job.ItemsTotal ?? 0;
        var after = long.TryParse(job.Cursor, NumberStyles.None, CultureInfo.InvariantCulture, out var c) ? c : 0;

        var items = new List<MigrationSourceItem>();
        for (var n = after + 1; n <= total && items.Count < PageSize; n++)
            items.Add(new MigrationSourceItem($"syn-{n}", DedupeKeyOf(n), n));

        var last = after + items.Count;
        return Task.FromResult(new MigrationPage(
            items,
            NextCursor: last.ToString(CultureInfo.InvariantCulture),
            IsLast: last >= total,
            ItemsTotal: total));
    }

    public async Task<MigrationWriteResult> WriteAsync(MigrationJobView job, MigrationSourceItem item, CancellationToken ct)
    {
        var n = (long)item.Payload!;
        if (DelayMs > 0) await Task.Delay(DelayMs, ct);

        // The message carries a PEM-shaped canary (not a key: "MIGRATIONCANARY"
        // is not base64 of anything). The test asserts it never reaches
        // migration.jobs.last_error - the redaction in MigrationJobRunner.Describe.
        if (n == FailOnceAtItem && FailedOnce.TryAdd((job.Id, n), true))
            throw new InvalidOperationException(
                $"synthetic failure at item {n} (Migration:Synthetic:FailOnceAtItem) " +
                "-----BEGIN TEST CANARY-----MIGRATIONCANARYMIGRATIONCANARYMIGRATIONCANARY-----END TEST CANARY-----");

        return MigrationWriteResult.Done(1000);
    }

    /// <summary>Every tenth item is a duplicate of the one before it.</summary>
    private static string DedupeKeyOf(long n) =>
        $"<{(n % 10 == 0 ? n - 1 : n)}@synthetic.invalid>";
}
