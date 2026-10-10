using Microsoft.EntityFrameworkCore;
using Npgsql;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;

namespace TatvaOS.Api.Modules.Migration;

/// <summary>
/// The whole organisation, person by person: turns Google's directory into
/// migration jobs, matches each Google person to a TatvaOS person, starts
/// them when an administrator says so, and reports progress per address.
///
/// ─────────────────────────────────────────────────────────────────────────
///  ENROL creates one job per active person per data type, 'planned'. It
///  starts nothing: the runner never claims a planned job. Re-enrolling is
///  harmless (one row per person per type, ON CONFLICT DO NOTHING), and
///  picks up people added to Google since.
///
///  MATCHING is by address, exactly, case-insensitively: the person whose
///  sign-in email is the Google address, else whose own mailbox has it. No
///  guessing by name or local part - mail delivered to the wrong person is
///  the one mistake a migration cannot take back. An unmatched person keeps a
///  job with no target, is reported by address, and can never be started
///  until someone creates or matches the TatvaOS person and enrols again.
///
///  START moves planned (or failed/cancelled, to retry) jobs to pending, for
///  matched people only, optionally for a chosen few addresses - "one person
///  first, as a trial" is the expected way to begin.
///
///  Everything here runs inside ONE organisation, under RLS: the caller has
///  entered it. Suspended and archived Google accounts are not enrolled.
///
///  NOT HERE: reading Google's directory (needs the customer's key - section
///  9). The caller passes the people in; MigrationSizeEstimator lists them.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class MigrationEnrolment(AppDbContext db)
{
    public static readonly IReadOnlySet<string> DataTypes =
        new HashSet<string>(StringComparer.Ordinal) { "mail", "contacts", "calendar", "drive" };

    public async Task<EnrolmentReport> EnrolAsync(
        Guid tenantId, IReadOnlyList<GoogleDirectoryUser> people, IReadOnlyCollection<string> dataTypes,
        Guid? enrolledBy, CancellationToken ct)
    {
        Validate(dataTypes);
        var active = people.Where(p => !p.Suspended && !p.Archived)
            .Select(p => p.PrimaryEmail.Trim().ToLowerInvariant()).Distinct().Order().ToArray();
        var notEnrolled = people.Where(p => p.Suspended || p.Archived)
            .Select(p => p.PrimaryEmail.Trim().ToLowerInvariant()).Distinct().Order().ToList();

        var conn = await OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        long created;
        await using (var insert = new NpgsqlCommand("""
            WITH ins AS (
                INSERT INTO migration.jobs (tenant_id, source, data_type, source_user, created_by)
                SELECT @tenant, 'google_workspace', d, e, @by
                  FROM unnest(@emails::text[]) e CROSS JOIN unnest(@types::text[]) d
                ON CONFLICT (tenant_id, source, data_type, source_user) DO NOTHING
                RETURNING 1)
            SELECT count(*) FROM ins
            """, conn, tx))
        {
            insert.Parameters.AddWithValue("tenant", tenantId);
            insert.Parameters.AddWithValue("by", (object?)enrolledBy ?? DBNull.Value);
            insert.Parameters.AddWithValue("emails", active);
            insert.Parameters.AddWithValue("types", dataTypes.ToArray());
            created = (long)(await insert.ExecuteScalarAsync(ct))!;
        }

        // Match: sign-in email first, then a person's own mailbox address.
        // Only jobs with no target yet - a match someone made by hand stays.
        await using (var match = new NpgsqlCommand("""
            UPDATE migration.jobs j SET target_user_id = u.id, updated_at = now()
              FROM core.users u
             WHERE j.tenant_id = @tenant AND j.source = 'google_workspace' AND j.target_user_id IS NULL
               AND j.source_user = ANY(@emails::text[])
               AND u.tenant_id = j.tenant_id AND u.status <> 'deleted'
               AND lower(u.email::text) = j.source_user;
            UPDATE migration.jobs j SET target_user_id = mb.user_id, updated_at = now()
              FROM mail.mailboxes mb
              JOIN core.users u ON u.id = mb.user_id AND u.status <> 'deleted'
             WHERE j.tenant_id = @tenant AND j.source = 'google_workspace' AND j.target_user_id IS NULL
               AND j.source_user = ANY(@emails::text[])
               AND mb.tenant_id = j.tenant_id AND mb.type = 'user' AND mb.user_id IS NOT NULL
               AND lower(mb.address::text) = j.source_user;
            """, conn, tx))
        {
            match.Parameters.AddWithValue("tenant", tenantId);
            match.Parameters.AddWithValue("emails", active);
            await match.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);

        var matched = await db.MigrationJobs.AsNoTracking()
            .Where(j => j.Source == "google_workspace" && active.Contains(j.SourceUser) && j.TargetUserId != null)
            .Select(j => j.SourceUser).Distinct().ToListAsync(ct);
        var unmatched = active.Except(matched).Order().ToList();

        return new EnrolmentReport(active.Length, (int)created, matched.Count, unmatched, notEnrolled);
    }

    /// <summary>
    /// Start the planned (or failed/cancelled) jobs of matched people.
    /// <paramref name="onlyPeople"/> null = everyone enrolled.
    /// </summary>
    public async Task<StartReport> StartAsync(
        IReadOnlyCollection<string> dataTypes, IReadOnlyCollection<string>? onlyPeople, CancellationToken ct)
    {
        Validate(dataTypes);
        var people = onlyPeople?.Select(p => p.Trim().ToLowerInvariant()).Distinct().ToArray();
        var conn = await OpenAsync(ct);
        await using var cmd = new NpgsqlCommand("""
            UPDATE migration.jobs SET state = 'pending', next_attempt_at = now(), attempts = 0,
                   finished_at = NULL, updated_at = now()
             WHERE source = 'google_workspace'
               AND state IN ('planned', 'failed', 'cancelled')
               AND data_type = ANY(@types::text[])
               AND target_user_id IS NOT NULL
               AND (@people::text[] IS NULL OR source_user = ANY(@people::text[]))
            RETURNING source_user
            """, conn);
        cmd.Parameters.AddWithValue("types", dataTypes.ToArray());
        cmd.Parameters.Add(new NpgsqlParameter("people", NpgsqlTypes.NpgsqlDbType.Array | NpgsqlTypes.NpgsqlDbType.Text)
            { Value = (object?)people ?? DBNull.Value });
        var started = new List<string>();
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) started.Add(r.GetString(0));

        // Asked for by name but not startable: say which, and why.
        var notStarted = new List<PersonNote>();
        if (people is not null)
        {
            var jobs = await db.MigrationJobs.AsNoTracking()
                .Where(j => j.Source == "google_workspace" && people.Contains(j.SourceUser) && dataTypes.Contains(j.DataType))
                .Select(j => new { j.SourceUser, j.TargetUserId, j.State }).ToListAsync(ct);
            foreach (var p in people.Where(p => !started.Contains(p)).Order())
            {
                var mine = jobs.Where(j => j.SourceUser == p).ToList();
                notStarted.Add(new PersonNote(p,
                    mine.Count == 0 ? "not enrolled"
                    : mine.All(j => j.TargetUserId is null) ? "no TatvaOS person matches this address"
                    : $"already {string.Join("/", mine.Select(j => j.State).Distinct().Order())}"));
            }
        }
        return new StartReport(started.Count, started.Distinct().Count(), notStarted);
    }

    /// <summary>
    /// Mail that arrived in Gmail since a person's mail job finished: put
    /// their COMPLETED mail jobs back to pending, keeping the cursor
    /// ("d:&lt;historyId&gt;"), so the next run brings only what was added.
    /// Run as often as needed before the customer switches MX, and once after.
    /// <paramref name="onlyPeople"/> null = everyone. Returns the addresses re-queued.
    /// </summary>
    public async Task<IReadOnlyList<string>> CatchUpMailAsync(IReadOnlyCollection<string>? onlyPeople, CancellationToken ct)
    {
        var people = onlyPeople?.Select(p => p.Trim().ToLowerInvariant()).Distinct().ToArray();
        var conn = await OpenAsync(ct);
        await using var cmd = new NpgsqlCommand("""
            UPDATE migration.jobs SET state = 'pending', next_attempt_at = now(), attempts = 0,
                   finished_at = NULL, updated_at = now()
             WHERE source = 'google_workspace' AND data_type = 'mail'
               AND state = 'completed' AND cursor LIKE 'd:%'
               AND target_user_id IS NOT NULL
               AND (@people::text[] IS NULL OR source_user = ANY(@people::text[]))
            RETURNING source_user
            """, conn);
        cmd.Parameters.Add(new NpgsqlParameter("people", NpgsqlTypes.NpgsqlDbType.Array | NpgsqlTypes.NpgsqlDbType.Text)
            { Value = (object?)people ?? DBNull.Value });
        var queued = new List<string>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) queued.Add(r.GetString(0));
        return queued;
    }

    /// <summary>Every enrolled person in this organisation, with each data type's progress.</summary>
    public async Task<IReadOnlyList<PersonProgress>> ProgressAsync(CancellationToken ct)
    {
        var rows = await (
            from j in db.MigrationJobs.AsNoTracking()
            where j.Source == "google_workspace"
            join u in db.Users.AsNoTracking() on j.TargetUserId equals u.Id into us
            from u in us.DefaultIfEmpty()
            orderby j.SourceUser, j.DataType
            select new
            {
                j.SourceUser, j.TargetUserId, TargetEmail = u == null ? null : u.Email,
                j.DataType, j.State, j.ItemsTotal, j.ItemsDone, j.ItemsSkipped, j.ItemsFailed, j.BytesDone,
                j.LastError, j.UpdatedAt,
            }).ToListAsync(ct);

        return rows.GroupBy(r => r.SourceUser).Select(g => new PersonProgress(
            g.Key, g.First().TargetUserId, g.First().TargetEmail,
            g.Select(r => new TypeProgress(r.DataType, r.State, r.ItemsTotal, r.ItemsDone, r.ItemsSkipped,
                r.ItemsFailed, r.BytesDone, r.LastError, r.UpdatedAt)).ToList())).ToList();
    }

    private static void Validate(IReadOnlyCollection<string> dataTypes)
    {
        if (dataTypes.Count == 0 || dataTypes.Any(t => !DataTypes.Contains(t)))
            throw new ArgumentException($"data types must be some of: {string.Join(", ", DataTypes.Order())}");
    }

    private async Task<NpgsqlConnection> OpenAsync(CancellationToken ct)
    {
        if (db.Database.GetDbConnection().State != System.Data.ConnectionState.Open)
        {
            await db.Database.OpenConnectionAsync(ct);
            await db.SyncTenantAsync(ct);
        }
        return (NpgsqlConnection)db.Database.GetDbConnection();
    }
}

/// <param name="People">Active Google people offered.</param>
/// <param name="JobsCreated">New job rows; 0 on a repeat enrolment.</param>
/// <param name="Matched">People matched to a TatvaOS person.</param>
/// <param name="Unmatched">Addresses with no TatvaOS person - enrolled, never startable as they are.</param>
/// <param name="NotEnrolled">Suspended or archived in Google.</param>
public sealed record EnrolmentReport(int People, int JobsCreated, int Matched,
    IReadOnlyList<string> Unmatched, IReadOnlyList<string> NotEnrolled);

public sealed record StartReport(int JobsStarted, int PeopleStarted, IReadOnlyList<PersonNote> NotStarted);

public sealed record PersonProgress(string GoogleAddress, Guid? TargetUserId, string? TargetEmail, IReadOnlyList<TypeProgress> Types);

public sealed record TypeProgress(string DataType, string State, long? ItemsTotal, long ItemsDone, long ItemsSkipped,
    long ItemsFailed, long BytesDone, string? LastError, DateTimeOffset UpdatedAt);
