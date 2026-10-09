using System.Security.Cryptography;
using System.Text.Json;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// A Google service account, held in memory only for as long as it is used.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS CLASS STORES NOTHING. It parses the JSON key Google issues, keeps the
///  private key inside an RSA object that never exports it, and signs with
///  it. Where a key comes FROM - who uploads it, where it rests, how it is
///  encrypted, when it is deleted - is section 9 of the migration design and
///  goes to Mr. Singh before any code does it. Nothing here decides that.
///
///  A key with domain-wide delegation reads every mailbox, calendar and file
///  in a customer's company. So:
///   * ToString() names the account and nothing else - a log line or an
///     exception that formats this object shows the address, not the key;
///   * the JSON text is not kept after parsing; only the RSA object is;
///   * Dispose() releases the key. Callers use `using`.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class GoogleServiceAccount : IDisposable
{
    public const string DefaultTokenUri = "https://oauth2.googleapis.com/token";

    private readonly RSA _key;

    /// <summary>The account's address, e.g. migration@project.iam.gserviceaccount.com.</summary>
    public string ClientEmail { get; }
    /// <summary>Google's id for this key. Not secret; sent as the JWT "kid".</summary>
    public string? KeyId { get; }
    /// <summary>Where tokens are requested. Google's, unless a test says otherwise.</summary>
    public string TokenUri { get; }

    private GoogleServiceAccount(RSA key, string clientEmail, string? keyId, string tokenUri)
    {
        _key = key;
        ClientEmail = clientEmail;
        KeyId = keyId;
        TokenUri = tokenUri;
    }

    /// <summary>
    /// Parses the JSON key file Google issues for a service account. Throws a
    /// message that says what is wrong with the file without quoting it.
    /// </summary>
    public static GoogleServiceAccount FromJson(string json)
    {
        JsonElement root;
        try { root = JsonDocument.Parse(json).RootElement; }
        catch (JsonException) { throw new GoogleKeyFormatException("the key is not JSON"); }

        string? Str(string name) =>
            root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? v.GetString() : null;

        // An OAuth CLIENT secret (client_secret_....json, "installed"/"web") is
        // the commonest wrong file to be handed. Say so by name.
        if (Str("type") != "service_account")
            throw new GoogleKeyFormatException(
                "this is not a service-account key (\"type\" is not \"service_account\"). " +
                "An OAuth client secret will not do: domain-wide delegation needs a service account");

        var email = Str("client_email");
        var pem = Str("private_key");
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(pem))
            throw new GoogleKeyFormatException("the key has no client_email or no private_key");

        var rsa = RSA.Create();
        try { rsa.ImportFromPem(pem); }
        catch (Exception)
        {
            rsa.Dispose();
            throw new GoogleKeyFormatException("the key's private_key is not a readable RSA key");
        }

        return new GoogleServiceAccount(rsa, email, Str("private_key_id"), Str("token_uri") ?? DefaultTokenUri);
    }

    internal byte[] SignRs256(byte[] data) =>
        _key.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

    public override string ToString() => $"Google service account {ClientEmail}";

    public void Dispose() => _key.Dispose();
}

/// <summary>A key file that cannot be used. The message never quotes the file.</summary>
public sealed class GoogleKeyFormatException(string message) : Exception(message);
