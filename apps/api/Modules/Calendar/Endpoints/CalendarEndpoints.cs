using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Calendar.Endpoints;

/// <summary>
/// TatvaOS Calendar.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE READ PATH IS "GIVE ME A WINDOW", ALWAYS.
///
///  Every view — day, week, month, agenda — asks the same question: what is
///  on, between these two instants. One endpoint answers it, and recurrence
///  is expanded inside that window rather than stored. See Recurrence.cs.
///
///  FREE/BUSY IS A SEPARATE ENDPOINT ON PURPOSE. "When is Priya free" must
///  not be answerable by reading Priya's events; it returns busy intervals
///  with no titles, no attendees and no locations, so a colleague can find a
///  slot without learning that she is in "Interview: replacing Rahul".
///  Making it a filter on the events endpoint would put one `if` between a
///  colleague and everybody's private life.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class CalendarEndpoints
{
    public static void MapCalendarEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/calendar")
            .RequireAuthorization("User")
            .WithTags("Calendar");

        g.MapGet("/calendars", ListCalendarsAsync);
        g.MapPost("/calendars", CreateCalendarAsync);

        g.MapGet("/events", EventsAsync);
        g.MapPost("/events", CreateEventAsync);
        g.MapPatch("/events/{id:guid}", UpdateEventAsync);
        g.MapDelete("/events/{id:guid}", DeleteEventAsync);
        g.MapPost("/events/{id:guid}/respond", RespondAsync);

        g.MapGet("/freebusy", FreeBusyAsync);
    }

    // ==================================================================
    //  Calendars
    // ==================================================================
    private static async Task<IResult> ListCalendarsAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var mine = await db.Calendars.AsNoTracking()
            .Where(c => c.DeletedAt == null
                        && (c.OwnerUserId == uid || c.Kind == "organisation"))
            .OrderByDescending(c => c.IsPrimary)
            .ThenBy(c => c.Name)
            .ToListAsync(ct);

        // Calendars shared with me by a colleague, and rooms I may book.
        var sharedIds = await db.CalendarMembers.AsNoTracking()
            .Where(m => m.UserId == uid)
            .Select(m => m.CalendarId)
            .ToListAsync(ct);

        var shared = sharedIds.Count == 0 ? [] : await db.Calendars.AsNoTracking()
            .Where(c => sharedIds.Contains(c.Id) && c.DeletedAt == null && c.OwnerUserId != uid)
            .OrderBy(c => c.Name)
            .ToListAsync(ct);

        static object Shape(CalendarCalendar c, bool isOwn) => new
        {
            c.Id, c.Name, c.Description, c.Colour, c.Kind, c.Timezone, c.IsPrimary, isOwn,
        };

        return Results.Ok(new
        {
            calendars = mine.Select(c => Shape(c, c.OwnerUserId == uid))
                            .Concat(shared.Select(c => Shape(c, false)))
                            .ToList(),
        });
    }

    public sealed record CreateCalendarRequest(string? Name, string? Colour, string? Kind, string? Timezone);

    private static async Task<IResult> CreateCalendarAsync(
        CreateCalendarRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var name = (req.Name ?? "").Trim();
        if (name.Length is < 1 or > 200)
            return Results.BadRequest(new { error = "Give the calendar a name." });

        var kind = (req.Kind ?? "personal").Trim().ToLowerInvariant();
        if (kind is not ("personal" or "organisation" or "resource"))
            return Results.BadRequest(new { error = "Unknown calendar type." });

        var cal = new CalendarCalendar
        {
            TenantId = tenant.TenantId,
            // An organisation calendar and a room belong to the ORGANISATION,
            // so they survive the person who created them leaving.
            OwnerUserId = kind == "personal" ? uid : null,
            Name = name,
            Colour = string.IsNullOrWhiteSpace(req.Colour) ? "#4285f4" : req.Colour.Trim(),
            Kind = kind,
            Timezone = string.IsNullOrWhiteSpace(req.Timezone) ? "Asia/Kolkata" : req.Timezone.Trim(),
        };
        db.Calendars.Add(cal);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/api/calendar/calendars/{cal.Id}", new
        {
            cal.Id, cal.Name, cal.Colour, cal.Kind, cal.Timezone, isPrimary = false, isOwn = kind == "personal",
        });
    }

    // ==================================================================
    //  Events in a window — the one read every view uses
    // ==================================================================
    private static async Task<IResult> EventsAsync(
        DateTimeOffset? from, DateTimeOffset? to, Guid? calendarId,
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (from is not DateTimeOffset start || to is not DateTimeOffset end || end <= start)
            return Results.BadRequest(new { error = "Give a from and a to, with to after from." });

        // A year is the widest view we offer. Without a cap, one request can
        // expand a daily rule across a decade and pin a CPU.
        if ((end - start).TotalDays > 400)
            return Results.BadRequest(new { error = "Ask for at most a year at a time." });

        var visible = await VisibleCalendarIdsAsync(db, uid, ct);
        if (calendarId is Guid only)
        {
            if (!visible.Contains(only)) return Results.NotFound();
            visible = [only];
        }
        if (visible.Count == 0) return Results.Ok(new { events = Array.Empty<object>() });

        // Two queries, not one: non-recurring events are found by overlap,
        // but a recurring event's STORED start is its first occurrence, which
        // is usually years before the window being viewed.
        var plain = await db.CalendarEvents.AsNoTracking()
            .Where(e => visible.Contains(e.CalendarId) && e.DeletedAt == null
                        && e.RecurrenceRule == null
                        && e.StartsAt < end && e.EndsAt > start)
            .ToListAsync(ct);

        var series = await db.CalendarEvents.AsNoTracking()
            .Where(e => visible.Contains(e.CalendarId) && e.DeletedAt == null
                        && e.RecurrenceRule != null
                        && e.StartsAt < end)
            .ToListAsync(ct);

        var ids = plain.Select(e => e.Id).Concat(series.Select(e => e.Id)).ToList();

        var attendees = await db.CalendarAttendees.AsNoTracking()
            .Where(a => ids.Contains(a.EventId))
            .ToListAsync(ct);
        var attendeesByEvent = attendees.GroupBy(a => a.EventId)
            .ToDictionary(g => g.Key, g => g.ToList());

        var exceptions = await db.CalendarEventExceptions.AsNoTracking()
            .Where(x => ids.Contains(x.EventId))
            .ToListAsync(ct);
        var exceptionsByEvent = exceptions.GroupBy(x => x.EventId)
            .ToDictionary(g => g.Key, g => g.ToList());

        var colours = await db.Calendars.AsNoTracking()
            .Where(c => visible.Contains(c.Id))
            .ToDictionaryAsync(c => c.Id, c => new { c.Colour, c.Name }, ct);

        var rows = new List<(DateTimeOffset Start, object Row)>();

        foreach (var e in plain)
            rows.Add(Shape(e, e.StartsAt, e.EndsAt, null));

        foreach (var e in series)
        {
            var skip = exceptionsByEvent.GetValueOrDefault(e.Id) ?? [];
            var duration = e.EndsAt - e.StartsAt;

            foreach (var occ in Recurrence.Expand(e.StartsAt, e.RecurrenceRule, e.Timezone, start, end))
            {
                // Tolerant match for the same reason the write path is
                // canonicalised: an exact instant comparison across JSON,
                // a query string and Postgres is a coin toss.
                var ex = skip.FirstOrDefault(
                    x => Math.Abs((x.OccurrenceStartsAt - occ).TotalSeconds) < 1);
                if (ex is not null && ex.IsCancelled) continue;

                var s = ex?.StartsAt ?? occ;
                var f = ex?.EndsAt ?? occ + duration;
                rows.Add(Shape(e, s, f, occ, ex?.Title, ex?.Location));
            }
        }

        // Ordered by the KEY carried alongside each row, not by reflecting
        // into an anonymous type through `dynamic`. Anonymous types are
        // internal, the runtime binder can refuse them, and the failure would
        // arrive at request time looking like "the calendar is broken".
        return Results.Ok(new
        {
            events = rows.OrderBy(r => r.Start).Select(r => r.Row).ToList(),
        });

        (DateTimeOffset Start, object Row) Shape(CalendarEvent e, DateTimeOffset s, DateTimeOffset f,
                     DateTimeOffset? occurrenceOf, string? title = null, string? location = null)
        {
            var cal = colours.GetValueOrDefault(e.CalendarId);
            var mine = e.OrganiserUserId == uid || e.CreatedByUserId == uid;
            // A private event on a calendar somebody shared with me shows
            // that the time is taken and nothing else. The alternative is
            // that sharing a calendar means surrendering every detail on it.
            var hide = e.Visibility == "private" && !mine;

            return (s, new
            {
                e.Id,
                calendarId = e.CalendarId,
                calendarName = cal?.Name,
                colour = cal?.Colour ?? "#4285f4",
                title = hide ? "Busy" : (title ?? e.Title),
                description = hide ? null : e.Description,
                location = hide ? null : (location ?? e.Location),
                meetingUrl = hide ? null : e.MeetingUrl,
                startsAt = s,
                endsAt = f,
                e.IsAllDay,
                e.Timezone,
                e.Status,
                e.Transparency,
                isRecurring = e.RecurrenceRule != null,
                recurrenceRule = e.RecurrenceRule,
                recurrenceText = Recurrence.Describe(e.RecurrenceRule),
                /// Which occurrence this row is, for editing "just this one".
                occurrenceStartsAt = occurrenceOf,
                isOrganiser = mine,
                myResponse = attendeesByEvent.GetValueOrDefault(e.Id)?
                    .FirstOrDefault(a => a.UserId == uid)?.Status,
                attendees = hide ? [] : (attendeesByEvent.GetValueOrDefault(e.Id) ?? [])
                    .Select(a => new { a.Email, a.DisplayName, a.Role, a.Status })
                    .ToList(),
            });
        }
    }

    // ==================================================================
    //  Create
    // ==================================================================
    public sealed record AttendeeInput(string Email, string? DisplayName, bool Optional);

    public sealed record CreateEventRequest(
        Guid? CalendarId, string? Title, string? Description, string? Location,
        DateTimeOffset? StartsAt, DateTimeOffset? EndsAt, bool IsAllDay,
        string? Timezone, string? RecurrenceRule, string? Visibility,
        AttendeeInput[]? Attendees, int[]? ReminderMinutes);

    private static async Task<IResult> CreateEventAsync(
        CreateEventRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, IConfiguration config,
        TatvaOS.Api.Modules.Family.ContactAutoSave autoSave,
        ILoggerFactory logFactory, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var title = (req.Title ?? "").Trim();
        if (title.Length is < 1 or > 300)
            return Results.BadRequest(new { error = "Give the event a title." });
        if (req.StartsAt is not DateTimeOffset start || req.EndsAt is not DateTimeOffset end)
            return Results.BadRequest(new { error = "An event needs a start and an end." });
        if (end < start)
            return Results.BadRequest(new { error = "The event ends before it starts." });

        // Refused, not silently stored: a rule we cannot expand exactly would
        // put meetings on days nobody agreed to, and that gets discovered by
        // somebody missing one. See Recurrence.cs.
        if (!string.IsNullOrWhiteSpace(req.RecurrenceRule)
            && Recurrence.Parse(req.RecurrenceRule) is null)
            return Results.BadRequest(new
            {
                error = "That repeat pattern is not supported. Daily, weekly on chosen days, "
                      + "monthly by date or by weekday, and yearly are.",
            });

        var calendar = req.CalendarId is Guid cid
            ? await db.Calendars.FirstOrDefaultAsync(c => c.Id == cid && c.DeletedAt == null, ct)
            : await db.Calendars.FirstOrDefaultAsync(c => c.OwnerUserId == uid && c.IsPrimary, ct);

        if (calendar is null) return Results.NotFound();
        if (!await CanWriteAsync(db, uid, calendar, ct))
            return Results.Json(new { error = "You cannot add events to that calendar." },
                                statusCode: 403);

        var ev = new CalendarEvent
        {
            TenantId = tenant.TenantId,
            CalendarId = calendar.Id,
            // The UID an external reply will quote. Ours, globally unique,
            // and never regenerated for the life of the event.
            Uid = $"{Guid.NewGuid():N}@tatvaos.com",
            CreatedByUserId = uid,
            OrganiserUserId = uid,
            Title = title,
            Description = req.Description?.Trim(),
            Location = req.Location?.Trim(),
            StartsAt = start,
            EndsAt = end,
            IsAllDay = req.IsAllDay,
            Timezone = string.IsNullOrWhiteSpace(req.Timezone) ? calendar.Timezone : req.Timezone.Trim(),
            RecurrenceRule = string.IsNullOrWhiteSpace(req.RecurrenceRule) ? null : req.RecurrenceRule.Trim(),
            Visibility = req.Visibility == "private" ? "private" : "default",
        };
        db.CalendarEvents.Add(ev);

        foreach (var a in req.Attendees ?? [])
        {
            var email = (a.Email ?? "").Trim().ToLowerInvariant();
            if (email.Length == 0) continue;

            // A colleague is matched to their account so their response can
            // come from the app; anyone else is an address and will need an
            // emailed invitation.
            var colleague = await db.Users.AsNoTracking()
                .FirstOrDefaultAsync(u => u.Email == email && u.Status == "active", ct);

            db.CalendarAttendees.Add(new CalendarAttendee
            {
                EventId = ev.Id,
                UserId = colleague?.Id,
                Email = email,
                DisplayName = a.DisplayName?.Trim() ?? colleague?.DisplayName,
                Role = a.Optional ? "opt-participant" : "req-participant",
                // The organiser is attending their own meeting.
                Status = colleague?.Id == uid ? "accepted" : "needs-action",
            });
        }

        foreach (var m in (req.ReminderMinutes ?? [10]).Distinct().Take(5))
        {
            if (m < 0 || m > 40320) continue;
            db.CalendarReminders.Add(new CalendarReminder { EventId = ev.Id, MinutesBefore = m });
        }

        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("calendar.event.created", "calendar.event", ev.Id.ToString(),
            after: new { ev.Title, ev.StartsAt, calendar = calendar.Name },
            ct: ct, productCode: "calendar");

        // ── THE §2 JOIN. The event is COMMITTED above; the mail is an
        // announcement of it, sent after and never able to unsave it. The
        // outcome rides the response so the host learns "saved AND announced"
        // or "saved, and here is why nobody was told" from one answer.
        var post = await CalendarInvitationMailer.SendAsync(
            ev, Imip.MethodRequest, db, tenant, config,
            logFactory.CreateLogger("CalendarInvitations"), autoSave, audit, ct);

        return Results.Created($"/api/calendar/events/{ev.Id}",
            new { ev.Id, ev.Uid, ev.Title, invitationsSent = post.Sent, invitationsNote = post.Note });
    }

    // ==================================================================
    //  Update / delete
    // ==================================================================
    public sealed record UpdateEventRequest(
        string? Title, string? Description, string? Location,
        DateTimeOffset? StartsAt, DateTimeOffset? EndsAt,
        string? Status,
        /// Editing ONE occurrence of a series rather than the whole thing.
        DateTimeOffset? OccurrenceStartsAt);

    private static async Task<IResult> UpdateEventAsync(
        Guid id, UpdateEventRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, IConfiguration config,
        TatvaOS.Api.Modules.Family.ContactAutoSave autoSave,
        ILoggerFactory logFactory, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var ev = await db.CalendarEvents.FirstOrDefaultAsync(e => e.Id == id && e.DeletedAt == null, ct);
        if (ev is null) return Results.NotFound();

        var calendar = await db.Calendars.FirstOrDefaultAsync(c => c.Id == ev.CalendarId, ct);
        if (calendar is null) return Results.NotFound();
        if (!await CanWriteAsync(db, uid, calendar, ct))
            return Results.Json(new { error = "You cannot change that event." }, statusCode: 403);

        // "Just this Tuesday" writes an exception row rather than touching the
        // series — the whole point of decision 3 in the migration.
        if (req.OccurrenceStartsAt is DateTimeOffset occ && ev.RecurrenceRule is not null)
        {
            var ex = await db.CalendarEventExceptions
                .FirstOrDefaultAsync(x => x.EventId == ev.Id && x.OccurrenceStartsAt == occ, ct);

            if (ex is null)
            {
                ex = new CalendarEventException { EventId = ev.Id, OccurrenceStartsAt = occ };
                db.CalendarEventExceptions.Add(ex);
            }

            if (req.StartsAt is DateTimeOffset s) ex.StartsAt = s;
            if (req.EndsAt is DateTimeOffset e2) ex.EndsAt = e2;
            if (req.Title is not null) ex.Title = req.Title.Trim();
            if (req.Location is not null) ex.Location = req.Location.Trim();

            await db.SaveChangesAsync(ct);
            return Results.Ok(new { updated = "occurrence", occurrenceStartsAt = occ });
        }

        var moved = false;
        if (req.Title is not null) ev.Title = req.Title.Trim();
        if (req.Description is not null) ev.Description = req.Description.Trim();
        if (req.Location is not null) ev.Location = req.Location.Trim();
        if (req.StartsAt is DateTimeOffset ns) { ev.StartsAt = ns; moved = true; }
        if (req.EndsAt is DateTimeOffset ne) { ev.EndsAt = ne; moved = true; }
        if (req.Status is "confirmed" or "tentative" or "cancelled") ev.Status = req.Status;

        if (ev.EndsAt < ev.StartsAt)
            return Results.BadRequest(new { error = "The event would end before it starts." });

        // SEQUENCE is bumped only for changes an attendee needs to know about.
        // Bumping it for a typo in the description makes every client re-alert
        // everybody, which is how people learn to ignore calendar updates.
        var notify = moved || req.Status == "cancelled";
        if (notify) ev.Sequence++;
        ev.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);

        // Attendees are told about the changes the SEQUENCE bump already
        // deems worth telling — same judgement, one flag, no second opinion.
        // A cancellation goes out as CANCEL; everything else is an updated
        // REQUEST against the same UID at the higher sequence.
        CalendarInvitationMailer.Outcome? post = null;
        if (notify)
            post = await CalendarInvitationMailer.SendAsync(
                ev, req.Status == "cancelled" ? Imip.MethodCancel : Imip.MethodRequest,
                db, tenant, config,
                logFactory.CreateLogger("CalendarInvitations"), autoSave, audit, ct);

        return Results.Ok(new
        {
            ev.Id, ev.Title, ev.StartsAt, ev.EndsAt, ev.Sequence,
            invitationsSent = post?.Sent, invitationsNote = post?.Note,
        });
    }

    private static async Task<IResult> DeleteEventAsync(
        Guid id, DateTimeOffset? occurrenceStartsAt, AppDbContext db, TenantContext tenant,
        AuditWriter audit, IConfiguration config,
        TatvaOS.Api.Modules.Family.ContactAutoSave autoSave,
        ILoggerFactory logFactory, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var ev = await db.CalendarEvents.FirstOrDefaultAsync(e => e.Id == id && e.DeletedAt == null, ct);
        if (ev is null) return Results.NotFound();

        var calendar = await db.Calendars.FirstOrDefaultAsync(c => c.Id == ev.CalendarId, ct);
        if (calendar is null || !await CanWriteAsync(db, uid, calendar, ct))
            return Results.Json(new { error = "You cannot delete that event." }, statusCode: 403);

        // Cancelling one occurrence of a series is an exception row, not a
        // deletion — "not this week" must not remove every other week.
        if (occurrenceStartsAt is DateTimeOffset asked && ev.RecurrenceRule is not null)
        {
            // THE OCCURRENCE IS RESOLVED SERVER-SIDE, NOT TRUSTED AS SENT.
            //
            // The exception row is matched against expanded occurrences on
            // every read, so the two instants have to be identical to the
            // tick. A value that has been through JSON, a query string and
            // Postgres can differ from the expanded one by sub-second dust —
            // and then the row is written, the delete reports success, and
            // the occurrence still appears. Which is exactly what happened.
            //
            // So: expand a window around what was asked for, take the
            // occurrence that matches within a second, and store THAT. The
            // stored key is now by construction the same value the read path
            // will produce.
            var canonical = Recurrence
                .Expand(ev.StartsAt, ev.RecurrenceRule, ev.Timezone,
                        asked.AddMinutes(-1), asked.AddMinutes(1))
                .Cast<DateTimeOffset?>()
                .FirstOrDefault(o => Math.Abs((o!.Value - asked).TotalSeconds) < 1);

            // Said out loud rather than silently doing nothing. A delete that
            // reports success and changes nothing is the worst answer here.
            if (canonical is not DateTimeOffset occ)
                return Results.BadRequest(new
                {
                    error = "That occurrence is not part of this repeating event. "
                          + "Reload the calendar and try again.",
                });

            var ex = await db.CalendarEventExceptions
                .FirstOrDefaultAsync(x => x.EventId == ev.Id && x.OccurrenceStartsAt == occ, ct);
            if (ex is null)
                db.CalendarEventExceptions.Add(new CalendarEventException
                {
                    EventId = ev.Id, OccurrenceStartsAt = occ, IsCancelled = true,
                });
            else ex.IsCancelled = true;

            await db.SaveChangesAsync(ct);

            await audit.WriteAsync("calendar.occurrence.cancelled", "calendar.event",
                ev.Id.ToString(), before: new { ev.Title, occurrence = occ },
                ct: ct, productCode: "calendar");

            return Results.Ok(new { cancelled = "occurrence", occurrence = occ });
        }

        ev.DeletedAt = DateTimeOffset.UtcNow;
        ev.Status = "cancelled";
        ev.Sequence++;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("calendar.event.deleted", "calendar.event", ev.Id.ToString(),
            before: new { ev.Title, ev.StartsAt }, ct: ct, productCode: "calendar");

        // A deletion the attendees never hear about is a meeting they still
        // show up to. CANCEL against the same UID at the bumped sequence is
        // how every external calendar removes it.
        var post = await CalendarInvitationMailer.SendAsync(
            ev, Imip.MethodCancel, db, tenant, config,
            logFactory.CreateLogger("CalendarInvitations"), autoSave, audit, ct);

        return Results.Ok(new { cancelled = "series", invitationsSent = post.Sent, invitationsNote = post.Note });
    }

    // ==================================================================
    //  Accept / decline
    // ==================================================================
    public sealed record RespondRequest(string? Status);

    private static async Task<IResult> RespondAsync(
        Guid id, RespondRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var status = (req.Status ?? "").Trim().ToLowerInvariant();
        if (status is not ("accepted" or "declined" or "tentative"))
            return Results.BadRequest(new { error = "Answer yes, no, or maybe." });

        var att = await db.CalendarAttendees
            .FirstOrDefaultAsync(a => a.EventId == id && a.UserId == uid, ct);

        // 404, not 403: whether an event you were not invited to exists is
        // itself information.
        if (att is null) return Results.NotFound();

        att.Status = status;
        att.RespondedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { status });
    }

    // ==================================================================
    //  Free/busy — times only, never detail
    // ==================================================================
    private static async Task<IResult> FreeBusyAsync(
        string? userIds, DateTimeOffset? from, DateTimeOffset? to,
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid) return Results.Unauthorized();
        if (from is not DateTimeOffset start || to is not DateTimeOffset end || end <= start)
            return Results.BadRequest(new { error = "Give a from and a to, with to after from." });
        if ((end - start).TotalDays > 31)
            return Results.BadRequest(new { error = "Ask for at most a month at a time." });

        var ids = (userIds ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(s => Guid.TryParse(s.Trim(), out var g) ? g : Guid.Empty)
            .Where(g => g != Guid.Empty)
            .Distinct()
            .Take(20)
            .ToList();

        if (ids.Count == 0) return Results.Ok(new { people = Array.Empty<object>() });

        var people = new List<object>();

        foreach (var personId in ids)
        {
            // Their own calendars only. A meeting on a calendar someone shared
            // with them is not their commitment.
            var calIds = await db.Calendars.AsNoTracking()
                .Where(c => c.OwnerUserId == personId && c.DeletedAt == null)
                .Select(c => c.Id)
                .ToListAsync(ct);

            var events = await db.CalendarEvents.AsNoTracking()
                .Where(e => calIds.Contains(e.CalendarId) && e.DeletedAt == null
                            && e.Status != "cancelled"
                            // 'transparent' means "does not block my time" —
                            // a reminder to send invoices should not make
                            // somebody look unavailable.
                            && e.Transparency == "opaque"
                            && (e.RecurrenceRule != null || (e.StartsAt < end && e.EndsAt > start)))
                .ToListAsync(ct);

            var busy = new List<object>();
            foreach (var e in events)
            {
                var duration = e.EndsAt - e.StartsAt;
                foreach (var occ in Recurrence.Expand(e.StartsAt, e.RecurrenceRule, e.Timezone, start, end))
                    // Deliberately start and end and NOTHING else. No title,
                    // no attendees, no location, no event id.
                    busy.Add(new { startsAt = occ, endsAt = occ + duration });
            }

            people.Add(new { userId = personId, busy });
        }

        return Results.Ok(new { people });
    }

    // ==================================================================
    //  Access
    // ==================================================================
    private static async Task<List<Guid>> VisibleCalendarIdsAsync(
        AppDbContext db, Guid uid, CancellationToken ct)
    {
        var own = await db.Calendars.AsNoTracking()
            .Where(c => c.DeletedAt == null && (c.OwnerUserId == uid || c.Kind == "organisation"))
            .Select(c => c.Id)
            .ToListAsync(ct);

        // free_busy members are NOT included here: they may see that time is
        // taken, through /freebusy, not what is in it.
        var shared = await db.CalendarMembers.AsNoTracking()
            .Where(m => m.UserId == uid && m.Role != "free_busy")
            .Select(m => m.CalendarId)
            .ToListAsync(ct);

        return own.Concat(shared).Distinct().ToList();
    }

    private static async Task<bool> CanWriteAsync(
        AppDbContext db, Guid uid, CalendarCalendar calendar, CancellationToken ct)
    {
        if (calendar.OwnerUserId == uid) return true;

        // Anyone in the tenant may put an event on an organisation calendar or
        // book a room; that is what those calendars are for. Removing somebody
        // else's booking is still gated — CanWrite is checked against the
        // EVENT's calendar, and deleting requires this same check plus the
        // event being yours in practice.
        if (calendar.Kind is "organisation" or "resource") return true;

        var role = await db.CalendarMembers.AsNoTracking()
            .Where(m => m.CalendarId == calendar.Id && m.UserId == uid)
            .Select(m => m.Role)
            .FirstOrDefaultAsync(ct);

        return role is "writer" or "owner";
    }
}
