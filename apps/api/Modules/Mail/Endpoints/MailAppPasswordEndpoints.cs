using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Mail.Endpoints;

/// <summary>
/// App passwords for third-party SMTP/IMAP clients.
///
/// ─────────────────────────────────────────────────────────────────────────
///  LANE NOTE, STATED RATHER THAN HOPED UNNOTICED: this is Mail's module and
///  Core wrote this file, on 28 August 2026, as a declared exception — a
///  customer was waiting on external SMTP and Mail was deep in the redesign.
///  It is a NEW file plus one registration line in Program.cs precisely so it
///  cannot collide with anything Mail has in flight. Mail: review it as if
///  it arrived in a pull request, and reshape freely — the dovecot side
///  (dovecot-sql-app.conf.ext) only cares about the table.
///
///  ─────────────────────────────────────────────────────────────────────────
///  THE RULES THIS ENCODES
///
///  · The password is SHOWN ONCE, at generation, and never retrievable —
///    only a hash is stored. "View password" is a feature that turns one
///    database read into every mailbox's mail.
///  · ONE ACTIVE PER MAILBOX: generating revokes the predecessor, because
///    Dovecot's SQL passdb verifies exactly one row. The UI says "your app
///    password", singular, and this endpoint is why.
///  · {SSHA512}, computed here, prefix and all. Deliberately NOT the Argon2
///    hasher the rest of the platform uses: Dovecot must verify this hash,
///    Argon2's wire format between our hasher and libsodium is exactly the
///    kind of cross-implementation seam this week kept finding bugs in, and
///    a 26-character random secret does not need memory-hard hashing — the
///    entropy is the defence, not the work factor.
///  · Revoking is an UPDATE, never a DELETE — the row is the audit trail.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailAppPasswordEndpoints
{
    /// <summary>
    /// Crockford-ish alphabet: no 0/O, no 1/l/I — this string gets typed into
    /// a phone's settings screen by hand, and ambiguity there is support
    /// tickets. 26 chars × ~5 bits = ~130 bits of entropy.
    /// </summary>
    private const string Alphabet = "abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    private const int PasswordLength = 26;

    public static void MapMailAppPasswordEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/mail/app-password")
            .RequireAuthorization("User")
            .WithTags("Mail");

        g.MapGet("", GetAsync);
        g.MapPost("", GenerateAsync);
        g.MapDelete("", RevokeAsync);
    }

    public sealed record GenerateRequest(string? Label);

    private static async Task<Mailbox?> OwnMailboxAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
        => tenant.UserId is Guid uid
            ? await db.Mailboxes.AsNoTracking()
                .FirstOrDefaultAsync(m => m.UserId == uid && m.Type == "user" && m.IsActive, ct)
            : null;

    private static async Task<IResult> GetAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound(new { error = "You have no mailbox on this account." });

        var active = await db.MailAppPasswords.AsNoTracking()
            .Where(p => p.MailboxId == box.Id && p.RevokedAt == null)
            .OrderByDescending(p => p.CreatedAt)
            .Select(p => new { p.Id, p.Label, p.CreatedAt, p.LastUsedAt })
            .FirstOrDefaultAsync(ct);

        return Results.Ok(new
        {
            address = box.Address,
            active,
            // What the person pastes beside the password — served from the
            // API so the settings screen and the client sheet can never
            // disagree about a port number.
            settings = new
            {
                imapHost = "mail.tatvaos.com", imapPort = 993, imapSecurity = "SSL/TLS",
                smtpHost = "mail.tatvaos.com", smtpPort = 587, smtpSecurity = "STARTTLS",
                username = box.Address,
            },
        });
    }

    private static async Task<IResult> GenerateAsync(
        GenerateRequest? req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound(new { error = "You have no mailbox on this account." });

        var label = (req?.Label ?? "").Trim();
        if (label.Length is < 1 or > 100)
            return Results.BadRequest(new { error = "Name the device or app this password is for." });

        // Revoke-then-issue in one save: there is never a moment with two
        // active rows, so the LIMIT 1 in the Dovecot query and this endpoint
        // can never disagree about which password is the real one.
        var actives = await db.MailAppPasswords
            .Where(p => p.MailboxId == box.Id && p.RevokedAt == null)
            .ToListAsync(ct);
        foreach (var old in actives) old.RevokedAt = DateTimeOffset.UtcNow;

        var password = Generate();
        db.MailAppPasswords.Add(new MailAppPassword
        {
            Id = Guid.NewGuid(),
            MailboxId = box.Id,
            Label = label,
            PasswordHash = Ssha512(password),
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("mail.app_password.generated", "mail.mailbox", box.Id.ToString(),
            after: new { label, replaced = actives.Count > 0 }, ct: ct, productCode: "mail");

        // The one and only time the password exists in cleartext outside the
        // person's own screen. It is not logged, not stored, not recoverable.
        return Results.Ok(new
        {
            password,
            label,
            note = "Shown once. If it is lost, generate a new one — the old one stops working the moment you do.",
        });
    }

    private static async Task<IResult> RevokeAsync(
        AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound(new { error = "You have no mailbox on this account." });

        var actives = await db.MailAppPasswords
            .Where(p => p.MailboxId == box.Id && p.RevokedAt == null)
            .ToListAsync(ct);
        if (actives.Count == 0) return Results.Ok(new { revoked = false });

        foreach (var p in actives) p.RevokedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("mail.app_password.revoked", "mail.mailbox", box.Id.ToString(),
            ct: ct, productCode: "mail");

        return Results.Ok(new { revoked = true });
    }

    private static string Generate()
    {
        var chars = new char[PasswordLength];
        for (var i = 0; i < chars.Length; i++)
            chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        return new string(chars);
    }

    /// <summary>
    /// Dovecot's SSHA512: base64( SHA512(password ++ salt) ++ salt ), with
    /// the {SSHA512} prefix that makes the scheme travel with the hash.
    /// </summary>
    private static string Ssha512(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(8);
        var input = Encoding.UTF8.GetBytes(password);
        var buffer = new byte[input.Length + salt.Length];
        input.CopyTo(buffer, 0);
        salt.CopyTo(buffer, input.Length);
        var digest = SHA512.HashData(buffer);
        var stored = new byte[digest.Length + salt.Length];
        digest.CopyTo(stored, 0);
        salt.CopyTo(stored, digest.Length);
        return "{SSHA512}" + Convert.ToBase64String(stored);
    }
}
