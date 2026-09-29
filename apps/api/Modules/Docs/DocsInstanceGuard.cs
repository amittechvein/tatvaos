using Npgsql;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// Docs live editing is correct only while ONE API process serves it, and
/// this makes that constraint loud instead of written down.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY
///
///  DocsLiveHub keeps rooms in memory (and the per-person connection cap is
///  per process). Two API containers would put two people editing the same
///  document in two different rooms: they stop seeing each other, and their
///  work only meets at a checkpoint. Nothing in the deployment stops someone
///  scaling to two replicas "for availability" — Mr. Singh, 24 Sept, on PR
///  273: "a silent, data-losing failure triggered by an ordinary operational
///  decision … make it loud." Decision 0008 carries the deployment rule.
///
///  HOW
///
///  A Postgres session-level advisory lock, held on one dedicated connection
///  for the life of the process. Whoever holds it serves live editing; any
///  other instance answers 503 to /api/docs/{id}/live (so a browser never
///  joins a split room) and logs a CRITICAL line every minute naming the
///  problem. It keeps trying, every 15 s, so the ordinary deploy overlap —
///  new container up a moment before the old one exits — resolves itself.
///
///  WHY NOT REFUSE TO START
///
///  Refusing would turn that same deploy overlap into a failed deploy, and
///  would take Mail and Connect down with Docs for a Docs-only constraint.
///  Only the part that is wrong on a second instance is switched off.
///
///  If the lock's connection dies (database restart), this instance stops
///  claiming it at once and re-acquires; open rooms are closed by the hub's
///  watcher so browsers reconnect to whichever instance holds it.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class DocsInstanceGuard(IConfiguration config, ILogger<DocsInstanceGuard> log) : BackgroundService
{
    /// <summary>Arbitrary but fixed: "Docs live" as a 64-bit key. Change it and two versions stop excluding each other.</summary>
    private const long LockKey = 0x7476_446F_6373_4C31; // "tvDocsL1"

    private static readonly TimeSpan Retry = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan ShoutEvery = TimeSpan.FromMinutes(1);

    private volatile bool _sole;

    /// <summary>True only while this process holds the lock. Checked by every live connection.</summary>
    public bool IsSoleInstance => _sole;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var configured = config.GetConnectionString("Postgres");
        if (string.IsNullOrWhiteSpace(configured))
        {
            log.LogCritical("Docs live editing is OFF on this instance: no Postgres connection string to take the single-instance lock with.");
            return;
        }

        // Its own physical connection, NOT from the pool: a pooled connection
        // handed back would keep the session — and the lock — alive after
        // this code believes it let go.
        var connString = new NpgsqlConnectionStringBuilder(configured) { Pooling = false }.ConnectionString;

        var lastShout = DateTimeOffset.MinValue;
        NpgsqlConnection? held = null;

        while (!stop.IsCancellationRequested)
        {
            try
            {
                if (held is null)
                {
                    var conn = new NpgsqlConnection(connString);
                    await conn.OpenAsync(stop);
                    await using var cmd = new NpgsqlCommand("SELECT pg_try_advisory_lock(@k)", conn);
                    cmd.Parameters.AddWithValue("k", LockKey);
                    if (await cmd.ExecuteScalarAsync(stop) is true)
                    {
                        held = conn;
                        _sole = true;
                        log.LogInformation("Docs live editing: this instance holds the single-instance lock and serves live editing.");
                    }
                    else
                    {
                        await conn.DisposeAsync();
                        _sole = false;
                        if (DateTimeOffset.UtcNow - lastShout >= ShoutEvery)
                        {
                            lastShout = DateTimeOffset.UtcNow;
                            log.LogCritical(
                                "SECOND API INSTANCE DETECTED. Another process holds the Docs single-instance lock, so " +
                                "Docs live editing is DISABLED on this instance (its /live answers 503). Docs keeps rooms " +
                                "in memory; two API containers would split editors of one document and lose work. " +
                                "Run exactly one API container (decision 0008). Retrying every {Seconds} s.",
                                Retry.TotalSeconds);
                        }
                    }
                }
                else
                {
                    // Still alive? A dead connection means the lock is gone.
                    await using var ping = new NpgsqlCommand("SELECT 1", held);
                    await ping.ExecuteScalarAsync(stop);
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                if (held is not null)
                {
                    log.LogError(ex, "Docs live editing: lost the single-instance lock's connection; re-acquiring.");
                    try { await held.DisposeAsync(); } catch { /* already gone */ }
                    held = null;
                }
                else
                {
                    log.LogWarning(ex, "Docs live editing: could not check the single-instance lock; retrying.");
                }
                _sole = false;
            }

            try { await Task.Delay(Retry, stop); }
            catch (OperationCanceledException) { break; }
        }

        _sole = false;
        if (held is not null)
        {
            try { await held.DisposeAsync(); } catch { /* closing releases the lock */ }
        }
    }
}
