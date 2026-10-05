using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace TatvaOS.Api.Shared.Data;

/// <summary>
/// An operator's change and its audit line commit together, or neither does.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Mr. Singh on PR 355, 30 Sept 2026: "any operator action that changes data
///  writes its audit line in the same transaction, so a refused audit line
///  undoes the change."
///
///  Before this, an operator endpoint saved its change, THEN wrote the audit
///  line. AuditWriter refuses a line that names nobody (AuditActorGuard), and
///  when it did, the request failed with a 500 — but the organisation was
///  already suspended, the plan already changed, the invoice already issued.
///  A change with no record of who made it, and a screen saying it failed.
///
///  Now every operator route is declared with RequireOperator(), which is the
///  operator policy AND this filter AND a marker, in one call, so a route
///  cannot be operator-only without also being transactional. For any request
///  that is not a read (GET, HEAD, OPTIONS) the filter opens a transaction
///  before the endpoint runs and:
///    * commits it only when the endpoint returned without throwing AND with
///      a status below 400 — before the response is written, so a client is
///      never told "done" about something that then failed to commit;
///    * rolls it back on an exception (a refused audit line is one) or on any
///      4xx/5xx, so a request that says it failed changed nothing.
///
///  Code that opens its own transaction joins this one instead
///  (InvoiceIssuer checks Database.CurrentTransaction). A route that must
///  commit part-way — for work outside the database that cannot be undone,
///  such as removing files — declares ManagesOwnTransaction and is skipped.
///
///  At start-up the API logs every operator route that is NOT covered
///  (Report). tests/audit-actor reads that line.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class OperatorWriteTransaction
{
    public const string Policy = "SuperAdmin";

    /// <summary>On every route declared with RequireOperator().</summary>
    public sealed class Marker;

    /// <summary>On a route that commits part-way on purpose; the filter skips it.</summary>
    public sealed class ManagesOwnTransaction;

    /// <summary>The operator policy, the transaction and the marker, together.</summary>
    public static TBuilder RequireOperator<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.RequireAuthorization(Policy);
        builder.AddEndpointFilter(new Filter());
        builder.WithMetadata(new Marker());
        return builder;
    }

    private sealed class Filter : IEndpointFilter
    {
        public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
        {
            var http = context.HttpContext;
            var method = http.Request.Method;
            if (HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method))
                return await next(context);
            if (http.GetEndpoint()?.Metadata.GetMetadata<ManagesOwnTransaction>() is not null)
                return await next(context);

            var db = http.RequestServices.GetRequiredService<AppDbContext>();
            if (db.Database.CurrentTransaction is not null)
                return await next(context);

            await using var tx = await db.Database.BeginTransactionAsync(http.RequestAborted);
            object? result;
            try
            {
                result = await next(context);
            }
            catch
            {
                await tx.RollbackAsync(CancellationToken.None);
                throw;
            }

            var status = result is IStatusCodeHttpResult s ? s.StatusCode ?? StatusCodes.Status200OK : StatusCodes.Status200OK;
            if (status >= 400)
            {
                await tx.RollbackAsync(CancellationToken.None);
                return result;
            }

            await tx.CommitAsync(http.RequestAborted);
            return result;
        }
    }

    /// <summary>
    /// Every route guarded by the operator policy that is not declared with
    /// RequireOperator(): logged at start-up, loudly, by name.
    /// </summary>
    public static void Report(IEnumerable<EndpointDataSource> sources, ILogger log)
    {
        var covered = 0;
        var uncovered = new List<string>();
        foreach (var e in sources.SelectMany(s => s.Endpoints).OfType<RouteEndpoint>())
        {
            var operatorOnly = e.Metadata.GetOrderedMetadata<IAuthorizeData>().Any(a => a.Policy == Policy);
            if (!operatorOnly) continue;
            var methods = e.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? [];
            if (methods.Count > 0 && methods.All(m => HttpMethods.IsGet(m) || HttpMethods.IsHead(m))) continue;
            if (e.Metadata.GetMetadata<Marker>() is not null
                || e.Metadata.GetMetadata<ManagesOwnTransaction>() is not null) covered++;
            else uncovered.Add($"{string.Join(",", methods)} {e.RoutePattern.RawText}");
        }

        if (uncovered.Count == 0)
            log.LogInformation("Operator write transaction: {Covered} operator write route(s) covered, 0 uncovered.", covered);
        else
            log.LogCritical(
                "Operator write transaction: {Count} operator write route(s) are NOT covered — their change and audit line can disagree: {Routes}",
                uncovered.Count, string.Join("; ", uncovered));
    }
}
