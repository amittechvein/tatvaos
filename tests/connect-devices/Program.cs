using TatvaOS.Api.Modules.Connect;

namespace TatvaOS.Tests.Devices;

/// <summary>
/// Runs ConnectCodes' person/device identity rules.
///
/// Usage:  dotnet run --project tests/connect-devices
/// Exit:   0 = all assertions passed, 1 = at least one failed.
/// </summary>
internal static class Program
{
    private static readonly Guid Amit = Guid.Parse("1cb97328-8e96-4f07-ad5f-d1c2e05edb30");
    private static readonly Guid Ravi = Guid.Parse("8df9a183-a487-4c49-9f76-32751365fcf3");

    private static int Main()
    {
        var t = new Harness();

        Console.WriteLine();
        Console.WriteLine("  ConnectCodes: one person, several devices");
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");

        EveryJoinIsItsOwnConnection(t);
        EveryDeviceIsStillThePerson(t);
        ActingOnAPerson(t);
        TheBugThisPrevents(t);

        return t.Report();
    }

    private static void EveryJoinIsItsOwnConnection(Harness t)
    {
        t.Section("device identities — two joins by one account never collide");
        var phone = ConnectCodes.IdentityForUserDevice(Amit);
        var laptop = ConnectCodes.IdentityForUserDevice(Amit);
        t.Ok("two joins get different identities", phone != laptop);
        t.Ok("shape is user:{id}#{8 hex}",
            System.Text.RegularExpressions.Regex.IsMatch(phone, $"^user:{Amit}#[0-9a-f]{{8}}$"));
        var many = Enumerable.Range(0, 200).Select(_ => ConnectCodes.IdentityForUserDevice(Amit)).Distinct().Count();
        t.Ok("200 joins, 200 distinct identities", many == 200);
    }

    private static void EveryDeviceIsStillThePerson(Harness t)
    {
        t.Section("PersonOf — whichever device, the row it belongs to");
        var person = ConnectCodes.IdentityForUser(Amit);
        t.Ok("a device identity maps to the person", ConnectCodes.PersonOf(ConnectCodes.IdentityForUserDevice(Amit)) == person);
        t.Ok("a person identity maps to itself (joins from before this change)", ConnectCodes.PersonOf(person) == person);
        var guest = ConnectCodes.IdentityForGuest(Ravi);
        t.Ok("a guest identity is untouched", ConnectCodes.PersonOf(guest) == guest);
        t.Ok("null and empty are empty, not a crash", ConnectCodes.PersonOf(null) == "" && ConnectCodes.PersonOf("") == "");
    }

    private static void ActingOnAPerson(Harness t)
    {
        t.Section("Answers — who a mute, a removal or a grant reaches");
        var person = ConnectCodes.IdentityForUser(Amit);
        var phone = ConnectCodes.IdentityForUserDevice(Amit);
        var laptop = ConnectCodes.IdentityForUserDevice(Amit);
        var ravi = ConnectCodes.IdentityForUserDevice(Ravi);

        t.Ok("the person reaches the phone", ConnectCodes.Answers(phone, person));
        t.Ok("the person reaches the laptop", ConnectCodes.Answers(laptop, person));
        t.Ok("the person reaches an old-style connection too", ConnectCodes.Answers(person, person));
        t.Ok("a device reaches only itself: phone -> phone", ConnectCodes.Answers(phone, phone));
        t.Ok("a device reaches only itself: phone -/-> laptop", !ConnectCodes.Answers(laptop, phone));
        t.Ok("never somebody else", !ConnectCodes.Answers(ravi, person));
        t.Ok("a guest is reached only by their own identity",
            ConnectCodes.Answers(ConnectCodes.IdentityForGuest(Ravi), ConnectCodes.IdentityForGuest(Ravi))
            && !ConnectCodes.Answers(ConnectCodes.IdentityForGuest(Ravi), person));
        t.Ok("empty on either side reaches nobody",
            !ConnectCodes.Answers(null, person) && !ConnectCodes.Answers(phone, ""));
    }

    private static void TheBugThisPrevents(Harness t)
    {
        t.Section("the morning of 17 Sept — phone evicted when the laptop joined");
        var phone = ConnectCodes.IdentityForUserDevice(Amit);
        var laptop = ConnectCodes.IdentityForUserDevice(Amit);
        t.Note("LiveKit evicts a connection when another joins with the SAME identity");
        t.Ok("phone and laptop no longer present the same identity", phone != laptop);
        t.Ok("…and are still one person to roles and attendance",
            ConnectCodes.PersonOf(phone) == ConnectCodes.PersonOf(laptop));
    }
}

internal sealed class Harness
{
    public int Passed { get; private set; }
    public int Failed { get; private set; }

    public void Section(string title)
    {
        Console.WriteLine();
        Console.WriteLine($"  {title}");
    }

    public void Note(string text) => Console.WriteLine($"        · {text}");

    public void Ok(string what, bool passed)
    {
        if (passed)
        {
            Passed++;
            Console.WriteLine($"    ok  {what}");
        }
        else
        {
            Failed++;
            Console.WriteLine($"  FAIL  {what}");
        }
    }

    public int Report()
    {
        Console.WriteLine();
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");
        Console.WriteLine(Failed == 0
            ? $"  PASS  {Passed} assertions"
            : $"  FAIL  {Failed} of {Passed + Failed} assertions");
        Console.WriteLine();
        return Failed == 0 ? 0 : 1;
    }
}
