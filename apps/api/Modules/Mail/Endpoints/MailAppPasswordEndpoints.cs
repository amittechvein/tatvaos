using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Npgsql;
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
///
///    The DATABASE enforces it too, since 28 August: a partial UNIQUE index
///    on (mailbox_id) WHERE revoked_at IS NULL. It did not before, and the
///    ORDER BY ... LIMIT 1 in the Dovecot query did not enforce it either -
///    it CONCEALED a violation, permanently, because rows are never deleted.
///    This endpoint is no longer the only thing between a customer and two
///    live credentials.
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
            .Select(p => new { p.Id, p.Label, p.CreatedAt })
            .FirstOrDefaultAsync(ct);

        return Results.Ok(new
        {
            address = box.Address,
            active,
            // MAIL-CLIENT-SETTINGS. This comment used to claim the API
            // serves these "so the settings screen and the client sheet can
            // never disagree about a port number". It cannot promise that:
            // the values appear in several places - pages that cannot call
            // this endpoint, printable docs, DNS SRV auto-config records,
            // container config - and this block is only the copy software
            // reads.
            //
            // The ROOT is the published port mappings in
            // infra/docker/docker-compose.production.yml. Change those and
            // the ports genuinely move, and every other appearance becomes
            // wrong. Everything else, this block included, restates them.
            //
            // Change a host or a port EVERYWHERE IT APPEARS, in one commit.
            // The authoritative list of appearances is not this comment and
            // not any count - it is what the value-grep returns:
            // \b(993|587)\b under apps docs infra local, every hit either
            // carrying this marker or a reasoned entry on the exceptions
            // list. Counting markers proves nothing - an unmarked copy is
            // invisible to it, as the DNS records were on the day the marker
            // was written. Deliberately no count and no line numbers here:
            // both decay silently and are trusted absolutely. This comment
            // said "3 copies", then "five", and was stale both times before
            // it merged.
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

        // Revoke-then-issue, ORDERED EXPLICITLY, both inside one transaction.
        //
        // The partial UNIQUE index means the revokes MUST reach the database
        // before the insert, and a partial unique index cannot be declared
        // DEFERRABLE - there is no commit-time escape. A single SaveChanges
        // would leave that order to EF's batch preparer, which is a fine
        // place for performance and a terrible place for correctness: the
        // failure would be a 23505 on the SECOND password a person ever
        // generates, which is the one they generate because the first
        // stopped working.
        //
        // Two saves in one transaction. Same atomicity, and the order is
        // written down instead of derived.
        var password = Generate();
        int replacedCount;

        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            var actives = await db.MailAppPasswords
                .Where(p => p.MailboxId == box.Id && p.RevokedAt == null)
                .ToListAsync(ct);
            foreach (var old in actives) old.RevokedAt = DateTimeOffset.UtcNow;
            replacedCount = actives.Count;

            if (replacedCount > 0) await db.SaveChangesAsync(ct);

            db.MailAppPasswords.Add(new MailAppPassword
            {
                Id = Guid.NewGuid(),
                MailboxId = box.Id,
                Label = label,
                PasswordHash = Ssha512(password),
                CreatedAt = DateTimeOffset.UtcNow,
            });

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
            {
                // The index doing its job. Two generate requests for the same
                // mailbox overlapped, and one of them lost between its read
                // and its write. Before the index this produced two live
                // credentials and no error at all - which is the bug it was
                // added to stop, so this exception is the fix working, not
                // the fix failing.
                //
                // 409 rather than 500: nothing is wrong with the request. It
                // lost a race it wins by being repeated.
                await tx.RollbackAsync(ct);
                return Results.Conflict(new
                {
                    error = "Another app password was just generated for this mailbox. "
                          + "Reload the page and try again.",
                });
            }

            await tx.CommitAsync(ct);
        }

        await audit.WriteAsync("mail.app_password.generated", "mail.mailbox", box.Id.ToString(),
            after: new { label, replaced = replacedCount > 0 }, ct: ct, productCode: "mail");

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
