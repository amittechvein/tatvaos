namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  GOOGLE WORKSPACE MIGRATION - the job runner's two tables
// ============================================================================
//
//  Mirrors 20261009-migration-jobs.sql; the reasons for every column are in
//  that file's header. Both are tenant-owned with forced RLS AND an EF query
//  filter (AppDbContext), the two layers decision 0007 requires.
//
//  The runner (Modules/Migration/MigrationJobRunner.cs) claims and advances
//  jobs with SQL of its own, because a claim has to be one atomic statement.
//  These entities are for reading - status screens, reports, tests.
// ============================================================================

public class MigrationJob
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }

    /// <summary>'google_workspace' or 'synthetic' (Development only).</summary>
    public string Source { get; set; } = "google_workspace";
    /// <summary>'mail', 'contacts', 'calendar' or 'drive'.</summary>
    public string DataType { get; set; } = "";
    /// <summary>The person in the source system - their Google primary address.</summary>
    public string SourceUser { get; set; } = "";
    /// <summary>Who it lands with here. A job with none is never claimed.</summary>
    public Guid? TargetUserId { get; set; }

    /// <summary>pending, running, completed, failed, cancelled.</summary>
    public string State { get; set; } = "pending";
    /// <summary>The source's own resume token. Opaque; NULL = from the start.</summary>
    public string? Cursor { get; set; }

    public long? ItemsTotal { get; set; }
    public long ItemsDone { get; set; }
    public long ItemsSkipped { get; set; }
    public long ItemsFailed { get; set; }
    public long BytesDone { get; set; }

    public int Attempts { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; } = DateTimeOffset.UtcNow;
    public string? LastError { get; set; }

    public string? LeaseOwner { get; set; }
    public DateTimeOffset? LeaseExpiresAt { get; set; }

    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
}

public class MigrationItem
{
    public long Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid JobId { get; set; }

    /// <summary>The source's id for the item. Unique per job.</summary>
    public string SourceId { get; set; } = "";
    /// <summary>What makes two different source items one thing here - Message-ID for mail.</summary>
    public string? DedupeKey { get; set; }

    /// <summary>done, skipped or failed.</summary>
    public string Outcome { get; set; } = "done";
    public string? Reason { get; set; }
    public long Bytes { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
