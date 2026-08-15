using System.Buffers.Binary;
using System.Net.Sockets;
using System.Text;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// Speaks clamd's INSTREAM protocol, and nothing else.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY A SOCKET AND NOT A LIBRARY. Scanning means holding a current
///  signature database, which is a gigabyte-scale thing that updates several
///  times a day. That belongs in its own container with its own memory and
///  its own update schedule, not inside the API process. This class is the
///  forty lines of wire protocol needed to ask it a question.
///
///  THE ANSWER IS ONE OF THREE THINGS and "error" is a real answer, not a
///  failure to produce one. A scanner that is down, unreachable or shouting
///  about a size limit has NOT said the file is clean, and recording clean
///  because nothing said otherwise is the exact failure this whole change
///  exists to remove.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class ClamAvScanner(IConfiguration config, ILogger<ClamAvScanner> log)
{
    public const string Clean = "clean";
    public const string Infected = "infected";
    public const string Error = "error";

    /// <summary>host:port, or empty when no scanner is configured.</summary>
    private string Target => (config["Mail:ClamAv"] ?? "").Trim();

    public bool Configured => Target.Length > 0;

    public sealed record Verdict(string Status, string? Signature);

    public async Task<Verdict> ScanAsync(Stream content, CancellationToken ct)
    {
        if (!Configured) return new Verdict(Error, "no scanner configured");

        var host = Target;
        var port = 3310;
        var colon = Target.LastIndexOf(':');
        if (colon > 0 && int.TryParse(Target[(colon + 1)..], out var parsed))
        {
            host = Target[..colon];
            port = parsed;
        }

        // A scan must not be able to hang the worker behind it. Thirty seconds
        // is generous for a message-sized attachment and short enough that a
        // wedged scanner costs one cycle rather than the queue.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));

        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync(host, port, timeout.Token);
            await using var socket = client.GetStream();

            await socket.WriteAsync(Encoding.ASCII.GetBytes("zINSTREAM\0"), timeout.Token);

            var chunk = new byte[8192];
            var header = new byte[4];
            int read;
            while ((read = await content.ReadAsync(chunk, timeout.Token)) > 0)
            {
                // Length prefix is network byte order; the platform's is not.
                BinaryPrimitives.WriteInt32BigEndian(header, read);
                await socket.WriteAsync(header, timeout.Token);
                await socket.WriteAsync(chunk.AsMemory(0, read), timeout.Token);
            }

            // A zero-length chunk is the end of the stream, not a closed socket.
            BinaryPrimitives.WriteInt32BigEndian(header, 0);
            await socket.WriteAsync(header, timeout.Token);
            await socket.FlushAsync(timeout.Token);

            var reply = await ReadReplyAsync(socket, timeout.Token);
            return Interpret(reply);
        }
        catch (Exception ex)
        {
            // Unreachable, refused, timed out, half-spoken: all the same answer.
            // The attachment stays unscanned and is retried, which is the only
            // honest outcome.
            log.LogWarning(ex, "Attachment scan failed against {Target}", Target);
            return new Verdict(Error, ex.GetType().Name);
        }
    }

    private static async Task<string> ReadReplyAsync(NetworkStream socket, CancellationToken ct)
    {
        var buffer = new byte[512];
        var reply = new StringBuilder();
        int n;
        while ((n = await socket.ReadAsync(buffer, ct)) > 0)
        {
            reply.Append(Encoding.ASCII.GetString(buffer, 0, n));
            // clamd terminates a z-command reply with NUL.
            if (Array.IndexOf(buffer, (byte)0, 0, n) >= 0) break;
        }
        return reply.ToString().Trim('\0', '\n', '\r', ' ');
    }

    /// <summary>
    /// "stream: OK" · "stream: Eicar-Test-Signature FOUND" · anything else.
    /// </summary>
    private static Verdict Interpret(string reply)
    {
        if (reply.EndsWith("OK", StringComparison.Ordinal))
            return new Verdict(Clean, null);

        if (reply.EndsWith("FOUND", StringComparison.Ordinal))
        {
            var colon = reply.IndexOf(':');
            var name = colon >= 0
                ? reply[(colon + 1)..^"FOUND".Length].Trim()
                : reply;
            return new Verdict(Infected, name);
        }

        return new Verdict(Error, reply.Length > 0 ? reply : "empty reply");
    }
}
