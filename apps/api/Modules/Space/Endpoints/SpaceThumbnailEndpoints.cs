using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Net.Http.Headers;
using SkiaSharp;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Space.Endpoints;

/// <summary>
/// GET /api/space/files/{id}/thumbnail — the grid view's image previews.
/// Contract: SPACE_API_DRIVE_ADDENDUM §5. SkiaSharp by decision (2026-08-16):
/// thumbnails decode files uploaded by strangers, and the choice was made on
/// ATTACK SURFACE — Skia's decoder set is narrow and the binding is MIT.
///
/// The three defences, in the order they run:
///  1. a source BYTE cap — a "2 GB png" never reaches the decoder;
///  2. a hard PIXEL-DIMENSION cap read from the image HEADER before any
///     pixel is decoded — a 200 KB PNG can decompress to gigabytes, so the
///     byte cap alone is theatre;
///  3. a decode TIMEOUT as the last belt: past it the request answers 404
///     and the capped-size decode finishes in the background at bounded cost.
///
/// 404 is the single answer for everything that is not a thumbnail — file
/// invisible, not an image, too big, undecodable — deliberately: no oracle
/// for "exists but I may not see it" or "exists but is malformed".
///
/// Thumbnails are DERIVED artefacts cached beside the blob (IBlobStore aux
/// files). The cache key IS the blob key: overwrite writes a new blob key,
/// so a stale thumbnail is structurally impossible, and the ETag hashes the
/// same key so browser caches invalidate for free. Purge deletes aux files
/// with the blob. And per the activity contract: a MACHINE read — this
/// endpoint never records file_activity.
/// </summary>
public static class SpaceThumbnailEndpoints
{
    public static void MapSpaceThumbnailEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGroup("/api/space")
            .RequireAuthorization("User")
            .WithTags("Space")
            .MapGet("/files/{id:guid}/thumbnail", ThumbnailAsync);
    }

    private const int LongestEdge = 256;
    private const string AuxSuffix = "thumb.webp";

    /// <summary>Sources larger than this are never decoded (defence 1).</summary>
    private const long MaxSourceBytes = 64L * 1024 * 1024;

    /// <summary>Pixel caps, read from the header before decoding (defence 2).</summary>
    private const int MaxSourceEdge = 12_000;
    private const long MaxSourcePixels = 50_000_000; // ~50 MP

    /// <summary>The last belt (defence 3).</summary>
    private static readonly TimeSpan DecodeTimeout = TimeSpan.FromSeconds(5);

    private static readonly HashSet<string> ThumbnailableMimes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp",
    };

    private static IResult NotAThumbnail() =>
        Results.Json(new { error = "No thumbnail is available for this file." }, statusCode: 404);

    private static async Task<IResult> ThumbnailAsync(
        Guid id, HttpContext http, AppDbContext db, TenantContext tenant,
        IBlobStore blobs, CancellationToken ct)
    {
        if (tenant.UserId is not Guid) return Results.Unauthorized();

        // Visibility through the DbSet + RLS, same as download. Trashed files
        // keep their thumbnail — the trash view is a listing like any other.
        var file = await db.SpaceFiles.AsNoTracking().FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return NotAThumbnail();
        if (!ThumbnailableMimes.Contains(file.MimeType)) return NotAThumbnail();
        if (file.SizeBytes > MaxSourceBytes) return NotAThumbnail();

        // ETag over the blob key: a new key on every overwrite makes stale
        // impossible; If-None-Match saves the bytes on the common revisit.
        var etag = "\"t" + Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(file.BlobKey)))[..16] + "\"";
        if (http.Request.Headers.IfNoneMatch.ToString().Contains(etag))
            return Results.StatusCode(StatusCodes.Status304NotModified);

        http.Response.Headers.CacheControl = "private, max-age=86400";

        // Cached beside the blob from a previous request?
        var cached = blobs.OpenReadAux(file.BlobKey, AuxSuffix);
        if (cached is not null)
            return Results.File(cached, "image/webp",
                entityTag: new EntityTagHeaderValue(etag));

        // Generate. The source is read fully into memory — bounded by
        // MaxSourceBytes above, and Skia needs random access to it anyway.
        byte[] source;
        await using (var stream = blobs.OpenRead(file.BlobKey))
        {
            if (stream is null) return NotAThumbnail();
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms, ct);
            source = ms.ToArray();
        }

        var work = Task.Run(() => Render(source), ct);
        var finished = await Task.WhenAny(work, Task.Delay(DecodeTimeout, ct));
        if (finished != work)
            // The decode overran the belt. Its cost is already bounded by the
            // pixel caps; we just refuse to make the caller wait for it.
            return NotAThumbnail();

        var thumb = await work;
        if (thumb is null) return NotAThumbnail();

        // Cache for next time — best effort, the response does not depend on it.
        try { await blobs.WriteAuxAsync(file.BlobKey, AuxSuffix, thumb, ct); }
        catch { /* a cold cache costs a re-render, not correctness */ }

        return Results.File(thumb, "image/webp",
            entityTag: new EntityTagHeaderValue(etag));
    }

    /// <summary>
    /// Pure CPU: header first, caps, then decode → resize → webp. Returns
    /// null for anything that will not become a thumbnail.
    /// </summary>
    private static byte[]? Render(byte[] source)
    {
        using var data = SKData.CreateCopy(source);

        // Dimensions from the HEADER — no pixels decoded yet (defence 2).
        using var codec = SKCodec.Create(data);
        if (codec is null) return null;
        var info = codec.Info;
        if (info.Width <= 0 || info.Height <= 0) return null;
        if (info.Width > MaxSourceEdge || info.Height > MaxSourceEdge) return null;
        if ((long)info.Width * info.Height > MaxSourcePixels) return null;

        using var bitmap = SKBitmap.Decode(data);
        if (bitmap is null) return null;

        var scale = Math.Min(1f, (float)LongestEdge / Math.Max(bitmap.Width, bitmap.Height));
        var w = Math.Max(1, (int)(bitmap.Width * scale));
        var h = Math.Max(1, (int)(bitmap.Height * scale));

        // SKSamplingOptions, not SKFilterQuality: the latter was deprecated in
        // SkiaSharp 3 and REMOVED in 4 (we are on 4.151.1). Linear filtering
        // with nearest mipmaps is the equivalent of the old Medium — good
        // enough for a 256px preview and cheap, which matters because this
        // runs on untrusted input.
        using var resized = bitmap.Resize(
            new SKImageInfo(w, h),
            new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Nearest));
        if (resized is null) return null;

        using var image = SKImage.FromBitmap(resized);
        using var encoded = image.Encode(SKEncodedImageFormat.Webp, 80);
        return encoded?.ToArray();
    }
}
