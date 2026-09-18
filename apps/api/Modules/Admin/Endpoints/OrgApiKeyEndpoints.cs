using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Organisation API keys — created and revoked by an organisation admin, used
/// by that organisation's own software (Amit, 18 September 2026).
///
/// The key is shown ONCE. It is stored as a SHA-256 hash carrying its own
/// scheme, with a visible prefix so two keys can be told apart in a list;
/// nothing here can recover the key itself, including us. Revoke, never
/// delete, so the audit trail keeps its subject.
///
/// WHAT MAKES THIS DIFFERENT FROM THE MAIL KEY: a key with people:admit can
/// create sign-in identities inside the organisation. So the scopes are
/// explicit per key, an unknown scope is refused rather than ignored, and the
/// screen that hands one out says plainly what it can do.
/// </summary>
public static class OrgApiKeyEndpoints
{
    /// <summary>Crockford-ish: no 0/O, no 1/l/I. These are copied by hand out of
    /// a console into a config file, and ambiguity there is a support ticket.
    /// 32 characters of this alphabet is about 184 bits.</summary>
    private const string Alphabet = "abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    private const int SecretLength = 32;
    public const string KeyPrefix = "tvk_";

    public static void MapOrgApiKeyEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/keys")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("", ListAsync);
        g.MapPost("", CreateAsync);
        g.MapDelete("/{id:guid}", RevokeAsync);
    }

    private static async Task<IResult> ListAsync(AppDbContext db, CancellationToken ct)
    {
        var keys = await db.OrgApiKeys.AsNoTracking()
            .OrderBy(k => k.CreatedAt)
            .ToListAsync(ct);

        var creatorIds = keys.Where(k => k.CreatedBy != null).Select(k => k.CreatedBy!.Value).Distinct().ToList();
        var creators = await db.Users.AsNoTracking()
            .Where(u => creatorIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        return Results.Ok(keys.Select(k => new
        {
            k.Id,
            k.Label,
            k.KeyPrefix,
            k.Scopes,
            k.CreatedAt,
            k.RevokedAt,
            k.LastUsedAt,
            createdByName = k.CreatedBy is { } who && creators.TryGetValue(who, out var n) ? n : null,
            status = k.RevokedAt is not null ? "revoked" : "active",
        }));
    }

    private static async Task<IResult> CreateAsync(
        CreateOrgKeyRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var label = req.Label?.Trim() ?? "";
        if (label.Length is < 2 or > 100)
            return Results.BadRequest(new { error = "Give the key a name of 2 to 100 characters — the program that will use it." });

        // Explicit, and refused rather than ignored when unknown: silently
        // dropping a scope an admin asked for is the same lie as a decorative
        // tick on the Applications screen.
        var scopes = (req.Scopes ?? []).Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().ToArray();
        foreach (var s in scopes)
            if (!OrgApiKey.Offerable.Any(o => o.Scope == s))
                return Results.BadRequest(new { error = $"'{s}' is not something a key can be given. Choose from: {string.Join(", ", OrgApiKey.Offerable.Select(o => o.Scope))}." });
        if (scopes.Length == 0)
            return Results.BadRequest(new { error = "Choose at least one thing this key may do. A key with nothing ticked could do nothing." });

        var secret = KeyPrefix + Generate();
        var entity = new OrgApiKey
        {
            TenantId = tenant.TenantId,
            Label = label,
            KeyHash = Sha256(secret),
            // Enough to recognise, far too little to guess from.
            KeyPrefix = secret[..(KeyPrefix.Length + 8)],
            Scopes = scopes,
            CreatedBy = tenant.UserId,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.OrgApiKeys.Add(entity);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("org.api_key_created", "org_api_key", entity.Id.ToString(),
            after: new { entity.Label, entity.KeyPrefix, entity.Scopes }, ct: ct);

        return Results.Created($"/api/org/keys/{entity.Id}", new
        {
            entity.Id,
            entity.Label,
            entity.Scopes,
            // Once. Hashed on the row and not recoverable by anyone.
            key = secret,
            entity.KeyPrefix,
            note = "This key is shown once. Store it in the program's own configuration now; it cannot be shown again, only replaced.",
        });
    }

    private static async Task<IResult> RevokeAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var key = await db.OrgApiKeys.FirstOrDefaultAsync(k => k.Id == id, ct);
        if (key is null) return Results.NotFound();
        if (key.RevokedAt is not null) return Results.Ok(new { key.Id, key.RevokedAt, alreadyRevoked = true });

        key.RevokedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("org.api_key_revoked", "org_api_key", id.ToString(),
            after: new { key.Label, key.KeyPrefix }, ct: ct);

        return Results.Ok(new
        {
            key.Id,
            key.RevokedAt,
            note = "Requests using this key are refused from now on. People it already added are unaffected.",
        });
    }

    /// <summary>
    /// Unsalted and deterministic BECAUSE the lookup is by hash: an API key
    /// arrives with no username, so the key is the identifier and a salted
    /// hash could not be looked up at all. Safe on a 32-character random
    /// secret — the entropy is the defence. The scheme travels with the hash.
    /// </summary>
    internal static string Sha256(string value)
        => "{SHA256}" + Convert.ToHexString(
               System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(value)))
           .ToLowerInvariant();

    private static string Generate()
    {
        var chars = new char[SecretLength];
        for (var i = 0; i < chars.Length; i++)
            chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        return new string(chars);
    }
}

public sealed record CreateOrgKeyRequest(string? Label, string[]? Scopes);
