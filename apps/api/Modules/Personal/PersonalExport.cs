using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Family;
using TatvaOS.Api.Modules.Family.Endpoints;
using TatvaOS.Api.Modules.Space;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// Download my data (build plan §4.2, §8): everything a personal account
/// holds, in formats other software reads, as ONE zip streamed straight to
/// the browser — nothing is staged on the server's disk, because a 10 GB
/// account would otherwise need 10 GB of scratch space per download.
///
///   account.json            address, name, when made, plan
///   mail/{folder}/*.eml     every message, the full original (RFC 822)
///   space/{folders}/{name}  every file they own, the bytes as uploaded
///   contacts.vcf            their contacts (the same writer as the Contacts export)
///   calendar/{name}.ics     their calendars' events (iCalendar)
///
/// Open to a SUSPENDED account too (§8: "can sign in to download their
/// data"). Only the caller's own data: every query below is keyed on their
/// user id, not only on the tenant — the house holds strangers.
///
/// Zip entries are written synchronously (ZipArchive has no async writer), so
/// this one response allows synchronous IO; ZipArchiveMode.Create writes a
/// forward-only stream, which is what an HTTP response is.
/// </summary>
public static class PersonalExport
{
    public static async Task WriteAsync(HttpContext http, AppDbContext db, IBlobStore blobs, Guid userId, CancellationToken ct)
    {
        var user = await db.Users.IgnoreQueryFilters().AsNoTracking().FirstAsync(u => u.Id == userId, ct);
        var stamp = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd");
        http.Features.Get<IHttpBodyControlFeature>()!.AllowSynchronousIO = true;
        http.Response.ContentType = "application/zip";
        http.Response.Headers.ContentDisposition = $"attachment; filename=\"tatvaos-{Safe(user.Email)}-{stamp}.zip\"";

        using var zip = new ZipArchive(http.Response.Body, ZipArchiveMode.Create, leaveOpen: true);
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // ---- account.json ---------------------------------------------------
        var plan = await db.Subscriptions.IgnoreQueryFilters().AsNoTracking()
            .Where(s => s.UserId == userId && s.Status != "cancelled")
            .Select(s => s.Plan!.Name).FirstOrDefaultAsync(ct) ?? "Personal Free";
        Text(zip, used, "account.json", JsonSerializer.Serialize(new
        {
            address = user.Email, name = user.DisplayName, created = user.CreatedAt, plan,
            exported = DateTimeOffset.UtcNow,
        }, new JsonSerializerOptions { WriteIndented = true }));

        // ---- mail -----------------------------------------------------------
        var boxes = await db.Mailboxes.IgnoreQueryFilters().AsNoTracking()
            .Where(m => m.UserId == userId).Select(m => m.Id).ToListAsync(ct);
        var folders = await db.Folders.IgnoreQueryFilters().AsNoTracking()
            .Where(f => boxes.Contains(f.MailboxId)).ToDictionaryAsync(f => f.Id, f => f.Name, ct);
        // In pages, so a large mailbox never sits in memory at once.
        const int Page = 200;
        for (var skip = 0; ; skip += Page)
        {
            var page = await db.Messages.IgnoreQueryFilters().AsNoTracking()
                .Where(m => boxes.Contains(m.MailboxId) && m.RawBody != null)
                .OrderBy(m => m.ReceivedAt).ThenBy(m => m.Id)
                .Skip(skip).Take(Page)
                .Select(m => new { m.Id, m.FolderId, m.ReceivedAt, m.Subject, m.RawBody })
                .ToListAsync(ct);
            if (page.Count == 0) break;
            foreach (var m in page)
            {
                var folder = folders.GetValueOrDefault(m.FolderId, "Mail");
                var name = $"{m.ReceivedAt:yyyy-MM-dd HHmm} {Safe(m.Subject ?? "(no subject)", 60)}.eml";
                Text(zip, used, $"mail/{Safe(folder)}/{name}", m.RawBody!);
            }
        }

        // ---- space ----------------------------------------------------------
        var spaceFolders = await db.SpaceFolders.IgnoreQueryFilters().AsNoTracking()
            .Where(f => f.OwnerUserId == userId && f.DeletedAt == null)
            .ToDictionaryAsync(f => f.Id, f => (f.Name, f.ParentFolderId), ct);
        string PathOf(Guid? folderId)
        {
            var parts = new List<string>();
            for (var hops = 0; folderId is Guid id && spaceFolders.TryGetValue(id, out var f) && hops < 64; hops++)
            {
                parts.Insert(0, Safe(f.Name));
                folderId = f.ParentFolderId;
            }
            return string.Join('/', parts);
        }
        var files = await db.SpaceFiles.IgnoreQueryFilters().AsNoTracking()
            .Where(f => f.OwnerUserId == userId && f.DeletedAt == null)
            .Select(f => new { f.Name, f.FolderId, f.BlobKey }).ToListAsync(ct);
        foreach (var f in files)
        {
            using var src = blobs.OpenRead(f.BlobKey);
            if (src is null) continue;          // a missing blob is reported by the blob sweep, not fatal here
            var dir = PathOf(f.FolderId);
            var entry = Unique(used, $"space/{(dir.Length > 0 ? dir + "/" : "")}{Safe(f.Name)}");
            // Stored, not compressed: most of Space is photos, PDFs and
            // office files that are compressed already, and squeezing 10 GB
            // again on a four-core server buys nothing but load.
            using var dst = zip.CreateEntry(entry, CompressionLevel.NoCompression).Open();
            await src.CopyToAsync(dst, ct);
        }

        // ---- contacts -------------------------------------------------------
        var records = await ImportExportEndpoints.BuildRecordsAsync(
            db, db.Contacts.IgnoreQueryFilters().Where(c => c.OwnerUserId == userId && c.DeletedAt == null), ct);
        if (records.Count > 0)
        {
            var sb = new StringBuilder();
            foreach (var r in records) VCard.Append(sb, r);
            Text(zip, used, "contacts.vcf", sb.ToString());
        }

        // ---- calendar -------------------------------------------------------
        var calendars = await db.Calendars.IgnoreQueryFilters().AsNoTracking()
            .Where(c => c.OwnerUserId == userId && c.DeletedAt == null)
            .Select(c => new { c.Id, c.Name }).ToListAsync(ct);
        foreach (var c in calendars)
        {
            var events = await db.CalendarEvents.IgnoreQueryFilters().AsNoTracking()
                .Where(e => e.CalendarId == c.Id && e.DeletedAt == null)
                .OrderBy(e => e.StartsAt).ToListAsync(ct);
            var ics = new StringBuilder("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//TatvaOS//Export//EN\r\n");
            foreach (var e in events)
            {
                ics.Append("BEGIN:VEVENT\r\n")
                   .Append("UID:").Append(e.Id).Append("@tatvaos.com\r\n")
                   .Append("DTSTAMP:").Append(Ics(e.UpdatedAt)).Append("\r\n")
                   .Append(e.IsAllDay
                        ? $"DTSTART;VALUE=DATE:{e.StartsAt:yyyyMMdd}\r\nDTEND;VALUE=DATE:{e.EndsAt:yyyyMMdd}\r\n"
                        : $"DTSTART:{Ics(e.StartsAt)}\r\nDTEND:{Ics(e.EndsAt)}\r\n")
                   .Append("SUMMARY:").Append(IcsText(e.Title)).Append("\r\n");
                if (!string.IsNullOrWhiteSpace(e.Location)) ics.Append("LOCATION:").Append(IcsText(e.Location)).Append("\r\n");
                if (!string.IsNullOrWhiteSpace(e.Description)) ics.Append("DESCRIPTION:").Append(IcsText(e.Description)).Append("\r\n");
                if (!string.IsNullOrWhiteSpace(e.RecurrenceRule)) ics.Append("RRULE:").Append(e.RecurrenceRule).Append("\r\n");
                ics.Append("END:VEVENT\r\n");
            }
            ics.Append("END:VCALENDAR\r\n");
            Text(zip, used, $"calendar/{Safe(c.Name)}.ics", ics.ToString());
        }
    }

    private static void Text(ZipArchive zip, HashSet<string> used, string path, string content)
    {
        using var w = new StreamWriter(zip.CreateEntry(Unique(used, path), CompressionLevel.Fastest).Open(), new UTF8Encoding(false));
        w.Write(content);
    }

    /// <summary>Two files with one name (Drive allows it) get " (2)", " (3)"… rather than one overwriting the other.</summary>
    private static string Unique(HashSet<string> used, string path)
    {
        if (used.Add(path)) return path;
        var ext = Path.GetExtension(path);
        var stem = path[..^ext.Length];
        for (var n = 2; ; n++)
            if (used.Add($"{stem} ({n}){ext}")) return $"{stem} ({n}){ext}";
    }

    /// <summary>A name safe as ONE path segment on every OS: no slashes, no dots-only, no control characters.</summary>
    private static string Safe(string name, int max = 120)
    {
        var s = new string(name.Select(ch => char.IsControl(ch) || "/\\:*?\"<>|".Contains(ch) ? '_' : ch).ToArray()).Trim().Trim('.');
        if (s.Length == 0) s = "_";
        return s.Length > max ? s[..max] : s;
    }

    private static string Ics(DateTimeOffset t) => t.UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'");
    private static string IcsText(string s) =>
        s.Replace("\\", "\\\\").Replace(";", "\\;").Replace(",", "\\,").Replace("\r\n", "\\n").Replace("\n", "\\n");
}
