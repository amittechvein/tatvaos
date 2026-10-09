using System.Globalization;
using TatvaOS.Api.Modules.Admin;

namespace TatvaOS.Api.Modules.Migration;

/// <summary>
/// Will it fit? Refuse with a number if not (migration design, section 8).
///
/// ─────────────────────────────────────────────────────────────────────────
///  "A migration that fills the production disk at 2am takes down mail for
///  every customer, not just the one migrating." And Amit does not want to
///  buy another server, which makes this a hard limit, not a nicety.
///
///  Pure: it is handed the report, the disks and the organisation's
///  capacity, and only does arithmetic, so every rule below is tested without
///  Google, a disk or a database (tests/migration-fit).
///
///  THE RULES, each one a separate reason with its numbers:
///
///   1. DISK. Mail lands TWICE (section 7.2: the maildir, and the raw copy in
///      mail.messages), Drive once. What lands must leave the RESERVE free:
///      the larger of 10% of the disk or 5 GiB. If the mail and Space paths
///      are on one filesystem their needs are added together.
///      The reserve is a PROPOSAL for Mr. Singh to confirm or change.
///   2. THE ORGANISATION'S MAIL STORAGE. The mail, counted once (as mailbox
///      quotas count it), within what its mail allocation has left.
///   3. ITS SPACE STORAGE. The Drive files within what Space has left.
///   4. PER-PERSON QUOTA, when the organisation is on per_user storage: each
///      person's mail within their own quota. Named, person by person.
///   5. UNMEASURED PEOPLE make the verdict INCOMPLETE, never "fits": the
///      total is a floor, not a figure, until everyone is counted.
///   6. A CAPACITY NOT GIVEN (null) is NOT CHECKED, and said so in
///      NotChecked - the command-line estimate runs away from the database.
///      A verdict with anything not checked is "incomplete", never "fits".
///
///  Section 7.2's double landing is why rule 1 and rule 2 count mail
///  differently: the disk holds two copies, the customer's quota is charged
///  one. Both are true and both are checked.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MigrationFit
{
    public const long MinimumReserveBytes = 5L * 1024 * 1024 * 1024;
    public const double ReserveFraction = 0.10;

    public static MigrationVerdict Judge(
        MigrationSizeReport report,
        DiskFigures mailDisk,
        DiskFigures spaceDisk,
        StorageAllocator.Capacity? mailCapacity,
        StorageAllocator.Capacity? driveCapacity,
        long? perUserQuotaBytes)
    {
        var reasons = new List<string>();
        var mailOnDisk = report.MailBytes * 2;

        // 1. Disk.
        if (mailDisk.SameFilesystemAs(spaceDisk))
            CheckDisk(reasons, "the mail and Space disk", mailDisk, mailOnDisk + report.DriveBytes,
                $"{Size(report.MailBytes)} of mail stored twice, plus {Size(report.DriveBytes)} of Drive files");
        else
        {
            CheckDisk(reasons, "the mail disk", mailDisk, mailOnDisk, $"{Size(report.MailBytes)} of mail stored twice");
            CheckDisk(reasons, "the Space disk", spaceDisk, report.DriveBytes, $"{Size(report.DriveBytes)} of Drive files");
        }

        // 2, 3. The organisation's storage.
        var notChecked = new List<string>();
        if (mailCapacity is null) notChecked.Add("the organisation's mail storage");
        else if (report.MailBytes > mailCapacity.AvailableBytes)
            reasons.Add($"Mail storage: needs {Size(report.MailBytes)}, the organisation has {Size(mailCapacity.AvailableBytes)} left " +
                        $"({Size(mailCapacity.UsedBytes)} of {Size(mailCapacity.TotalBytes)} used); short by {Size(report.MailBytes - mailCapacity.AvailableBytes)}");
        if (driveCapacity is null) notChecked.Add("the organisation's Space storage");
        else if (report.DriveBytes > driveCapacity.AvailableBytes)
            reasons.Add($"Space storage: needs {Size(report.DriveBytes)}, the organisation has {Size(driveCapacity.AvailableBytes)} left " +
                        $"({Size(driveCapacity.UsedBytes)} of {Size(driveCapacity.TotalBytes)} used); short by {Size(report.DriveBytes - driveCapacity.AvailableBytes)}");

        // 4. Per person.
        var overQuota = new List<PersonSize>();
        if (perUserQuotaBytes is long quota)
        {
            overQuota = report.People.Where(p => p.MailBytes > quota).ToList();
            foreach (var p in overQuota)
                reasons.Add($"{p.Email}: {Size(p.MailBytes)} of mail, over the {Size(quota)} per-person quota by {Size(p.MailBytes - quota)}");
        }

        // 5. Verdict.
        var state = reasons.Count > 0 ? "refused"
                  : report.Unmeasured.Count > 0 || notChecked.Count > 0 ? "incomplete" : "fits";
        if (state == "incomplete" && notChecked.Count > 0)
            reasons.Add($"not checked: {string.Join(", ", notChecked)}");
        if (state == "incomplete" && report.Unmeasured.Count > 0)
            reasons.Add($"{report.Unmeasured.Count} {(report.Unmeasured.Count == 1 ? "person" : "people")} could not be measured; " +
                        "the totals above leave them out, so this is not yet a yes");
        return new MigrationVerdict(state, reasons, overQuota, notChecked);
    }

    private static void CheckDisk(List<string> reasons, string which, DiskFigures disk, long need, string what)
    {
        var reserve = Math.Max(MinimumReserveBytes, (long)(disk.TotalBytes * ReserveFraction));
        var usable = Math.Max(0, disk.FreeBytes - reserve);
        if (need > usable)
            reasons.Add($"Disk ({which}, {disk.Path}): needs {Size(need)} ({what}); {Size(disk.FreeBytes)} free, " +
                        $"{Size(reserve)} of it kept in reserve, so {Size(usable)} usable; short by {Size(need - usable)}");
    }

    /// <summary>Bytes as people read them, in binary units (what df -h shows).</summary>
    public static string Size(long bytes)
    {
        string[] units = ["B", "KiB", "MiB", "GiB", "TiB"];
        double v = Math.Max(0, bytes); var i = 0;
        while (v >= 1024 && i < units.Length - 1) { v /= 1024; i++; }
        return i == 0 ? $"{bytes} B" : v.ToString(v >= 100 ? "0" : "0.0", CultureInfo.InvariantCulture) + " " + units[i];
    }
}

/// <param name="State">"fits", "refused" or "incomplete".</param>
public sealed record MigrationVerdict(
    string State, IReadOnlyList<string> Reasons, IReadOnlyList<PersonSize> OverQuota, IReadOnlyList<string> NotChecked);

/// <summary>
/// Free and total bytes of the filesystem a path is on. Two paths are taken to
/// share a filesystem when their totals are equal and their free figures agree
/// to within 1% - .NET does not expose the filesystem id. Wrongly judging two
/// disks to be one ADDS their needs together, which can only refuse more.
/// </summary>
public sealed record DiskFigures(string Path, long FreeBytes, long TotalBytes)
{
    public bool SameFilesystemAs(DiskFigures other) =>
        TotalBytes == other.TotalBytes
        && Math.Abs(FreeBytes - other.FreeBytes) <= Math.Max(1, TotalBytes / 100);

    /// <summary>Measures where <paramref name="path"/> lives. Throws if it does not exist.</summary>
    public static DiskFigures Of(string path)
    {
        var d = new DriveInfo(System.IO.Path.GetFullPath(path));
        return new DiskFigures(path, d.AvailableFreeSpace, d.TotalSize);
    }
}
