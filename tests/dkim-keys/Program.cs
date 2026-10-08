using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using TatvaOS.Api.Shared.Mail;

namespace TatvaOS.Tests.DkimKeys;

/// <summary>
/// Removing a domain must stop the platform signing for it.
///
/// On 24 September 2026 our signing table listed abc.com — a domain added on
/// 11 September, never verified, never activated, whose real mail goes to
/// Microsoft. The cause: DkimKeyService could only CREATE key files, and
/// OpenDKIM builds its tables by scanning that directory, so a key outlived
/// the domain row for ever.
///
/// Usage: dotnet run --project tests/dkim-keys
/// Exit:  0 all passed, 1 otherwise.
/// </summary>
internal static class Program
{
    private static int passed, failed;

    private static void Ok(string what, bool ok)
    {
        if (ok) { passed++; Console.WriteLine($"    ok  {what}"); }
        else { failed++; Console.WriteLine($"  FAIL  {what}"); }
    }

    private static int Main()
    {
        var dir = Path.Combine(Path.GetTempPath(), "tatvaos-dkim-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var config = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> { ["Dkim:KeyDirectory"] = dir })
                .Build();

            // db and tenant are not touched by ForgetKeys; the point of this
            // test is the file behaviour, and nothing else is reachable
            // without a database.
            var keys = new DkimKeyService(null!, null!, config, NullLogger<DkimKeyService>.Instance);

            File.WriteAllText(Path.Combine(dir, "abc.com.tv2026a.key"), "private");
            File.WriteAllText(Path.Combine(dir, "abc.com.tv2025a.key"), "rotated");     // an older selector
            File.WriteAllText(Path.Combine(dir, "tatvaos.com.tv2026a.key"), "keep me");
            File.WriteAllText(Path.Combine(dir, "notabc.com.tv2026a.key"), "keep me too");

            Console.WriteLine();
            Console.WriteLine("  Removing a domain stops the signer signing for it");
            Console.WriteLine("  ================================================");
            Console.WriteLine();

            keys.ForgetKeys("abc.com");

            Ok("the key is gone", !File.Exists(Path.Combine(dir, "abc.com.tv2026a.key")));
            Ok("an OLDER selector's key is gone too (rotation leaves more than one)",
                !File.Exists(Path.Combine(dir, "abc.com.tv2025a.key")));
            Ok("another domain's key is untouched",
                File.Exists(Path.Combine(dir, "tatvaos.com.tv2026a.key")));
            Ok("a domain whose name merely ENDS with it is untouched",
                File.Exists(Path.Combine(dir, "notabc.com.tv2026a.key")));

            keys.ForgetKeys("abc.com");
            Ok("removing twice is not an error", true);

            keys.ForgetKeys("never-existed.example");
            Ok("a domain with no keys is not an error", true);

            var missing = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                    { ["Dkim:KeyDirectory"] = Path.Combine(dir, "gone") })
                .Build();
            new DkimKeyService(null!, null!, missing, NullLogger<DkimKeyService>.Instance)
                .ForgetKeys("abc.com");
            Ok("a missing key directory is not an error", true);

            Console.WriteLine();
            Console.WriteLine("  ================================================");
            Console.WriteLine(failed == 0 ? $"  PASS  {passed} assertions" : $"  FAIL  {failed} of {passed + failed}");
            Console.WriteLine();
            return failed == 0 ? 0 : 1;
        }
        finally { try { Directory.Delete(dir, true); } catch { /* a temp dir */ } }
    }
}
