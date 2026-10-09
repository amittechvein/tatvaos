using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Migration;

/// <summary>
/// Runs migration jobs for ONE organisation: claims a ready job, takes it a
/// page at a time, and records each page and its cursor together.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE ORDER OF ONE PAGE, and why each step is where it is:
///
///   1. FETCH the page after the job's cursor (the source, reads only).
///   2. DROP every item the ledger already has. A resumed job re-reads the
///      page it was killed on; these are the ones it finished.
///   3. DEDUPE by key: an item whose dedupe key (Message-ID) was already
///      written in this job, or earlier on this page, is recorded 'skipped'
///      and NOT written. Design section 5: a message with three labels must
///      arrive once, not three times.
///   4. WRITE the rest (the source, writes the destination).
///   5. RECORD, in ONE transaction: the items, the counts (from the rows
///      actually inserted, never from what we meant to insert), the new
///      cursor, a renewed lease - and 'completed' if the page was the last.
///
///  Killed anywhere before 5 commits, the job still says what it said after
///  the previous page, and the lease runs out so it can be claimed again.
///  Killed after 5, the next page starts from the new cursor. There is no
///  point in between, which is the whole design.
///
///  THE LEASE IS CHECKED AT EVERY RECORD. If this runner stalled past its
///  lease and another claimed the job, step 5 finds the job no longer ours,
///  rolls back, and stops: two runners must never both advance one cursor.
///  Cancelling a job (state 'cancelled') clears the lease, so a running job
///  is stopped the same way, at its next page.
///
///  ERRORS. An exception from the source fails the PAGE, not the item: the
///  job goes back to 'pending' with a backoff and the page is retried whole
///  (steps 2 and 3 make that safe). After Migration:MaxAttempts failures in
///  a row it is 'failed', with the last error. A source that knows one item
///  is hopeless returns MigrationWriteResult.Failed for it instead, and the
///  job goes on.
///
///  last_error IS WRITTEN FROM THE EXCEPTION'S TYPE AND MESSAGE ONLY, never
///  its stack or inner data, cut to 500 characters, with anything shaped like
///  a key or token blanked (Describe). Design section 9: Amit forwards whole
///  screens and transcripts, and a credential in an error message is a
///  credential that must be revoked.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class MigrationJobRunner(
    AppDbContext db,
    IEnumerable<IMigrationSource> sources,
    IConfiguration config,
    IHostEnvironment env,
    ILogger<MigrationJobRunner> log)
{
    private TimeSpan Lease => TimeSpan.FromSeconds(Math.Clamp(config.GetValue("Migration:LeaseSeconds", 120), 5, 3600));
    private TimeSpan Slice => TimeSpan.FromSeconds(Math.Clamp(config.GetValue("Migration:SliceSeconds", 300), 5, 3600));
    private int MaxAttempts => Math.Clamp(config.GetValue("Migration:MaxAttempts", 8), 1, 100);

    /// <summary>
    /// Claim and run jobs in the organisation this scope is in, until none is
    /// ready or the slice is used up. The caller has entered the organisation
    /// (EnterAnonymousScope + SyncTenantAsync); everything here runs under RLS.
    /// Returns how many jobs it worked on.
    /// </summary>
    public async Task<int> RunOrganisationAsync(string owner, CancellationToken stopping)
    {
        var worked = 0;
        var sliceEnds = DateTimeOffset.UtcNow + Slice;
        while (!stopping.IsCancellationRequested && DateTimeOffset.UtcNow < sliceEnds)
        {
            var job = await ClaimAsync(owner, stopping);
            if (job is null) break;
            worked++;
            await RunJobAsync(job, owner, sliceEnds, stopping);
        }
        return worked;
    }

    private async Task RunJobAsync(MigrationJobView job, string owner, DateTimeOffset sliceEnds, CancellationToken stopping)
    {
        log.LogInformation(
            "Migration job {JobId} claimed ({Source}/{DataType}): {Done} item(s) recorded before, {How}",
            job.Id, job.Source, job.DataType, job.ItemsDone,
            job.Cursor is null ? "starting from the beginning" : "resuming from its cursor");

        if (job.Source == "synthetic" && !env.IsDevelopment())
        {
            await FinishFailedAsync(job.Id, owner,
                "source 'synthetic' runs only in Development; this job cannot run here");
            return;
        }

        var source = sources.FirstOrDefault(s => s.Source == job.Source && s.DataType == job.DataType);
        if (source is null)
        {
            // Not a failure of the job: this build cannot run it yet. Back to
            // pending for an hour, attempts untouched, saying why - a deploy
            // that adds the source picks it up without anyone re-queueing it.
            await ReleaseAsync(job.Id, owner, TimeSpan.FromHours(1),
                $"no source for {job.Source}/{job.DataType} in this build");
            return;
        }

        try
        {
            while (true)
            {
                var (recorded, next) = await RunPageAsync(source, job, owner, stopping);
                if (!recorded)
                {
                    log.LogWarning("Migration job {JobId}: no longer ours (lease lost or cancelled); stopped", job.Id);
                    return;
                }
                if (next is null) return;          // completed
                job = next;

                if (stopping.IsCancellationRequested || DateTimeOffset.UtcNow >= sliceEnds)
                {
                    // Hand it back ready to run at once, rather than leaving
                    // the next runner to wait out the lease.
                    await ReleaseAsync(job.Id, owner, TimeSpan.Zero, null);
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            // Shutting down mid-page: the page is not recorded, so it is done
            // again on resume. Release so that is immediate.
            await ReleaseAsync(job.Id, owner, TimeSpan.Zero, null);
        }
        catch (Exception ex)
        {
            var error = Describe(ex);
            log.LogWarning("Migration job {JobId}: page failed: {Error}", job.Id, error);
            await RecordFailureAsync(job.Id, owner, error);
        }
    }

    /// <summary>Steps 1-5 for one page. Returns (still ours, the job after it - null once completed).</summary>
    private async Task<(bool Recorded, MigrationJobView? Next)> RunPageAsync(
        IMigrationSource source, MigrationJobView job, string owner, CancellationToken ct)
    {
        // 1. Fetch.
        var page = await source.FetchAsync(job, ct);
        if (page.Items.Count == 0 && !page.IsLast && page.NextCursor == job.Cursor)
            throw new InvalidOperationException("the source returned an empty page without moving its cursor");

        // 2. Drop what the ledger already has.
        var ids = page.Items.Select(i => i.SourceId).Distinct().ToArray();
        var known = (await QueryStringsAsync(
            "SELECT source_id FROM migration.items WHERE job_id = @job AND source_id = ANY(@ids)",
            ct, ("job", job.Id), ("ids", ids))).ToHashSet(StringComparer.Ordinal);

        // 3. Dedupe by key, against the job's written items and this page.
        var keys = page.Items.Where(i => i.DedupeKey is not null).Select(i => i.DedupeKey!).Distinct().ToArray();
        var writtenUnder = new Dictionary<string, string>(StringComparer.Ordinal);
        if (keys.Length > 0)
        {
            foreach (var (key, id) in await QueryPairsAsync(
                         "SELECT dedupe_key, min(source_id) FROM migration.items " +
                         "WHERE job_id = @job AND outcome = 'done' AND dedupe_key = ANY(@keys) GROUP BY dedupe_key",
                         ct, ("job", job.Id), ("keys", keys)))
                writtenUnder[key] = id;
        }

        // 4. Write.
        var rows = new List<(MigrationSourceItem Item, MigrationWriteResult Result)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in page.Items)
        {
            if (known.Contains(item.SourceId) || !seen.Add(item.SourceId)) continue;

            if (item.DedupeKey is not null && writtenUnder.TryGetValue(item.DedupeKey, out var first))
            {
                rows.Add((item, MigrationWriteResult.Skipped($"duplicate of {first}")));
                continue;
            }

            var result = await source.WriteAsync(job, item, ct);
            rows.Add((item, result));
            if (result.Outcome == "done" && item.DedupeKey is not null)
                writtenUnder[item.DedupeKey] = item.SourceId;
        }

        // 5. Record.
        return await RecordPageAsync(job, owner, page, rows, ct);
    }

    private async Task<(bool, MigrationJobView?)> RecordPageAsync(
        MigrationJobView job, string owner, MigrationPage page,
        List<(MigrationSourceItem Item, MigrationWriteResult Result)> rows, CancellationToken ct)
    {
        // Not cancellable: once the destination has been written, recording
        // it is cheaper than redoing it.
        var conn = await OpenAsync(CancellationToken.None);
        await using var tx = await conn.BeginTransactionAsync(CancellationToken.None);

        await using (var mine = Cmd(conn, tx,
            "SELECT 1 FROM migration.jobs WHERE id = @job AND state = 'running' AND lease_owner = @owner FOR UPDATE",
            ("job", job.Id), ("owner", owner)))
        {
            if (await mine.ExecuteScalarAsync(CancellationToken.None) is null)
            {
                await tx.RollbackAsync(CancellationToken.None);
                return (false, null);
            }
        }

        // The counts come from RETURNING: rows actually inserted. A row the
        // ledger already had (ON CONFLICT) adds nothing, so a page recorded
        // twice cannot count twice.
        await using var record = Cmd(conn, tx, """
            WITH ins AS (
                INSERT INTO migration.items (tenant_id, job_id, source_id, dedupe_key, outcome, reason, bytes)
                SELECT @tenant, @job, s, k, o, r, b
                  FROM unnest(@sids, @keys, @outcomes, @reasons, @bytes) AS u(s, k, o, r, b)
                ON CONFLICT (job_id, source_id) DO NOTHING
                RETURNING outcome, bytes
            )
            UPDATE migration.jobs j SET
                items_done    = j.items_done    + (SELECT count(*) FROM ins WHERE outcome = 'done'),
                items_skipped = j.items_skipped + (SELECT count(*) FROM ins WHERE outcome = 'skipped'),
                items_failed  = j.items_failed  + (SELECT count(*) FROM ins WHERE outcome = 'failed'),
                bytes_done    = j.bytes_done    + (SELECT coalesce(sum(bytes), 0) FROM ins),
                cursor        = @cursor,
                items_total   = coalesce(@total, j.items_total),
                attempts      = 0,
                last_error    = NULL,
                updated_at    = now(),
                state            = CASE WHEN @last THEN 'completed' ELSE 'running' END,
                finished_at      = CASE WHEN @last THEN now() END,
                lease_owner      = CASE WHEN @last THEN NULL ELSE j.lease_owner END,
                lease_expires_at = CASE WHEN @last THEN NULL ELSE now() + @lease END
             WHERE j.id = @job
            RETURNING j.cursor, j.items_total, j.items_done
            """,
            ("tenant", job.TenantId), ("job", job.Id),
            ("sids", rows.Select(r => r.Item.SourceId).ToArray()),
            ("keys", rows.Select(r => r.Item.DedupeKey).ToArray()),
            ("outcomes", rows.Select(r => r.Result.Outcome).ToArray()),
            ("reasons", rows.Select(r => Clip(r.Result.Reason, 500)).ToArray()),
            ("bytes", rows.Select(r => r.Result.Bytes).ToArray()),
            ("cursor", (object?)page.NextCursor ?? DBNull.Value),
            ("total", page.ItemsTotal is long t ? t : DBNull.Value),
            ("last", page.IsLast),
            ("lease", Lease));
        // Npgsql cannot infer an element type from an all-null array.
        record.Parameters["keys"].NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text;
        record.Parameters["reasons"].NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text;

        string? cursor; long? total; long done;
        await using (var reader = await record.ExecuteReaderAsync(CancellationToken.None))
        {
            await reader.ReadAsync(CancellationToken.None);
            cursor = reader.IsDBNull(0) ? null : reader.GetString(0);
            total = reader.IsDBNull(1) ? null : reader.GetInt64(1);
            done = reader.GetInt64(2);
        }
        await tx.CommitAsync(CancellationToken.None);

        if (page.IsLast)
        {
            log.LogInformation("Migration job {JobId} completed: {Done} item(s) written", job.Id, done);
            return (true, null);
        }
        return (true, job with { Cursor = cursor, ItemsTotal = total, ItemsDone = done });
    }

    // ── The claim ───────────────────────────────────────────────────────────
    //
    //  One statement. The inner SELECT picks the oldest ready job and locks it
    //  (SKIP LOCKED: two runners never wait on each other, they take different
    //  jobs); the outer WHERE repeats the readiness test because, under READ
    //  COMMITTED, an UPDATE re-checks only its own WHERE after waiting for a
    //  row. Ready = pending and due, or running with a lease that has run out
    //  (its runner died). Never a job with no target person.
    private async Task<MigrationJobView?> ClaimAsync(string owner, CancellationToken ct)
    {
        const string ready = """
            target_user_id IS NOT NULL
            AND (   (state = 'pending' AND next_attempt_at <= now())
                 OR (state = 'running' AND lease_expires_at <  now()))
            """;
        var conn = await OpenAsync(ct);
        await using var cmd = Cmd(conn, null, $"""
            UPDATE migration.jobs SET
                state = 'running',
                lease_owner = @owner,
                lease_expires_at = now() + @lease,
                started_at = coalesce(started_at, now()),
                updated_at = now()
             WHERE id = (SELECT id FROM migration.jobs
                          WHERE {ready}
                          ORDER BY next_attempt_at, created_at
                          LIMIT 1
                          FOR UPDATE SKIP LOCKED)
               AND {ready}
            RETURNING id, tenant_id, source, data_type, source_user, target_user_id, cursor, items_total, items_done
            """,
            ("owner", owner), ("lease", Lease));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return new MigrationJobView(
            r.GetGuid(0), r.GetGuid(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetGuid(5),
            r.IsDBNull(6) ? null : r.GetString(6),
            r.IsDBNull(7) ? null : r.GetInt64(7),
            r.GetInt64(8));
    }

    // ── Handing a job back ──────────────────────────────────────────────────
    //  Every one of these is guarded by "still ours", so a runner that lost its
    //  lease can never overwrite the state the new holder has written.

    private Task ReleaseAsync(Guid jobId, string owner, TimeSpan after, string? note) =>
        ExecGuardedAsync(jobId, owner, """
            UPDATE migration.jobs SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
                   next_attempt_at = now() + @after, last_error = coalesce(@note, last_error), updated_at = now()
             WHERE id = @job AND state = 'running' AND lease_owner = @owner
            """, ("after", after), ("note", (object?)note ?? DBNull.Value));

    private Task RecordFailureAsync(Guid jobId, string owner, string error) =>
        // Backoff: 30 s, 1 min, 2 min ... capped at an hour.
        ExecGuardedAsync(jobId, owner, """
            UPDATE migration.jobs SET
                attempts = attempts + 1,
                last_error = @error,
                lease_owner = NULL, lease_expires_at = NULL,
                state       = CASE WHEN attempts + 1 >= @max THEN 'failed' ELSE 'pending' END,
                finished_at = CASE WHEN attempts + 1 >= @max THEN now() END,
                next_attempt_at = now() + least(interval '30 seconds' * power(2, attempts), interval '1 hour'),
                updated_at = now()
             WHERE id = @job AND state = 'running' AND lease_owner = @owner
            """, ("error", error), ("max", MaxAttempts));

    private Task FinishFailedAsync(Guid jobId, string owner, string error) =>
        ExecGuardedAsync(jobId, owner, """
            UPDATE migration.jobs SET state = 'failed', finished_at = now(), last_error = @error,
                   lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
             WHERE id = @job AND state = 'running' AND lease_owner = @owner
            """, ("error", error));

    private async Task ExecGuardedAsync(Guid jobId, string owner, string sql, params (string, object)[] more)
    {
        try
        {
            var conn = await OpenAsync(CancellationToken.None);
            await using var cmd = Cmd(conn, null, sql, [("job", jobId), ("owner", owner), .. more]);
            await cmd.ExecuteNonQueryAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            // The lease runs out on its own; say so rather than throw from a
            // catch block and lose the original error.
            log.LogError("Migration job {JobId}: could not hand back ({Error}); its lease will expire", jobId, Describe(ex));
        }
    }

    // ── Plumbing ────────────────────────────────────────────────────────────

    private async Task<NpgsqlConnection> OpenAsync(CancellationToken ct)
    {
        // Held open for the scope: app.tenant_id is a session setting, set by
        // the interceptor on open and re-applied by SyncTenantAsync.
        if (db.Database.GetDbConnection().State != System.Data.ConnectionState.Open)
        {
            await db.Database.OpenConnectionAsync(ct);
            await db.SyncTenantAsync(ct);
        }
        return (NpgsqlConnection)db.Database.GetDbConnection();
    }

    private static NpgsqlCommand Cmd(NpgsqlConnection conn, NpgsqlTransaction? tx, string sql, params (string Name, object? Value)[] ps)
    {
        var cmd = new NpgsqlCommand(sql, conn, tx);
        foreach (var (name, value) in ps) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return cmd;
    }

    private async Task<List<string>> QueryStringsAsync(string sql, CancellationToken ct, params (string, object?)[] ps)
    {
        var conn = await OpenAsync(ct);
        await using var cmd = Cmd(conn, null, sql, ps);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<string>();
        while (await r.ReadAsync(ct)) list.Add(r.GetString(0));
        return list;
    }

    private async Task<List<(string, string)>> QueryPairsAsync(string sql, CancellationToken ct, params (string, object?)[] ps)
    {
        var conn = await OpenAsync(ct);
        await using var cmd = Cmd(conn, null, sql, ps);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<(string, string)>();
        while (await r.ReadAsync(ct)) list.Add((r.GetString(0), r.GetString(1)));
        return list;
    }

    private static string? Clip(string? s, int max) => s is null || s.Length <= max ? s : s[..max];

    // A PEM block, a JWT, or any long unbroken run of key-ish characters.
    private static readonly Regex Secretish = new(
        @"-----BEGIN[^-]*-----.*?(-----END[^-]*-----|$)|eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*|[A-Za-z0-9+/=_\-]{40,}",
        RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>
    /// What may be stored and logged about an exception: its type and message,
    /// key-shaped runs blanked, 500 characters at most. Never the stack, never
    /// inner data. tests/migration/test-job-runner.sh checks a PEM block thrown
    /// by the synthetic source does not reach migration.jobs.last_error.
    /// </summary>
    internal static string Describe(Exception ex) =>
        Clip($"{ex.GetType().Name}: {Secretish.Replace(ex.Message, "[redacted]")}", 500)!;
}
