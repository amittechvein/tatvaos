// ============================================================================
//  THE MIGRATION'S MAIL SIGN-IN AGAINST DOVECOT IN ITS PRODUCTION MODE
// ============================================================================
//
//  Found 10 Oct 2026, writing the test guide: production Dovecot has
//  disable_plaintext_auth = yes (local/dovecot/entrypoint.sh's overlay), and
//  the migration signed in to dovecot:143 without TLS - so every mail write
//  in production would have been refused at sign-in. The fix: STARTTLS, with
//  the certificate checked against the name it was issued for
//  (Migration:Imap:TlsName), because the API reaches Dovecot as "dovecot".
//
//  Run by tests/migration-mail-tls/test-prod-tls.sh, which starts a Dovecot
//  from the local image with the production overlay applied VERBATIM (TLS on,
//  plaintext sign-in off), a test certificate for mail.tatvaos.test signed by
//  a throwaway CA, and the migration master login on. Expects:
//    TLS_PORT, MASTER_FILE (the master password), CA_FILE, TLS_NAME
//
//  Asserts:
//    * the bug: a plaintext master sign-in is REFUSED by production Dovecot
//    * DovecotAppender as production configures it refuses a certificate
//      whose chain it does not trust (this test CA) - TLS is not switched off
//    * CertificateIsTrusted: valid -> yes; ONLY a name mismatch and valid for
//      TlsName -> yes; a wrong name, a bad chain, both, or no TlsName -> no
//    * over STARTTLS, with the chain trusted (the test CA, standing in for
//      Let's Encrypt) and the name decided by CertificateIsTrusted, the master
//      sign-in works and a message is appended and read back
// ============================================================================

using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Search;
using MailKit.Security;
using Microsoft.Extensions.Configuration;
using MimeKit;
using TatvaOS.Api.Modules.Migration.Mail;

var port = int.Parse(Environment.GetEnvironmentVariable("TLS_PORT") ?? "0");
var masterFile = Environment.GetEnvironmentVariable("MASTER_FILE");
var caFile = Environment.GetEnvironmentVariable("CA_FILE");
var tlsName = Environment.GetEnvironmentVariable("TLS_NAME");
if (port == 0 || masterFile is null || caFile is null || tlsName is null)
{
    Console.WriteLine("  run tests/migration-mail-tls/test-prod-tls.sh");
    return 2;
}
const string Person = "amit@techvein.local";
var master = File.ReadAllText(masterFile).Trim();
using var ca = X509CertificateLoader.LoadCertificateFromFile(caFile);

var passed = 0; var failed = 0;
void Ok(string what) { passed++; Console.WriteLine($"  ok    {what}"); }
void Fail(string what) { failed++; Console.WriteLine($"  FAIL  {what}"); }
void Same<T>(string what, T got, T want)
{
    if (EqualityComparer<T>.Default.Equals(got, want)) Ok($"{what}  [got {got}]");
    else Fail($"{what} - got [{got}], wanted [{want}]");
}
async Task<string> Try(Func<Task> f)
{
    try { await f(); return "ok"; }
    catch (Exception ex) { return ex.GetType().Name; }
}

Console.WriteLine($"\n  Migration mail sign-in, production-mode Dovecot on localhost:{port}");

Console.WriteLine("\n>> the bug: no TLS");
Same("a plaintext master sign-in is refused by production Dovecot",
    await Try(async () =>
    {
        using var c = new ImapClient();
        await c.ConnectAsync("localhost", port, SecureSocketOptions.None);
        await c.AuthenticateAsync($"{Person}*migration", master);
    }),
    "AuthenticationException");

Console.WriteLine("\n>> DovecotAppender as production configures it");
var prodLike = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
{
    ["Migration:Imap:Host"] = "localhost", ["Migration:Imap:Port"] = port.ToString(),
    ["Migration:Imap:Security"] = "starttls", ["Migration:Imap:TlsName"] = tlsName,
}).Build();
Same("a certificate from a CA it does not trust is refused (TLS stays on)",
    await Try(async () => { await using var s = await new DovecotAppender(prodLike).OpenAsync(new MailboxLogin(Person, $"{Person}*migration", master), CancellationToken.None); }),
    "SslHandshakeException");

Console.WriteLine("\n>> CertificateIsTrusted");
using var serverCert = await FetchServerCertAsync();
Same("valid in every way: yes", DovecotAppender.CertificateIsTrusted(serverCert, SslPolicyErrors.None, null), true);
Same("only a name mismatch, valid for TlsName: yes",
    DovecotAppender.CertificateIsTrusted(serverCert, SslPolicyErrors.RemoteCertificateNameMismatch, tlsName), true);
Same("only a name mismatch, NOT valid for TlsName: no",
    DovecotAppender.CertificateIsTrusted(serverCert, SslPolicyErrors.RemoteCertificateNameMismatch, "evil.example.com"), false);
Same("a name mismatch with no TlsName set: no",
    DovecotAppender.CertificateIsTrusted(serverCert, SslPolicyErrors.RemoteCertificateNameMismatch, null), false);
Same("an untrusted chain, name fine: no",
    DovecotAppender.CertificateIsTrusted(serverCert, SslPolicyErrors.RemoteCertificateChainErrors, tlsName), false);
Same("an untrusted chain AND a name mismatch: no",
    DovecotAppender.CertificateIsTrusted(serverCert, SslPolicyErrors.RemoteCertificateChainErrors | SslPolicyErrors.RemoteCertificateNameMismatch, tlsName), false);

Console.WriteLine("\n>> over STARTTLS, chain trusted, name by CertificateIsTrusted");
var folder = $"TlsTest-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}";
var mid = $"tls-{Guid.NewGuid():N}@techvein.local";
string result;
using (var c = new ImapClient())
{
    // The chain against the test CA (production: the system store and Let's
    // Encrypt), then the SAME rule production uses for the name.
    c.ServerCertificateValidationCallback = (_, cert, _, errors) =>
        DovecotAppender.CertificateIsTrusted(cert, TrustChain(cert, errors), tlsName);
    result = await Try(async () =>
    {
        await c.ConnectAsync("localhost", port, SecureSocketOptions.StartTls);
        await c.AuthenticateAsync($"{Person}*migration", master);
        var f = await c.GetFolder(c.PersonalNamespaces[0].Path).CreateAsync(folder, true);
        await f!.OpenAsync(FolderAccess.ReadWrite);
        var msg = new MimeMessage { MessageId = mid, Subject = "tls test" };
        msg.From.Add(MailboxAddress.Parse("t@t.test")); msg.To.Add(MailboxAddress.Parse(Person));
        msg.Body = new TextPart("plain") { Text = "over TLS" };
        await f.AppendAsync(msg);
        var hits = await f.SearchAsync(SearchQuery.HeaderContains("Message-ID", mid));
        if (hits.Count != 1) throw new InvalidOperationException($"{hits.Count} found");
        await f.CloseAsync(); await f.DeleteAsync();
    });
    Same("the encrypted session is TLS", c.IsSecure, true);
}
Same("master sign-in, APPEND and read back over STARTTLS", result, "ok");

Console.WriteLine($"\n  -----------------------------------------------");
if (failed == 0) { Console.WriteLine($"  PASS  {passed} checks\n"); return 0; }
Console.WriteLine($"  FAIL  {failed} of {passed + failed} checks\n"); return 1;

// The certificate Dovecot presents after STARTTLS.
async Task<X509Certificate2> FetchServerCertAsync()
{
    X509Certificate2? got = null;
    using var c = new ImapClient();
    c.ServerCertificateValidationCallback = (_, cert, _, _) => { got = new X509Certificate2(cert!); return true; };
    await c.ConnectAsync("localhost", port, SecureSocketOptions.StartTls);
    await c.DisconnectAsync(true);
    return got!;
}

// Chain errors cleared ONLY when the chain builds to the test CA.
SslPolicyErrors TrustChain(X509Certificate? cert, SslPolicyErrors errors)
{
    if (cert is null) return errors;
    using var leaf = new X509Certificate2(cert);
    using var chain = new X509Chain();
    chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
    chain.ChainPolicy.CustomTrustStore.Add(ca);
    chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
    return chain.Build(leaf) ? errors & ~SslPolicyErrors.RemoteCertificateChainErrors : errors;
}
