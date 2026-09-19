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
        WhoAMuteAllReaches(t);

        return t.Report();
    }

    /// <summary>
    /// Amit, 19 Sept 2026: "give mute all button in meeting only guest". What is
    /// proved here is WHO the press reaches; that LiveKit then mutes them is the
    /// single Mute's own path (MuteDeviceAsync), unchanged.
    /// </summary>
    private static void WhoAMuteAllReaches(Harness t)
    {
        t.Section("MuteAllTargets — who one press reaches");

        var host = ConnectCodes.IdentityForUser(Amit);
        var hostPhone = ConnectCodes.IdentityForUserDevice(Amit);
        var hostLaptop = ConnectCodes.IdentityForUserDevice(Amit);
        var colleague = ConnectCodes.IdentityForUserDevice(Ravi);
        var guestA = ConnectCodes.IdentityForGuest(Guid.NewGuid());
        var guestB = ConnectCodes.IdentityForGuest(Guid.NewGuid());
        var room = new string?[] { hostPhone, hostLaptop, colleague, guestA, guestB, null, "" };
        var spared = new HashSet<string>(StringComparer.Ordinal) { host };

        t.Ok("IsGuest knows a guest", ConnectCodes.IsGuest(guestA));
        t.Ok("IsGuest: a colleague, a device, null and empty are not guests",
            !ConnectCodes.IsGuest(host) && !ConnectCodes.IsGuest(colleague)
            && !ConnectCodes.IsGuest(null) && !ConnectCodes.IsGuest(""));
        t.Ok("IsGuest reads the PREFIX: a name containing 'guest:' is not one",
            !ConnectCodes.IsGuest("user:guest:123"));

        var guests = ConnectCodes.MuteAllTargets(room, ConnectCodes.MuteAllGuests, spared);
        t.Ok("'guests' reaches both guests and nobody else",
            guests.Count == 2 && guests.Contains(guestA) && guests.Contains(guestB));

        var everyone = ConnectCodes.MuteAllTargets(room, ConnectCodes.MuteAllEveryone, spared);
        t.Ok("'everyone' reaches the guests and the colleague",
            everyone.Count == 3 && everyone.Contains(colleague) && everyone.Contains(guestA) && everyone.Contains(guestB));
        t.Ok("'everyone' spares the host on BOTH devices",
            !everyone.Contains(hostPhone) && !everyone.Contains(hostLaptop));

        var nobodySpared = ConnectCodes.MuteAllTargets(room, ConnectCodes.MuteAllEveryone, new HashSet<string>());
        t.Ok("…and it is the spared set doing that: empty it and the host is reached",
            nobodySpared.Count == 5 && nobodySpared.Contains(hostPhone) && nobodySpared.Contains(hostLaptop));

        var unknown = ConnectCodes.MuteAllTargets(room, "colleagues", spared);
        t.Ok("an unknown 'who' falls to the narrow reading, guests only, never wider",
            unknown.Count == 2 && !unknown.Contains(colleague));

        t.Ok("an empty room is nobody, not a crash",
            ConnectCodes.MuteAllTargets(Array.Empty<string?>(), ConnectCodes.MuteAllEveryone, spared).Count == 0);
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
