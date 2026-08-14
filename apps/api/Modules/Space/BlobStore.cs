using System.Text.RegularExpressions;

namespace TatvaOS.Api.Modules.Space;

/// <summary>
/// Where Space's bytes live, behind an interface so the endpoints never learn
/// the answer. Today it is a filesystem volume (the maildir pattern); moving
/// to S3-compatible object storage later is a new implementation of this
/// interface plus a migration of bytes — NOT a change to the data model,
/// which stores only the opaque key.
/// </summary>
public interface IBlobStore
{
    /// <summary>
    /// A fresh key: {tenant_id}/{yyyy}/{mm}/{uuid4}. Server-generated, never
    /// derived from the uploaded filename (path traversal) and never
    /// deterministic (a delete-and-recreate must not collide). The tenant
    /// prefix makes offboarding, per-tenant audit and a per-tenant migration
    /// to object storage a prefix operation; the date segment keeps any one
    /// directory from growing unbounded on a filesystem.
    /// </summary>
    string NewKey(Guid tenantId);

    /// <summary>
    /// Streams <paramref name="source"/> to the blob and returns the bytes
    /// written. Never buffers the payload in memory. Throws
    /// <see cref="BlobTooLargeException"/> — after removing the partial write —
    /// if the stream exceeds <paramref name="maxBytes"/>: the declared size is
    /// a claim, not a fact, and the cap is enforced on what actually arrives.
    /// </summary>
    Task<long> WriteAsync(string blobKey, Stream source, long maxBytes, CancellationToken ct);

    /// <summary>Open the bytes for reading, or null if the blob is missing.</summary>
    Stream? OpenRead(string blobKey);

    /// <summary>
    /// Remove the blob. Idempotent — a missing blob is not an error, because
    /// the purge path must be safe to re-run after a crash mid-pass.
    /// </summary>
    Task DeleteAsync(string blobKey);
}

/// <summary>The stream outgrew the cap. Caught by the upload endpoint → 413.</summary>
public sealed class BlobTooLargeException(long maxBytes)
    : Exception($"Upload exceeds the {maxBytes} byte limit.")
{
    public long MaxBytes { get; } = maxBytes;
}

/// <summary>
/// Filesystem implementation. Root comes from Space:BlobRoot (default
/// /var/lib/space/blobs — in the container that path is a mounted volume,
/// which MUST be writable by UID 5000: the API runs as vmail. On a Windows
/// dev machine the default maps under the current drive and is created on
/// first use).
///
/// Two invariants hold everything up:
///  - a key is only ever one this class generated: shape-checked by regex
///    before any path is built, and the resolved path is verified to sit
///    under the root. Belt and braces — a key that fails either test never
///    touches the disk.
///  - writes go to a ".part" file first and move into place at the end, so a
///    crash mid-upload leaves debris that is obviously debris, never a blob
///    that looks complete but is not.
/// </summary>
public sealed partial class FileSystemBlobStore : IBlobStore
{
    private readonly string _root;

    public FileSystemBlobStore(IConfiguration config)
    {
        _root = Path.GetFullPath(config["Space:BlobRoot"] ?? "/var/lib/space/blobs");
    }

    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
    private static partial Regex KeyShape();

    public string NewKey(Guid tenantId)
    {
        var now = DateTimeOffset.UtcNow;
        return $"{tenantId:D}/{now:yyyy}/{now:MM}/{Guid.NewGuid():D}";
    }

    private string MapPath(string blobKey)
    {
        if (!KeyShape().IsMatch(blobKey))
            throw new ArgumentException("Malformed blob key.", nameof(blobKey));

        var path = Path.GetFullPath(Path.Combine(_root,
            blobKey.Replace('/', Path.DirectorySeparatorChar)));

        // The regex already forbids traversal; this catches a future editing
        // mistake in the regex rather than trusting it forever.
        if (!path.StartsWith(_root, StringComparison.Ordinal))
            throw new ArgumentException("Blob key escapes the blob root.", nameof(blobKey));

        return path;
    }

    public async Task<long> WriteAsync(string blobKey, Stream source, long maxBytes, CancellationToken ct)
    {
        var path = MapPath(blobKey);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        var part = path + ".part";
        long written = 0;

        try
        {
            await using (var dest = new FileStream(
                part, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize: 81920, useAsync: true))
            {
                var buffer = new byte[81920];
                int read;
                while ((read = await source.ReadAsync(buffer, ct)) > 0)
                {
                    written += read;
                    if (written > maxBytes)
                        throw new BlobTooLargeException(maxBytes);
                    await dest.WriteAsync(buffer.AsMemory(0, read), ct);
                }
            }

            File.Move(part, path);
            return written;
        }
        catch
        {
            // Whatever went wrong — cap, cancellation, disk — the partial
            // write must not survive to be mistaken for content.
            try { if (File.Exists(part)) File.Delete(part); } catch { /* best effort */ }
            throw;
        }
    }

    public Stream? OpenRead(string blobKey)
    {
        var path = MapPath(blobKey);
        return File.Exists(path)
            ? new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
                             bufferSize: 81920, useAsync: true)
            : null;
    }

    public Task DeleteAsync(string blobKey)
    {
        var path = MapPath(blobKey);
        if (File.Exists(path)) File.Delete(path);
        return Task.CompletedTask;
    }
}
