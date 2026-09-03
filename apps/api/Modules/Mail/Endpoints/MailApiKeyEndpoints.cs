using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Mail.Endpoints;

/// <summary>
/// Organisation API keys — create, list, revoke.
///
/// Shaped on MailAppPasswordEndpoints deliberately: same alphabet, same
/// shown-once rule, same revoke-is-an-UPDATE. Read that file first; the
/// differences are called out where they occur.
///
/// TWO DIFFERENCES FROM THAT FILE, BOTH DELIBERATE:
///
///  · MANY ACTIVE KEYS PER ORGANISATION. App passwords are one-active because
///    Dovecot's SQL passdb verifies exactly one row. Nothing imposes that
///    here, and many is the point: a website and a billing job are different
///    credentials with different revocation lifetimes. So there is no
///    revoke-on-generate and no partial unique index — what must be unique is
///    the secret itself, which ix_api_keys_hash enforces.
///
///  · {SHA256}, not {SSHA512}. A salted hash cannot be looked up by, and an
///    API key arrives with no username — the key IS the identifier. See the
///    migration's comment for why unsalted is safe on 32 random characters.
/// </summary>
public static class MailApiKeyEndpoints
{
    /// <summary>Crockford-ish: no 0/O, no 1/l/I. These get copied by hand out
    /// of a console into a config file, and ambiguity there is a support
    /// ticket. 32 chars x ~5.75 bits = ~184 bits.</summary>
    private const string Alphabet = "abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    private const int SecretLength = 32;

    public static void MapMailApiKeyEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/mail/api-keys")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Mail");

        g.MapGet("", ListAsync);
        g.MapPost("", CreateAsync);
        g.MapDelete("/{id:guid}", RevokeAsync);
    }

    public sealed record CreateRequest(string? Label);

    private static async Task<IResult> ListAsync(
        AppDbContext db, CancellationToken ct)
    {
        var keys = await db.MailApiKeys.AsNoTracking()
            .Where(k => k.RevokedAt == null)
            .OrderByDescending(k => k.CreatedAt)
            .Select(k => new { k.Id, k.Label, k.KeyPrefix, k.CreatedAt, k.LastUsedAt })
            .ToListAsync(ct);

        return Results.Ok(new { keys });
    }

    private static async Task<IResult> CreateAsync(
        CreateRequest? req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var label = (req?.Label ?? "").Trim();
        if (label.Length is < 1 or > 100)
            return Results.BadRequest(new { error = "Name the application this key is for." });

        // 'tvos_' so a leaked key is identifiable in a log, a paste or a
        // support ticket without anyone having to recognise the shape.
        var secret = "tvos_" + Generate();
        var prefix = secret[..13];

        db.MailApiKeys.Add(new MailApiKey
        {
            Id = Guid.NewGuid(),
            TenantId = tenant.TenantId,
            Label = label,
            KeyHash = Sha256(secret),
            KeyPrefix = prefix,
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("mail.api_key_created", "api_key", label, ct: ct);

        return Results.Ok(new
        {
            label,
            prefix,
            // The ONLY time this value exists outside the caller's own
            // storage. Not retrievable afterwards, by anyone, by design:
            // "view key" turns one database read into every customer's
            // sending identity.
            key = secret,
            note = "Copy this now. It is shown once and cannot be retrieved.",
        });
    }

    private static async Task<IResult> RevokeAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var key = await db.MailApiKeys.FirstOrDefaultAsync(k => k.Id == id && k.RevokedAt == null, ct);
        if (key is null) return Results.NotFound(new { error = "No active key with that id." });

        // An UPDATE, never a DELETE — the row is the audit trail, and
        // mail.api_sends references it.
        key.RevokedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("mail.api_key_revoked", "api_key", key.Label, ct: ct);

        return Results.Ok(new
        {
            revoked = true,
            // Said plainly because it is what the operator needs to know and
            // the button cannot imply more than it does: new requests stop
            // now; anything already handed to Postfix is gone.
            note = "New requests with this key are refused immediately. "
                 + "Mail already accepted for delivery is not recalled.",
        });
    }

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
