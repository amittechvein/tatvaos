using TatvaOS.Api.Shared;

namespace TatvaOS.Tests.Masking;

/// <summary>
/// Runs Mask's rules: what may appear in a log or an audit row in place of a
/// phone number, and how a number is taken out of text we did not write.
///
/// The two SMS provider failure paths cannot be exercised without a provider, so
/// what they do to a number is proved here as pure rules. The "no provider
/// configured" path is proved end to end by tests/notify/test-sms-log-redaction.sh.
///
/// Usage:  dotnet run --project tests/mask
/// Exit:   0 = all assertions passed, 1 = at least one failed.
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
        Console.WriteLine();
        Console.WriteLine("  Mask: a phone number in a log, and in text we did not write");
        Console.WriteLine("  =============================================================");

        // The sender's own spelling: country code and number, no plus.
        const string to = "919876543210";

        Console.WriteLine();
        Console.WriteLine("  PhoneForLog - four digits, whatever went in");
        Ok("the sender's form gives only the last four", Mask.PhoneForLog(to) == "…3210");
        Ok("with a plus and spaces, the same", Mask.PhoneForLog("+91 98765 43210") == "…3210");
        Ok("it does NOT keep the first three, which would be '919': code + first digit",
            !Mask.PhoneForLog(to).Contains("919"));
        Ok("none of the other eight digits survive", !Mask.PhoneForLog(to).Contains("98765"));
        Ok("null, empty and too-short are a bare ellipsis, not a crash",
            Mask.PhoneForLog(null) == "…" && Mask.PhoneForLog("") == "…" && Mask.PhoneForLog("12") == "…");

        Console.WriteLine();
        Console.WriteLine("  ScrubPhone - the number, out of a provider's words");
        var infobip = "{\"requestError\":{\"serviceException\":{\"text\":\"Invalid destination\",\"to\":\"919876543210\"}}}";
        var s1 = Mask.ScrubPhone(infobip, to);
        Ok("Infobip echoes the recipient: the full form is gone", !s1.Contains("919876543210"));
        Ok("...and so is every run of its digits longer than four", !s1.Contains("98765"));
        Ok("...the rest of the body is untouched, because it is the diagnosis", s1.Contains("Invalid destination"));
        Ok("...and the event can still be found", s1.Contains("…3210"));

        var msg91 = "{\"message\":\"Invalid mobile 9876543210\",\"type\":\"error\"}";
        var s2 = Mask.ScrubPhone(msg91, to);
        Ok("MSG91 echoes the NATIONAL form, ten digits: gone too", !s2.Contains("9876543210"));
        Ok("...the verdict field survives", s2.Contains("\"type\":\"error\""));

        var url = "An error occurred sending the request to https://control.msg91.com/api/sendhttp.php?authkey=K&mobiles=919876543210&message=code";
        Ok("an exception that quotes the address loses the number", !Mask.ScrubPhone(url, to).Contains("919876543210"));

        Ok("text with no number in it comes back unchanged", Mask.ScrubPhone("Out of credit.", to) == "Out of credit.");
        Ok("another person's number in the same text is left alone: blunt, not greedy",
            Mask.ScrubPhone("retry 919000000001", to) == "retry 919000000001");
        Ok("null text is empty, null phone changes nothing, neither is a crash",
            Mask.ScrubPhone(null, to) == "" && Mask.ScrubPhone("x 919876543210", null) == "x 919876543210");
        Ok("a 'number' too short to be one is not searched for (it would shred ordinary text)",
            Mask.ScrubPhone("error 1234 at step 1234", "1234") == "error 1234 at step 1234");

        Console.WriteLine();
        Console.WriteLine("  The older masks are unchanged");
        Ok("Phone: +91•••••3210", Mask.Phone("+919876543210") == "+91•••••3210");
        Ok("Email: r•••@gmail.com", Mask.Email("ravi@gmail.com") == "r•••@gmail.com");

        Console.WriteLine();
        Console.WriteLine("  =============================================================");
        Console.WriteLine(failed == 0 ? $"  PASS  {passed} assertions" : $"  FAIL  {failed} of {passed + failed} assertions");
        Console.WriteLine();
        return failed == 0 ? 0 : 1;
    }
}
