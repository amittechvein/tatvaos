namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  AI usage — mirrors local/postgres/init/20260924-ai-usage.sql.
//  Written and read by MeteredAiGateway; counts only, never content.
// ============================================================================

/// <summary>One request to the AI gateway: who, which feature, what happened, what it cost.</summary>
public class AiUsage
{
    public long Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid? UserId { get; set; }
    public string Feature { get; set; } = "other";
    /// <summary>ok | failed | refused_paused | refused_person_limit | refused_org_limit</summary>
    public string Outcome { get; set; } = "ok";
    public int TokensIn { get; set; }
    public int TokensOut { get; set; }
    /// <summary>The model the request went to (or would have) — money is tokens × this model's price.</summary>
    public string Model { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>A ceiling warning already sent to an organisation's administrators this month.</summary>
/// <summary>
/// Extra AI credits for one organisation for one month (India time), on top of
/// its plan or override. Withdrawn, never deleted — each row records a sale.
/// See 20260926-c-ai-credit-topups.sql.
/// </summary>
public class AiCreditTopup
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public DateOnly Month { get; set; }
    public int Credits { get; set; }
    public decimal? PriceInr { get; set; }
    public string Reason { get; set; } = "";
    public Guid AddedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? WithdrawnAt { get; set; }
    public Guid? WithdrawnBy { get; set; }
    public string? WithdrawReason { get; set; }
}

/// <summary>An 80 % / 100 % warning about AI CREDITS (not tokens) — see AiCredits.</summary>
public class AiCreditAlert
{
    public Guid TenantId { get; set; }
    public DateOnly Month { get; set; }
    public short Level { get; set; }
    public int Allowance { get; set; }
    public DateTimeOffset SentAt { get; set; } = DateTimeOffset.UtcNow;
}

public class AiUsageAlert
{
    public Guid TenantId { get; set; }
    /// <summary>First day of the month, India time.</summary>
    public DateOnly Month { get; set; }
    /// <summary>80 or 100 (per cent of the monthly ceiling).</summary>
    public short Level { get; set; }
    /// <summary>The ceiling warned about — a raised ceiling warns again.</summary>
    public long Ceiling { get; set; }
    public DateTimeOffset SentAt { get; set; } = DateTimeOffset.UtcNow;
}
