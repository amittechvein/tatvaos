using System.Net;
using System.Text.Json;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// The API's only way to build a document's file: the render service
/// (apps/render; decision 0011 condition 1; docs/DOCS_SERVER_RENDER_DESIGN.md).
///
/// The input is what the SERVER stored — the document's state and every
/// update after it. Nothing the browser sends reaches the file, the text or
/// the stored state any more (Mr. Singh, 29 Sept 2026).
///
/// A render that fails — the service unreachable, over its 10-second limit,
/// or unable to read the document — throws <see cref="DocsRenderFailed"/>.
/// The caller fails the save and SAYS so; it never falls back to anything
/// the browser sent (Mr. Singh, 30 Sept 2026). The edits themselves are not
/// lost: they are stored as live updates before any save.
///
/// Where the service is: Docs:RenderUrl (default http://render:8080, the
/// compose service on its internal network). No setting disables it.
/// </summary>
public sealed class DocsRenderClient(HttpClient http, IConfiguration config, ILogger<DocsRenderClient> log)
{
    public sealed record Dropped(string Kind, string Name, int Count);
    public sealed record Result(byte[] State, string Html, string Text, IReadOnlyList<Dropped> Dropped, string Schema);

    private sealed record Wire(string? State, string? Html, string? Text, List<Dropped>? Dropped, string? Schema);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The service's own limit is 10 s; this is that plus the network, and no more.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(12);

    private Uri Endpoint => new(new Uri(config["Docs:RenderUrl"] ?? "http://render:8080"), "/render/doc");

    /// <param name="updates">The stored state first (empty = a blank document), then each stored update in seq order.</param>
    public async Task<Result> RenderAsync(IEnumerable<byte[]> updates, CancellationToken ct)
    {
        // A blank document's state is empty; Yjs spells "nothing" as [0, 0].
        var list = updates.Select(u => u.Length == 0 ? new byte[] { 0, 0 } : u).Select(Convert.ToBase64String).ToList();
        HttpResponseMessage res;
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(Timeout);
            res = await http.PostAsJsonAsync(Endpoint, new { updates = list }, Json, cts.Token);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            log.LogWarning("Docs render service unreachable or too slow: {Error}", e.GetType().Name);
            throw new DocsRenderFailed("unavailable");
        }

        using (res)
        {
            if (res.StatusCode == HttpStatusCode.GatewayTimeout) throw new DocsRenderFailed("timeout");
            if (!res.IsSuccessStatusCode) throw new DocsRenderFailed($"status {(int)res.StatusCode}");
            var w = await res.Content.ReadFromJsonAsync<Wire>(Json, ct);
            if (w?.State is null || w.Html is null || w.Text is null) throw new DocsRenderFailed("incomplete answer");
            return new Result(Convert.FromBase64String(w.State), w.Html, w.Text,
                (IReadOnlyList<Dropped>?)w.Dropped ?? [], w.Schema ?? "");
        }
    }
}

public sealed class DocsRenderFailed(string reason) : Exception($"The document's file could not be built ({reason}).")
{
    public string Reason { get; } = reason;
}
