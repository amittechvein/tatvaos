using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Workers;

/// <summary>
/// The disk and the database, compared.
///
/// ─────────────────────────────────────────────────────────────────────────
///  TWO FAULTS FROM SPACE'S OWN LIST, AND THEY ARE THE SAME FAULT
///
///  SPACE_FAULT_MATRIX.md #3: a killed process runs no `catch`, so a `.part`
///  file from an interrupted upload is never removed. Nothing sweeps them.
///
///  SPACE_FAULT_MATRIX.md #1: bytes on the volume with no space.files row —
///  produced by Postgres dying between the write and the commit, by a purge
///  killed mid-subtree, or by the losing side of a concurrent overwrite. They
///  consume disk forever, are charged to nobody's quota, appear in no listing
///  and are invisible to every query.
///
///  Both are debris. Both accumulate silently on the SAME FILESYSTEM MAIL
///  WRITES TO — one box, one disk — so the eventual symptom is not "Space is
///  untidy", it is mail having nowhere to land.
///
///  Space's own observation about the pattern: "six of these eight are
///  invisible failures: the system continues, nobody is told, and the cost
///  accrues quietly. The fault we happened to build detection for is the only
///  one on this list that announces itself. That was not judgement. It was
///  the one someone asked about."
///
///  This is the answer to being asked.
///
///  ─────────────────────────────────────────────────────────────────────────
///  IT DELETES .part FILES. IT DOES NOT DELETE ORPHANED BLOBS.
///
///  That difference is the most important decision in this file.
///
///  A `.part` file is unambiguous: this class is the only thing that creates
///  one, it is never read, and one older than a few hours belongs to an
///  upload that will never finish. Deleting it loses nothing.
///
///  AN ORPHANED BLOB IS SOMEBODY'S DATA. It might be a file whose row this
///  process has not committed yet. It might be a bug in this very comparison.
///  Deleting on a heuristic risks destroying a customer's document to reclaim
///  disk, which is the wrong side of that trade by an enormous margin. So
///  orphans are REPORTED — count, bytes, and the oldest few keys — and a
///  person decides.
///
///  If the report turns out to be reliable over some months, deletion becomes
///  a conversation with evidence behind it. Today there is no evidence,
///  because until now there was no report.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class SpaceBlobSweepWorker(
    IServiceScopeFactory scopes,
    IConfiguration config,
    ILogger<SpaceBlobSweepWorker> log) : BackgroundService
{
    /// <summary>
    /// Long enough for the API to have finished starting and for any upload
    /// that was in flight across a restart to be well and truly over.
    /// </summary>
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Debris does not accrue quickly and walking the volume is not free.
    /// Four times a day is far more often than anybody needs to know.
    /// </summary>
    private static readonly TimeSpan Tick = TimeSpan.FromHours(6);

    /// <summary>
    /// A .part file younger than this may belong to an upload happening RIGHT
    /// NOW. Six hours is far beyond any upload this platform accepts — the
    /// size cap makes a legitimate one minutes at worst — and being generous
    /// costs nothing but a little disk for a little longer.
    /// </summary>
    private static readonly TimeSpan PartFileGrace = TimeSpan.FromHours(6);

    /// <summary>
    /// A blob younger than this is not reported as an orphan. An upload that
    /// wrote its bytes seconds ago and has not yet committed its row is not a
    /// leak, it is an upload; reporting it would make every busy hour look
    /// like a fault.
    /// </summary>
    private static readonly TimeSpan OrphanGrace = TimeSpan.FromHours(24);

    /// <summary>How many keys are asked about in one database round trip.</summary>
    private const int BatchSize = 500;

    /// <summary>
    /// A ceiling on how many files are examined in one pass. A volume with a
    /// million blobs should not have this worker walking all of them while
    /// the box is also carrying meetings; it reports what it saw and says it
    /// stopped early, which is honest and bounded.
    /// </summary>
    private const int MaxFilesPerPass = 200_000;

    private readonly string _root = Path.GetFullPath(
        config["Space:BlobRoot"] ?? "/var/lib/space/blobs");

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        try { await Task.Delay(StartupDelay, stopping); }
        catch (OperationCanceledException) { return; }

        log.LogInformation(
            "Space blob sweep running every {Hours}h over {Root}", Tick.TotalHours, _root);

        using var timer = new PeriodicTimer(Tick);
        do
        {
            // FIRST, and outside the Space try below — which `continue`s past
            // everything when the blob volume is missing, and would take the
            // handoff sweep with it on any box without Space.
            await SweepHandoffCodesAsync(stopping);

            try
            {
                if (!Directory.Exists(_root))
                {
                    // Not an error. A deployment without Space, or a volume
                    // not yet mounted, and neither is this worker's business.
                    log.LogInformation("Space blob root {Root} does not exist; nothing to sweep.", _root);
                    continue;
                }

                var (blobs, parts, stoppedEarly) = Scan();

                SweepPartFiles(parts);
                await ReportOrphansAsync(blobs, stopping);

                if (stoppedEarly)
                    log.LogWarning(
                        "Space blob sweep stopped at {Max} files — the volume is larger than one pass.",
                        MaxFilesPerPass);
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A sweep is housekeeping. It must never take the API with it.
                log.LogError(ex, "Space blob sweep failed; will try again next tick.");
            }
        }
        while (await SafeWaitAsync(timer, stopping));
    }

    /// <summary>
    /// Delete sign-in handoff codes more than 24 hours past expiry.
    ///
    /// NOT SPACE'S JOB, AND IT IS HERE ANYWAY. The CTO's ruling, 16 Sept 2026:
    /// put it in a worker that already wakes up rather than adding one, and
    /// this is Core's sweeper on a six-hour tick. The two share a timer and
    /// nothing else — each has its own try, so neither can stop the other.
    ///
    /// The window and the DELETE are in core.sweep_handoff_codes()
    /// (20260917-auth-handoff-sweep.sql), not here: the number lives in one
    /// place, and a caller cannot pass a smaller one. The redeem never depends
    /// on this running — an unswept expired code can only ever fail it — so a
    /// failure here is logged and nothing else.
    ///
    /// Proven by infra/scripts/verify-handoff-sweep.sh, as tatvaos_app with no
    /// tenant, which is how this call reaches the database.
    /// </summary>
    private async Task SweepHandoffCodesAsync(CancellationToken ct)
    {
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            var deleted = await db.Database
                .SqlQuery<int>($"""SELECT core.sweep_handoff_codes() AS "Value" """)
                .SingleAsync(ct);

            log.LogInformation(
                "Handoff code sweep: {Deleted} code(s) more than 24h past expiry deleted.", deleted);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Shutting down; the outer loop notices on its next wait.
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Handoff code sweep failed; will try again next tick.");
        }
    }

    private static async Task<bool> SafeWaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }

    private sealed record Blob(string Key, long Bytes, DateTimeOffset Written);

    /// <summary>
    /// Walk the volume once, sorting what is there into real blobs and
    /// abandoned `.part` files.
    ///
    /// The KEY is rebuilt from the path — tenant/yyyy/MM/uuid — which is the
    /// same shape FileSystemBlobStore.NewKey generates. Anything that does not
    /// look like that is left strictly alone: this worker deletes things, and
    /// a file it does not understand is a file it has no business touching.
    /// </summary>
    private (List<Blob> Blobs, List<FileInfo> Parts, bool StoppedEarly) Scan()
    {
        var blobs = new List<Blob>();
        var parts = new List<FileInfo>();
        var seen = 0;
        var stoppedEarly = false;

        foreach (var path in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
        {
            if (++seen > MaxFilesPerPass) { stoppedEarly = true; break; }

            FileInfo info;
            try { info = new FileInfo(path); }
            catch (IOException) { continue; }

            if (path.EndsWith(".part", StringComparison.Ordinal))
            {
                parts.Add(info);
                continue;
            }

            var key = Path.GetRelativePath(_root, path).Replace(Path.DirectorySeparatorChar, '/');

            // Four segments, exactly as NewKey produces. Anything else is not
            // ours and is not reported or touched.
            if (key.Count(c => c == '/') != 3) continue;

            blobs.Add(new Blob(key, info.Length, info.LastWriteTimeUtc));
        }

        return (blobs, parts, stoppedEarly);
    }

    private void SweepPartFiles(List<FileInfo> parts)
    {
        var cutoff = DateTimeOffset.UtcNow - PartFileGrace;
        var removed = 0;
        long bytes = 0;

        foreach (var part in parts)
        {
            if (part.LastWriteTimeUtc > cutoff) continue;   // may be live

            try
            {
                bytes += part.Length;
                part.Delete();
                removed++;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                log.LogWarning("Could not remove abandoned upload {Path}: {Reason}",
                    part.FullName, ex.Message);
            }
        }

        if (removed > 0)
            log.LogInformation(
                "Removed {Count} abandoned upload(s) totalling {Bytes} bytes. These are "
                + ".part files from uploads that were interrupted; nothing reads them.",
                removed, bytes);
    }

    /// <summary>
    /// Bytes on disk that no row points at. Reported, never deleted — see the
    /// header for why that line is where it is.
    /// </summary>
    private async Task ReportOrphansAsync(List<Blob> blobs, CancellationToken ct)
    {
        if (blobs.Count == 0) return;

        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var cutoff = DateTimeOffset.UtcNow - OrphanGrace;
        var candidates = blobs.Where(b => b.Written < cutoff).ToList();
        if (candidates.Count == 0) return;

        var known = new HashSet<string>(StringComparer.Ordinal);

        for (var i = 0; i < candidates.Count; i += BatchSize)
        {
            var batch = candidates.Skip(i).Take(BatchSize).Select(b => b.Key).ToArray();

            var present = await db.Database
                .SqlQuery<string>($"""
                    SELECT blob_key AS "Value" FROM space.blob_keys_present({batch})
                    """)
                .ToListAsync(ct);

            foreach (var key in present) known.Add(key);
        }

        var orphans = candidates.Where(b => !known.Contains(b.Key)).ToList();

        if (orphans.Count == 0)
        {
            log.LogInformation(
                "Space blob sweep: {Checked} blob(s) checked, every one has a row.",
                candidates.Count);
            return;
        }

        var wasted = orphans.Sum(o => o.Bytes);

        // WARNING, not information. Nobody is looking for this, which is the
        // entire reason it existed unnoticed — so it has to arrive at a level
        // that gets read, with the number that makes it actionable.
        log.LogWarning(
            "SPACE ORPHANED BLOBS: {Count} file(s) on disk have no database row, "
            + "wasting {Bytes} bytes. They are charged to no quota and appear in no "
            + "listing. NOT deleted — a person must confirm. Oldest: {Sample}",
            orphans.Count, wasted,
            string.Join(", ", orphans.OrderBy(o => o.Written).Take(5).Select(o => o.Key)));
    }
}
