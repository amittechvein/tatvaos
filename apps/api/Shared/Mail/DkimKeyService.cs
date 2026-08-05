using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Shared.Mail;

/// <summary>
/// Generates and materialises the DKIM signing key for a domain.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY A KEY PER DOMAIN, GENERATED HERE
///
///  DKIM only helps if the signing domain aligns with the From domain, so a
///  customer sending as @theirschool.edu.in cannot be signed by a key
///  published under tatvaos.com — DMARC would see the mismatch and the
///  signature would count for nothing.
///
///  Generating it at the moment a domain is added means the customer sees one
///  complete set of DNS records to publish, instead of coming back later for
///  a second round after somebody remembers DKIM.
///
///  THE PRIVATE KEY IS WRITE-ONLY FROM THE OUTSIDE. It is stored in
///  core.dkim_keys, which is RLS-forced and carries no grant to the mail-edge
///  role, and it is written to the signing volume as a file. No endpoint
///  returns it, and there is no method here that reads one back for display.
///  The only consumer is OpenDKIM, reading the file.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class DkimKeyService(
    AppDbContext db,
    TenantContext tenant,
    IConfiguration config,
    ILogger<DkimKeyService> log)
{
    /// <summary>
    /// Where OpenDKIM reads keys from. A named volume shared with that
    /// container, mounted read-only there and read-write here.
    /// </summary>
    private string KeyDirectory => config["Dkim:KeyDirectory"] ?? "/dkim";

    /// <summary>
    /// 2048 bits. 1024 is still accepted everywhere but is below what several
    /// receivers now treat as weak; 4096 exceeds the 255-character limit of a
    /// single DNS string, so the record has to be split into chunks — which
    /// most control panels get wrong. 2048 fits in one record most of the
    /// time and is what everyone publishes.
    /// </summary>
    private const int KeySizeBits = 2048;

    public sealed record DkimRecord(string Selector, string Host, string Value);

    /// <summary>
    /// Returns the domain's active key record, generating one if it has none.
    ///
    /// Idempotent: a second call returns the existing key rather than rotating,
    /// because rotating silently would invalidate the record the customer has
    /// already published and break signing until they noticed.
    /// </summary>
    public async Task<DkimRecord> EnsureKeyAsync(Domain domain, CancellationToken ct)
    {
        var existing = await db.DkimKeys
            .Where(k => k.DomainId == domain.Id && k.IsActive)
            .OrderByDescending(k => k.CreatedAt)
            .FirstOrDefaultAsync(ct);

        if (existing is not null)
        {
            // Re-materialise on every call. Containers are replaced, volumes
            // get restored from backup, and a key row with no matching file is
            // silently unsigned mail — a failure with no error anywhere.
            await MaterialiseAsync(domain.Fqdn, existing.Selector, existing.PrivateKeyPem, ct);
            return Record(domain.Fqdn, existing.Selector, existing.PublicKeyB64);
        }

        // Dated selector, so a rotation next year publishes tv2027a alongside
        // tv2026a and both sign until DNS has settled.
        var selector = domain.DkimSelector is { Length: > 0 } s
            ? s
            : $"tv{DateTime.UtcNow:yyyy}a";

        using var rsa = RSA.Create(KeySizeBits);
        var privatePem = rsa.ExportPkcs8PrivateKeyPem();
        var publicB64 = Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo());

        db.DkimKeys.Add(new DkimKey
        {
            TenantId = tenant.TenantId,
            DomainId = domain.Id,
            Selector = selector,
            PrivateKeyPem = privatePem,
            PublicKeyB64 = publicB64,
        });

        domain.DkimSelector = selector;
        await db.SaveChangesAsync(ct);

        await MaterialiseAsync(domain.Fqdn, selector, privatePem, ct);

        log.LogInformation("Generated a DKIM key for {Fqdn} with selector {Selector}",
                           domain.Fqdn, selector);

        return Record(domain.Fqdn, selector, publicB64);
    }

    /// <summary>
    /// The TXT record the customer publishes. Built here rather than in the
    /// UI so the console, the API response and any future email to the
    /// customer cannot disagree about it.
    /// </summary>
    private static DkimRecord Record(string fqdn, string selector, string publicB64) =>
        new(selector,
            $"{selector}._domainkey.{fqdn}",
            // k=rsa is technically the default; stated because several DNS
            // validators warn when it is absent, and a warning in a customer's
            // control panel becomes a support ticket.
            $"v=DKIM1; k=rsa; p={publicB64}");

    /// <summary>
    /// Writes the private key where OpenDKIM will find it.
    ///
    /// The filename carries the domain and selector because OpenDKIM's tables
    /// are rebuilt by scanning this directory — no separate manifest to fall
    /// out of step with the files themselves.
    /// </summary>
    private async Task MaterialiseAsync(
        string fqdn, string selector, string privatePem, CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(KeyDirectory);
            var path = Path.Combine(KeyDirectory, $"{fqdn}.{selector}.key");

            // Written to a temporary file and moved into place. OpenDKIM
            // rescans this directory on a timer, and a half-written key it
            // happened to catch mid-write would make it sign with garbage.
            var tmp = path + ".tmp";
            await File.WriteAllTextAsync(tmp, privatePem, ct);

            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(tmp, UnixFileMode.UserRead | UnixFileMode.UserWrite);

            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            // Deliberately not fatal. Failing to write the file must not fail
            // the customer's "add domain" request — the key row is safe in the
            // database and the next call re-materialises it. Logged loudly
            // because until it succeeds, mail for this domain goes unsigned.
            log.LogError(ex,
                "Could not write the DKIM key for {Fqdn} to {Dir}. Mail for this " +
                "domain will be UNSIGNED until this succeeds.", fqdn, KeyDirectory);
        }
    }
}
