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
/// Free and total bytes of the filesystem a path is on, and WHICH filesystem
/// (Volume). Two paths share a filesystem when their Volume ids are equal:
/// exact, where comparing sizes was a guess (Mr. Singh on #420, 10 Oct 2026).
///
/// Volume is the device id "major:minor" of the mount holding the path, read
/// from /proc/self/mountinfo on Linux - NOT the mount point. The API runs in a
/// container where every Docker volume is its own mount point, so by mount
/// point the two volumes on production's ONE disk would read as two
/// filesystems. Judging one disk as two PERMITS a migration whose mail fits
/// and whose Drive files fit but which together do not; judging two disks as
/// one measures both against one disk's free space. Neither error is safe,
/// so the identity has to be exact, and bind mounts of one device share its
/// id. Off Linux (the laptop) it is DriveInfo.Name. Null when nothing useful
/// could be read; only then does the old size comparison decide.
/// </summary>
public sealed record DiskFigures(string Path, long FreeBytes, long TotalBytes, string? Volume = null)
{
    public bool SameFilesystemAs(DiskFigures other) =>
        !string.IsNullOrEmpty(Volume) && !string.IsNullOrEmpty(other.Volume)
            ? string.Equals(Volume, other.Volume, StringComparison.Ordinal)
            : SizesAgreeWith(other);

    /// <summary>
    /// The old guess, kept as the last resort: equal totals and free figures
    /// within 1%. Two separate disks of one size with similar usage pass it,
    /// which is why it no longer decides when a Volume id is known.
    /// </summary>
    public bool SizesAgreeWith(DiskFigures other) =>
        TotalBytes == other.TotalBytes
        && Math.Abs(FreeBytes - other.FreeBytes) <= Math.Max(1, TotalBytes / 100);

    /// <summary>Measures where <paramref name="path"/> lives. Throws if it does not exist.</summary>
    public static DiskFigures Of(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var d = new DriveInfo(full);
        return new DiskFigures(path, d.AvailableFreeSpace, d.TotalSize, VolumeId(full, d));
    }

    /// <summary>
    /// Linux: "major:minor" of the mount that holds the path - the entry of
    /// /proc/self/mountinfo whose mount point is the longest whole-segment
    /// prefix of the path. Elsewhere: DriveInfo.Name. Null if unreadable.
    /// </summary>
    internal static string? VolumeId(string fullPath, DriveInfo? drive = null)
    {
        try
        {
            if (OperatingSystem.IsLinux() && File.Exists("/proc/self/mountinfo"))
            {
                string? best = null; var bestLen = -1;
                foreach (var line in File.ReadLines("/proc/self/mountinfo"))
                {
                    // 36 35 8:0 / /var/mail/vhosts rw,relatime - ext4 /dev/sda rw
                    var f = line.Split(' ');
                    if (f.Length < 5) continue;
                    var mount = f[4].Replace("\\040", " ");
                    if (mount.Length <= bestLen) continue;
                    var prefix = mount.TrimEnd('/') + "/";
                    if (fullPath == mount || fullPath.StartsWith(prefix, StringComparison.Ordinal))
                    { best = f[2]; bestLen = mount.Length; }
                }
                if (best is not null) return best;
            }
            var name = (drive ?? new DriveInfo(fullPath)).Name;
            return string.IsNullOrWhiteSpace(name) ? null : name;
        }
        catch { return null; }
    }
}
