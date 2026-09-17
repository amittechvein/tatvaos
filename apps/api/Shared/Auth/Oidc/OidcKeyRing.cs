using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.IdentityModel.Tokens;

namespace TatvaOS.Api.Shared.Auth.Oidc;

// ============================================================================
//  The provider's RSA keys — decision 0004, stage 2.
// ============================================================================
//
//  WHERE THEY LIVE, AND NOWHERE ELSE. PEM files in one directory, the
//  `oidckeys` volume mounted into the API container only, mode 0600, owned
//  by the API user — the dkimkeys pattern. Never Jwt__SigningKey (that is a
//  symmetric secret every relying party would need, and anyone holding it
//  could mint a TatvaOS session), never infra/docker/.env (backup.sh copies
//  that file verbatim), never a backup. A lost key is replaced by generating
//  a new one; relying parties pick it up from the published key set. Nothing
//  long-lived is signed, so nothing long-lived breaks.
//
//  A stolen private key lets its holder sign in as anyone, to any connected
//  application, of any organisation, until the key is rotated. That is the
//  security boundary of the whole feature, and it is why this class never
//  returns, logs or prints private material, only kids.
//
//  FILES.   sig-<unix>.pem                   a signing key, active
//           sig-<unix>.retired-<unix>.pem    a signing key that has been
//                                            rotated out; still PUBLISHED so
//                                            an ID token signed a moment
//                                            before the rotation still
//                                            verifies, and deleted after
//                                            RetiredPublishWindow (one day,
//                                            far longer than any ID token
//                                            lives)
//           enc-<unix>.pem                   the key OpenIddict encrypts its
//                                            own token payloads with; never
//                                            published, never rotated by the
//                                            runbook (a payload it cannot
//                                            open is a token that fails
//                                            closed)
//
//  ROTATION is `TatvaOS.Api --oidc-rotate`, run in the container against the
//  same directory, then a restart: the newest active key signs, every active
//  and recently-retired key is published. docs/runbooks/oidc-key-rotation.md
//  is the runbook, and it is exercised, not just written (0004).
//
//  KID is the first 16 URL-safe base64 characters of the SHA-256 of the
//  public key (SubjectPublicKeyInfo), so the same key always has the same id
//  and the id says nothing about when or where it was made.
// ============================================================================

public static class OidcKeyRing
{
    public static readonly TimeSpan RetiredPublishWindow = TimeSpan.FromDays(1);
    private const int KeySizeBits = 2048;

    private static readonly Regex SigName =
        new(@"^sig-(?<created>\d+)(?:\.retired-(?<retired>\d+))?\.pem$", RegexOptions.Compiled);
    private static readonly Regex EncName =
        new(@"^enc-(?<created>\d+)\.pem$", RegexOptions.Compiled);

    public sealed record LoadedKey(
        string Kid, RsaSecurityKey Key, DateTimeOffset CreatedAt, DateTimeOffset? RetiredAt, string Path);

    public sealed record Ring(IReadOnlyList<LoadedKey> Signing, IReadOnlyList<LoadedKey> Encryption)
    {
        /// <summary>The key that signs: the newest active one. Never null after Load.</summary>
        public LoadedKey Current => Signing.First(k => k.RetiredAt is null);
    }

    /// <summary>
    /// Reads every key in the directory, creating the directory and a first
    /// signing and encryption key when there are none, deleting retired
    /// signing keys past their publish window, and returning the rest newest
    /// first — which is the order OpenIddict prefers them in.
    /// </summary>
    public static Ring Load(string directory, Action<string>? log = null)
    {
        Directory.CreateDirectory(directory);
        TryChmod(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

        var signing = new List<LoadedKey>();
        var encryption = new List<LoadedKey>();
        var now = DateTimeOffset.UtcNow;

        foreach (var path in Directory.EnumerateFiles(directory, "*.pem"))
        {
            var name = System.IO.Path.GetFileName(path);
            if (SigName.Match(name) is { Success: true } s)
            {
                var created = FromUnix(s.Groups["created"].Value);
                DateTimeOffset? retired = s.Groups["retired"].Success ? FromUnix(s.Groups["retired"].Value) : null;
                if (retired is not null && now - retired.Value > RetiredPublishWindow)
                {
                    // Past its window: nothing it signed can still be valid.
                    File.Delete(path);
                    log?.Invoke($"oidc: retired signing key file {name} deleted (older than {RetiredPublishWindow.TotalHours:0}h)");
                    continue;
                }
                signing.Add(Read(path, created, retired));
            }
            else if (EncName.Match(name) is { Success: true } e)
            {
                encryption.Add(Read(path, FromUnix(e.Groups["created"].Value), null));
            }
        }

        if (signing.All(k => k.RetiredAt is not null))
        {
            var (path, kid) = Generate(directory, "sig", now);
            log?.Invoke($"oidc: no active signing key found; generated {kid}");
            signing.Add(Read(path, now, null));
        }
        if (encryption.Count == 0)
        {
            var (path, kid) = Generate(directory, "enc", now);
            log?.Invoke($"oidc: no encryption key found; generated {kid}");
            encryption.Add(Read(path, now, null));
        }

        return new Ring(
            signing.OrderBy(k => k.RetiredAt is not null).ThenByDescending(k => k.CreatedAt).ToList(),
            encryption.OrderByDescending(k => k.CreatedAt).ToList());
    }

    /// <summary>
    /// The runbook's one step: a new active signing key, and the previously
    /// active one marked retired (still published for a day). Returns the new
    /// kid and the retired kid — and nothing else.
    /// </summary>
    public static (string NewKid, string? RetiredKid) Rotate(string directory)
    {
        var ring = Load(directory);
        var now = DateTimeOffset.UtcNow;
        var previous = ring.Signing.FirstOrDefault(k => k.RetiredAt is null);

        // The new key is written BEFORE the old one is marked, so a crash in
        // between leaves two active keys (harmless) rather than none.
        var (_, newKid) = Generate(directory, "sig", now.AddSeconds(1));
        string? retiredKid = null;
        if (previous is not null)
        {
            var created = System.IO.Path.GetFileName(previous.Path)[4..^4];   // sig-<created>.pem
            File.Move(previous.Path,
                System.IO.Path.Combine(directory, $"sig-{created}.retired-{now.ToUnixTimeSeconds()}.pem"));
            retiredKid = previous.Kid;
        }
        return (newKid, retiredKid);
    }

    // ------------------------------------------------------------------
    private static (string Path, string Kid) Generate(string directory, string kind, DateTimeOffset at)
    {
        using var rsa = RSA.Create(KeySizeBits);
        var path = System.IO.Path.Combine(directory, $"{kind}-{at.ToUnixTimeSeconds()}.pem");
        File.WriteAllText(path, rsa.ExportPkcs8PrivateKeyPem() + "\n");
        TryChmod(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        return (path, KidOf(rsa));
    }

    private static LoadedKey Read(string path, DateTimeOffset created, DateTimeOffset? retired)
    {
        var rsa = RSA.Create();
        rsa.ImportFromPem(File.ReadAllText(path));
        var kid = KidOf(rsa);
        return new LoadedKey(kid, new RsaSecurityKey(rsa) { KeyId = kid }, created, retired, path);
    }

    public static string KidOf(RSA rsa) =>
        Base64UrlEncoder.Encode(SHA256.HashData(rsa.ExportSubjectPublicKeyInfo()))[..16];

    private static DateTimeOffset FromUnix(string s) => DateTimeOffset.FromUnixTimeSeconds(long.Parse(s));

    private static void TryChmod(string path, UnixFileMode mode)
    {
        if (OperatingSystem.IsWindows()) return;   // the laptop; production is Linux
        try { File.SetUnixFileMode(path, mode); } catch { /* best effort; the directory's own mode still applies */ }
    }
}
