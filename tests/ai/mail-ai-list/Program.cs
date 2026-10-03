// Asks MailAiOrganisationList.cs (linked from the API) who may use Mail AI.
// The last line is the verdict: "PASS n" or "FAIL n of m". Exit 1 on failure.
using TatvaOS.Api.Shared.Ai;

var passed = 0;
var failed = 0;
void Check(bool ok, string what)
{
    if (ok) { passed++; Console.WriteLine($"  ok    {what}"); }
    else { failed++; Console.WriteLine($"  FAIL  {what}"); }
}

var techvein = Guid.Parse("11111111-1111-1111-1111-111111111111");
var school = Guid.Parse("22222222-2222-2222-2222-222222222222");

Console.WriteLine("Empty means NONE");
Check(!MailAiOrganisationList.Allows(null, techvein), "no setting at all: nobody");
Check(!MailAiOrganisationList.Allows("", techvein), "empty: nobody");
Check(!MailAiOrganisationList.Allows("   ", techvein), "blank: nobody");
Check(!MailAiOrganisationList.Allows(" , ; \n", techvein), "only separators: nobody");
Check(!MailAiOrganisationList.Allows("not-an-id", techvein), "nothing that is an id: nobody (a typo does not open the gate)");

Console.WriteLine("Everyone only when it says so");
Check(MailAiOrganisationList.Allows("all", techvein), "\"all\": Techvein");
Check(MailAiOrganisationList.Allows("all", school), "\"all\": the school too");
Check(MailAiOrganisationList.Allows("  ALL \n", school), "\"ALL\" with spaces: everyone");
Check(!MailAiOrganisationList.Allows($"all, {techvein}", school),
    "\"all\" mixed into a list is not \"everyone\": the list rules (the school is not on it)");
Check(MailAiOrganisationList.Allows($"all, {techvein}", techvein), "…and Techvein, which is on it, may");
Check(!MailAiOrganisationList.Allows("everyone", school), "\"everyone\" is not the word: nobody");
Check(!MailAiOrganisationList.Allows("*", school), "\"*\" is not the word: nobody");

Console.WriteLine("A list means only those");
Check(MailAiOrganisationList.Allows($"{techvein}", techvein), "Techvein alone: Techvein may");
Check(!MailAiOrganisationList.Allows($"{techvein}", school), "Techvein alone: the school may not");
Check(MailAiOrganisationList.Allows($"not-an-id, {school}", school), "a bad entry beside a good one: the good one counts");

Console.WriteLine();
if (failed == 0) { Console.WriteLine($"PASS {passed}"); return 0; }
Console.WriteLine($"FAIL {failed} of {passed + failed}");
return 1;
