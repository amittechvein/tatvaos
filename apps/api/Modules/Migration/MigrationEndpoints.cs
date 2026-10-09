namespace TatvaOS.Api.Modules.Migration;

/// <summary>
/// The Google migration, as an organisation's own administrator sees it:
/// every enrolled Google address, whom it lands with here, and each data
/// type's progress. Read-only.
///
/// Enrolling and starting are not exposed yet. Enrolling reads the customer's
/// Google directory, which needs their service-account key - design section
/// 9, Mr. Singh's first. Starting before a source can run would only park
/// jobs as "no source in this build".
///
/// Organisation-scoped by the signed-in admin's tenant, and the tables are
/// forced-RLS with EF filters (tests/isolation, "Google migration jobs are
/// isolated"). last_error is shown as stored: the runner writes it from an
/// exception's type and message with key-shaped text blanked.
/// </summary>
public static class MigrationEndpoints
{
    public static void MapMigrationEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/migration")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("/people", async (MigrationEnrolment enrolment, CancellationToken ct) =>
        {
            var people = await enrolment.ProgressAsync(ct);
            return Results.Ok(new
            {
                people,
                totals = new
                {
                    people = people.Count,
                    matched = people.Count(p => p.TargetUserId is not null),
                    jobs = people.Sum(p => p.Types.Count),
                    byState = people.SelectMany(p => p.Types).GroupBy(t => t.State)
                        .ToDictionary(g => g.Key, g => g.Count()),
                    itemsDone = people.SelectMany(p => p.Types).Sum(t => t.ItemsDone),
                    bytesDone = people.SelectMany(p => p.Types).Sum(t => t.BytesDone),
                },
            });
        });
    }
}
