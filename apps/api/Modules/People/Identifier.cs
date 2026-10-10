namespace TatvaOS.Api.Modules.People;

/// <summary>An organisation's data key, wrapped by the master key (people.identifier_keys).</summary>
public sealed class IdentifierKey
{
    public Guid TenantId { get; set; }
    public short Version { get; set; }
    public byte[] WrappedKey { get; set; } = [];
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// One Aadhaar, PAN or bank account on an employee (people.employee_identifiers).
/// <see cref="Ciphertext"/> only - the value exists in memory, never in a column.
/// </summary>
public sealed class EmployeeIdentifier
{
    public Guid TenantId { get; set; }
    public Guid EmployeeId { get; set; }
    /// <summary>aadhaar, pan, bank_account.</summary>
    public string Kind { get; set; } = "";
    public byte[] Ciphertext { get; set; } = [];
    public short KeyVersion { get; set; }
    public string Last4 { get; set; } = "";
    public byte[]? LookupHash { get; set; }
    public string? Ifsc { get; set; }
    public DateTimeOffset? VerifiedAt { get; set; }
    public Guid? VerifiedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}

/// <summary>Someone the organisation names to reveal full identifiers (Amit, 10 Oct 2026).</summary>
public sealed class IdentifierReader
{
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public Guid? AddedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>One value revealed (or a reveal that failed). Append-only. Never the value or its last four.</summary>
public sealed class IdentifierRead
{
    public long Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid EmployeeId { get; set; }
    public string Kind { get; set; } = "";
    public Guid ReaderId { get; set; }
    public string Reason { get; set; } = "";
    public string? Note { get; set; }
    /// <summary>shown or failed.</summary>
    public string Outcome { get; set; } = "";
    public DateTimeOffset ReadAt { get; set; }
}
