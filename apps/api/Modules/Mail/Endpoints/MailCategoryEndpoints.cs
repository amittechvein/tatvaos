using Microsoft.EntityFrameworkCore;
using Npgsql;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Mail.Endpoints;

/// <summary>
/// Mail categories — the colour system, owned by the person.
///
/// ─────────────────────────────────────────────────────────────────────────
///  A category is A NAME AND A COLOUR SOMEBODY MADE FOR THEMSELVES. It is not
///  a classification we perform on their behalf. The ruling was that the user
///  creates them and the filter rules that already run at delivery apply them
///  — "from @school.edu, mark it Work" is a sentence a person can write, read
///  back, and disagree with. Nothing in this file infers anything.
///
///  Schema: 0032-mail-categories.sql. Two facts from it govern this file:
///
///   · colour is a TOKEN NAME from a nine-name palette, never a hex value,
///     with a database CHECK behind it. The same nine are listed below and
///     validated here — not because the CHECK is untrusted, but because a
///     CHECK violation reaches the person as a 500 and this reaches them as
///     a sentence.
///
///   · mail.messages.category_id is ON DELETE SET NULL. Deleting a category
///     loses the label and never the mail. The delete endpoint counts the
///     messages first so the confirmation can say how many lose their colour
///     — the same shape as folder deletion saying where the mail goes.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailCategoryEndpoints
{
    /// <summary>
    /// The product's palette, and the same nine the database CHECK allows.
    /// If these two lists ever disagree the database wins and the person sees
    /// a 500, so they are worth keeping in sight of each other:
    /// local/postgres/init/0032-mail-categories.sql.
    /// </summary>
    private static readonly string[] Palette =
        { "purple", "blue", "green", "orange", "yellow", "red", "pink", "cyan", "grey" };

    private const int MaxNameLength = 60;

    /// <summary>
    /// A bulk assign is one statement, so the only real cost of a long list is
    /// the size of the IN clause. Capped so a client bug cannot post fifty
    /// thousand ids and hold a connection open while Postgres plans it.
    /// </summary>
    private const int MaxAssignBatch = 500;

    public static void MapMailCategoryEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/mail/categories")
            .RequireAuthorization("User")
            .WithTags("Mail");

        g.MapGet("", ListAsync);
        g.MapPost("", CreateAsync);
        g.MapPatch("/{id:guid}", UpdateAsync);
        g.MapDelete("/{id:guid}", DeleteAsync);
        g.MapPost("/assign", AssignAsync);
    }

    public sealed record CategoryRequest(string? Name, string? Colour, int? Position);
    public sealed record AssignRequest(Guid[]? MessageIds, Guid? CategoryId);

    // ------------------------------------------------------------------
    //  Read.
    //
    //  Read access, not Full: a delegate who can open a shared mailbox has
    //  to be able to SEE the colours on the mail they are reading, or the
    //  list renders labels they cannot resolve.
    // ------------------------------------------------------------------
    private static async Task<IResult> ListAsync(
        Guid? mailboxId, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await MailboxAccess.ResolveAsync(db, tenant, mailboxId, MailboxAccess.Read, ct);
        if (box is null) return Results.NotFound();

        // One grouped count rather than a count per category. With nine of
        // them the difference is small; with a person who has made forty it
        // is the difference between one query and forty.
        var counts = await db.Messages.AsNoTracking()
            .Where(m => m.MailboxId == box.Id && m.CategoryId != null)
            .GroupBy(m => m.CategoryId!.Value)
            .Select(x => new { CategoryId = x.Key, Count = x.Count() })
            .ToDictionaryAsync(x => x.CategoryId, x => x.Count, ct);

        var categories = await db.MailCategories.AsNoTracking()
            .Where(c => c.MailboxId == box.Id)
            .OrderBy(c => c.Position).ThenBy(c => c.Name)
            .Select(c => new { c.Id, c.Name, c.Colour, c.Position })
            .ToListAsync(ct);

        return Results.Ok(new
        {
            mailboxId = box.Id,
            palette = Palette,
            categories = categories.Select(c => new
            {
                c.Id, c.Name, c.Colour, c.Position,
                messageCount = counts.TryGetValue(c.Id, out var n) ? n : 0,
            }),
        });
    }

    // ------------------------------------------------------------------
    //  Create.
    //
    //  Full access. In a shared mailbox a category is structure that
    //  everyone who opens it lives with, exactly like a folder — so it
    //  takes the same grant folder creation takes.
    // ------------------------------------------------------------------
    private static async Task<IResult> CreateAsync(
        CategoryRequest req, Guid? mailboxId, AppDbContext db, TenantContext tenant,
        CancellationToken ct)
    {
        var box = await MailboxAccess.ResolveAsync(db, tenant, mailboxId, MailboxAccess.Full, ct);
        if (box is null) return Results.NotFound();

        var (name, colour, error) = Clean(req.Name, req.Colour);
        if (name is null || colour is null) return Results.BadRequest(new { error });

        if (await ExistsAsync(db, box.Id, name, null, ct))
            return Results.Conflict(new { error = $"You already have a category called “{name}”." });

        // Appended, not inserted at zero. A new colour arriving at the top of
        // somebody's list every time would reorder a thing they arranged.
        var last = await db.MailCategories.AsNoTracking()
            .Where(c => c.MailboxId == box.Id)
            .Select(c => (int?)c.Position)
            .MaxAsync(ct) ?? -1;

        var category = new MailCategory
        {
            TenantId = box.TenantId,
            MailboxId = box.Id,
            Name = name,
            Colour = colour,
            Position = last + 1,
        };

        db.MailCategories.Add(category);

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            // ux_mail_categories_mailbox_name, on (mailbox_id, lower(name)).
            // The check above lost a race with another tab or another person
            // in a shared mailbox. The index is the mechanism; that check is
            // only there to make the common case a sentence instead of a 500.
            return Results.Conflict(new { error = $"You already have a category called “{name}”." });
        }

        return Results.Ok(new { id = category.Id, name = category.Name, colour = category.Colour, position = category.Position });
    }

    // ------------------------------------------------------------------
    //  Rename, recolour, reorder. Every field optional; absent means
    //  unchanged, so a colour swatch click does not have to resend a name.
    // ------------------------------------------------------------------
    private static async Task<IResult> UpdateAsync(
        Guid id, CategoryRequest req, Guid? mailboxId, AppDbContext db, TenantContext tenant,
        CancellationToken ct)
    {
        var box = await MailboxAccess.ResolveAsync(db, tenant, mailboxId, MailboxAccess.Full, ct);
        if (box is null) return Results.NotFound();

        var category = await db.MailCategories
            .FirstOrDefaultAsync(c => c.Id == id && c.MailboxId == box.Id, ct);
        if (category is null) return Results.NotFound();

        if (req.Name is not null)
        {
            var name = req.Name.Trim();
            if (name.Length is < 1 or > MaxNameLength)
                return Results.BadRequest(new { error = $"A category name is 1 to {MaxNameLength} characters." });

            if (await ExistsAsync(db, box.Id, name, category.Id, ct))
                return Results.Conflict(new { error = $"You already have a category called “{name}”." });

            category.Name = name;
        }

        if (req.Colour is not null)
        {
            var colour = req.Colour.Trim().ToLowerInvariant();
            if (!Palette.Contains(colour))
                return Results.BadRequest(new { error = "That is not one of the nine colours." });

            category.Colour = colour;
        }

        if (req.Position is int position)
            category.Position = position < 0 ? 0 : position;

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            return Results.Conflict(new { error = "You already have a category with that name." });
        }

        return Results.Ok(new { id = category.Id, name = category.Name, colour = category.Colour, position = category.Position });
    }

    // ------------------------------------------------------------------
    //  Delete.
    //
    //  The messages keep their place; only the label goes, by the FK's
    //  ON DELETE SET NULL. The count is returned so the confirmation can
    //  say what is actually lost - "12 messages will lose this colour" is
    //  a sentence someone can decide about. "Delete category?" is not.
    // ------------------------------------------------------------------
    private static async Task<IResult> DeleteAsync(
        Guid id, Guid? mailboxId, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await MailboxAccess.ResolveAsync(db, tenant, mailboxId, MailboxAccess.Full, ct);
        if (box is null) return Results.NotFound();

        var category = await db.MailCategories
            .FirstOrDefaultAsync(c => c.Id == id && c.MailboxId == box.Id, ct);
        if (category is null) return Results.NotFound();

        var affected = await db.Messages
            .CountAsync(m => m.MailboxId == box.Id && m.CategoryId == category.Id, ct);

        db.MailCategories.Remove(category);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { deleted = id, messagesUnlabelled = affected });
    }

    // ------------------------------------------------------------------
    //  Assign, or clear. One statement for the whole selection, because
    //  the list already has bulk selection and colouring forty messages
    //  one request at a time is forty round trips on a school's wifi.
    //
    //  A null categoryId means "remove the colour" - the same endpoint,
    //  because "set it to nothing" is what the person is doing and a
    //  separate DELETE would be a second thing to keep in step.
    // ------------------------------------------------------------------
    private static async Task<IResult> AssignAsync(
        AssignRequest req, Guid? mailboxId, AppDbContext db, TenantContext tenant,
        CancellationToken ct)
    {
        var box = await MailboxAccess.ResolveAsync(db, tenant, mailboxId, MailboxAccess.Full, ct);
        if (box is null) return Results.NotFound();

        var ids = (req.MessageIds ?? Array.Empty<Guid>()).Distinct().ToArray();
        if (ids.Length == 0) return Results.BadRequest(new { error = "No messages were selected." });
        if (ids.Length > MaxAssignBatch)
            return Results.BadRequest(new { error = $"Too many messages at once — {MaxAssignBatch} is the limit." });

        // The category must be one of THIS mailbox's. Without this the id is
        // an unvalidated pointer: the FK would accept any existing category
        // row, and a message would end up wearing a colour from a mailbox its
        // reader cannot see and cannot remove.
        if (req.CategoryId is Guid categoryId)
        {
            var ours = await db.MailCategories.AsNoTracking()
                .AnyAsync(c => c.Id == categoryId && c.MailboxId == box.Id, ct);
            if (!ours) return Results.BadRequest(new { error = "No such category in this mailbox." });
        }

        // Scoped to the mailbox as well as the ids, so a selection carried
        // over from another folder or another mailbox silently updates
        // nothing rather than reaching across.
        var updated = await db.Messages
            .Where(m => m.MailboxId == box.Id && ids.Contains(m.Id))
            .ExecuteUpdateAsync(u => u.SetProperty(m => m.CategoryId, req.CategoryId), ct);

        return Results.Ok(new { updated, categoryId = req.CategoryId });
    }

    // ------------------------------------------------------------------
    private static (string? Name, string? Colour, string? Error) Clean(string? rawName, string? rawColour)
    {
        var name = (rawName ?? "").Trim();
        if (name.Length is < 1 or > MaxNameLength)
            return (null, null, $"A category name is 1 to {MaxNameLength} characters.");

        var colour = (rawColour ?? "").Trim().ToLowerInvariant();
        if (colour.Length == 0) colour = "grey";
        if (!Palette.Contains(colour))
            return (null, null, "That is not one of the nine colours.");

        return (name, colour, null);
    }

    /// <summary>
    /// Case-insensitive, matching ux_mail_categories_mailbox_name, which is on
    /// (mailbox_id, lower(name)). "Work" and "work" are the same category to
    /// the person who made them, and a filter rule pointing at the wrong one
    /// is invisible.
    /// </summary>
    private static Task<bool> ExistsAsync(
        AppDbContext db, Guid mailboxId, string name, Guid? excludeId, CancellationToken ct)
    {
        var lowered = name.ToLower();
        return db.MailCategories.AsNoTracking().AnyAsync(
            c => c.MailboxId == mailboxId
              && c.Name.ToLower() == lowered
              && (excludeId == null || c.Id != excludeId), ct);
    }
}
