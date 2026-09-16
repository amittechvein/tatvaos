using TatvaOS.Api.Modules.Connect;

namespace TatvaOS.Tests.Share;

/// <summary>
/// Runs ConnectShare's single-sharer rules.
///
/// Usage:  dotnet run --project tests/connect-share
/// Exit:   0 = all assertions passed, 1 = at least one failed.
/// </summary>
internal static class Program
{
    private static readonly string[] CameraAndMic = ["camera", "microphone"];

    private static int Main()
    {
        var t = new Harness();

        Console.WriteLine();
        Console.WriteLine("  ConnectShare — who may start a screen share, and when");
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");

        MultipleModeIsUnchanged(t);
        SingleModeWhileNobodyShares(t);
        SingleModeWhileSomebodyShares(t);
        TheModeNeverWidensThePolicy(t);
        FirstOneWins(t);
        TheBugThisPrevents(t);

        return t.Report();
    }

    private static bool AllSources(string[]? s) => s is null;
    private static bool OnlyCameraAndMic(string[]? s) => s is not null && s.SequenceEqual(CameraAndMic);

    private static void MultipleModeIsUnchanged(Harness t)
    {
        t.Section("multiple mode — today's behaviour, untouched");
        t.Ok("everyone policy: a participant may share", AllSources(ConnectShare.SourcesFor("everyone", "participant")));
        t.Ok("host policy: a participant may not", OnlyCameraAndMic(ConnectShare.SourcesFor("host", "participant")));
        t.Ok("cohost policy: a cohost may", AllSources(ConnectShare.SourcesFor("cohost", "cohost")));
        t.Ok("valid modes are exactly multiple and single",
            ConnectShare.IsValidMode("multiple") && ConnectShare.IsValidMode("single")
            && !ConnectShare.IsValidMode("Single") && !ConnectShare.IsValidMode("") && !ConnectShare.IsValidMode(null));
    }

    private static void SingleModeWhileNobodyShares(Harness t)
    {
        t.Section("single mode, nobody sharing — the room is open to whoever the policy allows");
        t.Ok("everyone policy, participant: may share",
            AllSources(ConnectShare.SourcesInSingleMode("everyone", "participant", isTheSharer: false, someoneIsSharing: false)));
        t.Ok("cohost policy, cohost: may share",
            AllSources(ConnectShare.SourcesInSingleMode("cohost", "cohost", false, false)));
    }

    private static void SingleModeWhileSomebodyShares(Harness t)
    {
        t.Section("single mode, somebody sharing — only the presenter keeps the screen");
        t.Ok("the presenter keeps their grant",
            AllSources(ConnectShare.SourcesInSingleMode("everyone", "participant", isTheSharer: true, someoneIsSharing: true)));
        t.Ok("everyone else: camera and microphone only",
            OnlyCameraAndMic(ConnectShare.SourcesInSingleMode("everyone", "participant", isTheSharer: false, someoneIsSharing: true)));
        t.Ok("even the host, while somebody else presents",
            OnlyCameraAndMic(ConnectShare.SourcesInSingleMode("everyone", "host", false, true)));
    }

    private static void TheModeNeverWidensThePolicy(Harness t)
    {
        t.Section("the mode narrows; it never widens");
        t.Ok("host policy, participant, empty room: still may not share",
            OnlyCameraAndMic(ConnectShare.SourcesInSingleMode("host", "participant", false, false)));
        t.Ok("host policy, guest with no role, empty room: still may not share",
            OnlyCameraAndMic(ConnectShare.SourcesInSingleMode("host", null, false, false)));
    }

    private static void FirstOneWins(Harness t)
    {
        t.Section("first one wins — two people pressing Share in the same second");
        t.Ok("nobody else sharing: the newcomer keeps going",
            !ConnectShare.NewcomerMustStop("user:ravi", ["user:ravi"]));
        t.Ok("an empty list: the newcomer keeps going",
            !ConnectShare.NewcomerMustStop("user:ravi", []));
        t.Ok("somebody else already sharing: the newcomer stops",
            ConnectShare.NewcomerMustStop("user:ravi", ["user:priya", "user:ravi"]));
        t.Ok("identities compare ordinally — case is part of the identity",
            ConnectShare.NewcomerMustStop("user:ravi", ["user:Ravi"]));
    }

    private static void TheBugThisPrevents(Harness t)
    {
        t.Section("the bug this prevents");
        // Before ConnectShareEnforcement, every re-permissioning path computed
        // grants from the POLICY alone. In a single-sharer meeting with a
        // presenter, that re-opens sharing to a bystander. This is the
        // assertion that would have failed.
        var policyOnly = ConnectShare.SourcesFor("everyone", "participant");
        var modeAware = ConnectShare.SourcesInSingleMode("everyone", "participant", false, true);
        t.Ok("policy-only grant for a bystander during a share is NOT the single-mode grant",
            AllSources(policyOnly) && OnlyCameraAndMic(modeAware));
        t.Note("a policy-only re-grant would have let a bystander start a second share");
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
