using TatvaOS.Api.Shared.Google;

namespace TatvaOS.Api.Modules.Migration;

/// <summary>
/// How much a Google Workspace would bring with it, per person - measured,
/// nothing migrated (migration design, section 8: "the estimate is the first
/// thing worth building and the first thing Amit will want to see").
///
/// One directory listing as an admin, then one storage question per person
/// (GoogleWorkspaceClient explains the arithmetic and which way it errs).
/// A person Google will not answer for is listed as UNMEASURED with the
/// reason - never counted as zero. Zero would make the total smaller and the
/// verdict friendlier, which is the wrong direction for this check to fail.
/// </summary>
public sealed class MigrationSizeEstimator(GoogleWorkspaceClient google)
{
    public async Task<MigrationSizeReport> MeasureAsync(
        GoogleServiceAccount account, string admin, CancellationToken ct) =>
        await MeasureAsync(account, await google.ListUsersAsync(account, admin, ct), ct);

    /// <summary>
    /// Only the people named - no directory listing, so no admin and nobody
    /// else's data touched. For a trial on one test mailbox, and for checking
    /// a person before starting their migration.
    /// </summary>
    public Task<MigrationSizeReport> MeasurePeopleAsync(
        GoogleServiceAccount account, IEnumerable<string> people, CancellationToken ct) =>
        MeasureAsync(account, people.Select(p => new GoogleDirectoryUser(p.Trim(), false, false)).ToList(), ct);

    private async Task<MigrationSizeReport> MeasureAsync(
        GoogleServiceAccount account, IReadOnlyList<GoogleDirectoryUser> users, CancellationToken ct)
    {
        var measured = new List<PersonSize>();
        var notMigrated = new List<PersonNote>();
        var unmeasured = new List<PersonNote>();

        foreach (var u in users.OrderBy(u => u.PrimaryEmail, StringComparer.OrdinalIgnoreCase))
        {
            if (u.Suspended || u.Archived)
            {
                notMigrated.Add(new(u.PrimaryEmail, u.Suspended ? "suspended in Google" : "archived in Google"));
                continue;
            }
            try
            {
                var usage = await google.GetStorageUsageAsync(account, u.PrimaryEmail, ct);
                measured.Add(new(u.PrimaryEmail, usage.MailBytes, usage.DriveBytes));
            }
            catch (Exception ex) when (ex is GoogleApiException or GoogleAuthException)
            {
                // Both exception types carry no token and no key (see their
                // own comments), so the message is safe to show and store.
                unmeasured.Add(new(u.PrimaryEmail, ex.Message));
            }
            catch (Exception ex) when (ex is HttpRequestException
                                       || (ex is TaskCanceledException && !ct.IsCancellationRequested))
            {
                // The network, not Google's answer: a connection refused or a
                // timeout. Named by type only - an HttpRequestException's
                // message can carry the URL, and the URL is the person's address.
                unmeasured.Add(new(u.PrimaryEmail, $"Google could not be reached ({ex.GetType().Name})"));
            }
        }

        return new MigrationSizeReport(measured, notMigrated, unmeasured);
    }
}

public sealed record PersonSize(string Email, long MailBytes, long DriveBytes);
public sealed record PersonNote(string Email, string Reason);

public sealed record MigrationSizeReport(
    IReadOnlyList<PersonSize> People,
    IReadOnlyList<PersonNote> NotMigrated,
    IReadOnlyList<PersonNote> Unmeasured)
{
    public long MailBytes => People.Sum(p => p.MailBytes);
    public long DriveBytes => People.Sum(p => p.DriveBytes);
}
