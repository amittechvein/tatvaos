using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Space.Endpoints;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// The live channel for documents: one WebSocket per open editor, one room
/// per document, and the server as a relay that also writes everything down.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHAT THE SERVER DOES AND DOES NOT KNOW
///
///  It never parses a Yjs update. Browsers merge; the server stores each
///  update as bytes, gives it a seq, and forwards it to the rest of the room.
///  Yjs updates are commutative and idempotent, so a browser that receives
///  the same update twice, or in a different order from its neighbour, still
///  converges — which is what makes a dumb relay correct.
///
///  The one ordering promise the server does make: within a document, seq
///  order is send order to every connection. Append-and-broadcast happens
///  under the room lock, and each connection drains a single FIFO outbox.
///  Checkpoints rely on it: "I have seen every update up to seq N" is only a
///  meaningful claim if N means the same prefix to everyone.
///
///  WIRE FORMAT — binary frames, first byte is the type:
///
///    browser → server
///      0x01 update      [yjs update]                   edit level required
///      0x02 awareness   [y-protocols awareness update] any level
///
///    server → browser
///      0x01 update      [seq u64 BE][yjs update]       someone else's edit
///      0x02 awareness   [awareness update]
///      0x04 ack         [seq u64 BE]                   YOUR update got this seq
///      0x05 synced      [seq u64 BE]                   initial load complete
///      0x06 event       [utf8 JSON]                    comments / meta / perm / readonly
///      0x07 state       [seq u64 BE][yjs update]       the compacted base
///
///  apps/web/lib/docsLive.ts is the other end; change both or neither.
///
///  WHY A TICKET AND NOT THE SESSION
///
///  The browser holds its access token in memory and sends it as a header;
///  a browser WebSocket cannot send headers. Putting the token itself in the
///  URL would write a live credential into Caddy's access log. So the
///  editor asks for a ticket over ordinary authenticated HTTP — single use,
///  sixty seconds, bound to one person and one document — and presents that
///  instead. A leaked ticket is worth one connection to a document its owner
///  could already open, for a minute.
///
///  CLOSE CODES the browser acts on: 4403 = access removed, do not
///  reconnect; 4404 = no such document, do not reconnect; 4429 = too many
///  documents open (MaxConnectionsPerPerson), do not reconnect; anything else
///  (4001 lifetime, 1000, 1006 network) = fetch a new ticket and reconnect.
///
///  WHY CONNECTIONS ARE CUT EVERY 30 MINUTES
///
///  Authentication happens once, at the ticket. Without a limit, a person
///  whose account was suspended or whose session was revoked would keep a
///  live editor for as long as the tab stayed open. The watcher below
///  re-reads their LEVEL every 45 seconds (a removed share takes effect
///  within a minute); the lifetime cap bounds everything else. The browser
///  reconnects on its own, which requires a fresh ticket, which requires a
///  valid session.
///
///  SINGLE PROCESS. Rooms live in memory. That is correct while the API is
///  one container (docker-compose.base.yml); a second replica would need the
///  broadcast to go through Postgres LISTEN/NOTIFY or Redis. It is NOT left
///  to prose: DocsInstanceGuard lets only the holder of a database-wide lock
///  serve live editing, and every other instance refuses /live and logs a
///  CRITICAL line every minute (decision 0008, deployment rule).
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class DocsLiveHub(IServiceScopeFactory scopes, DocsInstanceGuard guard, ILogger<DocsLiveHub> log)
{
    public const byte MsgUpdate = 0x01, MsgAwareness = 0x02, MsgAck = 0x04,
        MsgSynced = 0x05, MsgEvent = 0x06, MsgState = 0x07;

    /// <summary>Largest single frame accepted. A paste of a long document is one update.</summary>
    private const int MaxMessageBytes = 8 * 1024 * 1024;

    private static readonly TimeSpan TicketLifetime = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan ConnectionLifetime = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan PermissionRecheck = TimeSpan.FromSeconds(45);

    /// <summary>
    /// Open live connections one person may hold at once, across all
    /// documents. Each costs a socket, a DbContext and a watcher; without a
    /// cap one account (or one stolen session) could hold thousands. Twenty
    /// is far above anyone's real number of open document tabs.
    /// </summary>
    private const int MaxConnectionsPerPerson = 20;

    // ------------------------------------------------------------------
    //  Tickets
    // ------------------------------------------------------------------

    public sealed record Ticket(Guid TenantId, Guid UserId, string Role, Guid FileId, DateTimeOffset Expires);

    private readonly ConcurrentDictionary<string, Ticket> _tickets = new();

    public string IssueTicket(Guid tenantId, Guid userId, string role, Guid fileId)
    {
        // Sweep on issue: bounded by how many editors open per minute, and
        // it keeps a timer out of the picture.
        var now = DateTimeOffset.UtcNow;
        foreach (var (k, t) in _tickets)
            if (t.Expires < now) _tickets.TryRemove(k, out _);

        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        _tickets[token] = new Ticket(tenantId, userId, role, fileId, now + TicketLifetime);
        return token;
    }

    /// <summary>Single use: a redeemed ticket is gone whether or not it was valid for this file.</summary>
    public Ticket? Redeem(string? token, Guid fileId)
    {
        if (string.IsNullOrEmpty(token) || !_tickets.TryRemove(token, out var t)) return null;
        if (t.Expires < DateTimeOffset.UtcNow || t.FileId != fileId) return null;
        return t;
    }

    // ------------------------------------------------------------------
    //  Rooms
    // ------------------------------------------------------------------

    private sealed class Room
    {
        public readonly SemaphoreSlim Lock = new(1, 1);
        public readonly List<Conn> Conns = [];
    }

    private sealed class Conn
    {
        public required WebSocket Socket { get; init; }
        public required Guid UserId { get; init; }
        public required Channel<byte[]> Outbox { get; init; }
        public volatile string Perm = "view";
        /// <summary>Last awareness frame this connection sent, replayed to newcomers.</summary>
        public volatile byte[]? LastAwareness;
        /// <summary>Awareness client ids announced on this connection, and their last clock.</summary>
        public readonly ConcurrentDictionary<ulong, ulong> AwarenessClocks = new();

        /// <summary>
        /// Queue without waiting. A connection whose outbox is full is too slow
        /// to keep in step; it is closed, and it resynchronises from the
        /// database when it reconnects. Blocking here would stall the whole
        /// room behind its slowest reader.
        /// </summary>
        public void Send(byte[] frame)
        {
            if (!Outbox.Writer.TryWrite(frame))
                Outbox.Writer.TryComplete(new InvalidOperationException("outbox full"));
        }

        /// <summary>
        /// Close from anywhere. A WebSocket allows ONE send at a time, and a
        /// close frame is a send — so it goes through the outbox like every
        /// other frame and the write loop is the only thing that ever sends.
        /// An empty frame is the sentinel; no real frame is empty.
        /// </summary>
        public void Close(int code, string reason)
        {
            CloseCode = code;
            CloseReason = reason;
            Outbox.Writer.TryWrite([]);
        }

        public volatile int CloseCode = (int)WebSocketCloseStatus.NormalClosure;
        public volatile string CloseReason = "bye";
    }

    private readonly ConcurrentDictionary<Guid, Room> _rooms = new();
    private readonly ConcurrentDictionary<Guid, int> _perPerson = new();

    private Room RoomFor(Guid fileId) => _rooms.GetOrAdd(fileId, _ => new Room());

    /// <summary>
    /// Hold a document's room lock. The checkpoint handler takes it so that a
    /// browser joining mid-checkpoint cannot read the new state together with
    /// the old updates (or the old state without the folded ones).
    /// </summary>
    public async Task<IDisposable> LockAsync(Guid fileId, CancellationToken ct)
    {
        var room = RoomFor(fileId);
        await room.Lock.WaitAsync(ct);
        return new Releaser(room.Lock);
    }

    private sealed class Releaser(SemaphoreSlim s) : IDisposable
    {
        private int _done;
        public void Dispose() { if (Interlocked.Exchange(ref _done, 1) == 0) s.Release(); }
    }

    /// <summary>Tell every open editor of a document that something outside the text changed.</summary>
    public void Broadcast(Guid fileId, object evt)
    {
        if (!_rooms.TryGetValue(fileId, out var room)) return;
        var frame = Frame(MsgEvent, JsonSerializer.SerializeToUtf8Bytes(evt, JsonOpts));
        Conn[] conns;
        lock (room.Conns) conns = [.. room.Conns];
        foreach (var c in conns) c.Send(frame);
    }

    /// <summary>How many editors have this document open right now.</summary>
    public int Occupancy(Guid fileId)
    {
        if (!_rooms.TryGetValue(fileId, out var room)) return 0;
        lock (room.Conns) return room.Conns.Count;
    }

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    // ------------------------------------------------------------------
    //  One connection, start to finish
    // ------------------------------------------------------------------

    public async Task RunAsync(
        HttpContext http, Guid fileId, Ticket ticket, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        // The ticket stands in for the session: from here the request is
        // that person, in that organisation, exactly as TenantMiddleware
        // would have set it for an authenticated call.
        tenant.Set(ticket.TenantId, ticket.UserId, ticket.Role);

        var file = await db.SpaceFiles.AsNoTracking().FirstOrDefaultAsync(f => f.Id == fileId, ct);
        if (file is null || !DocsFormat.IsLive(file.MimeType) || file.DeletedAt is not null)
        {
            http.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        var perm = await SpaceEndpoints.FilePermAsync(db, file, ticket.UserId, ct);

        using var socket = await http.WebSockets.AcceptWebSocketAsync();

        // Over the cap: accept, say why, close. Refusing the handshake instead
        // would look to the browser like a network failure and it would retry
        // forever; 4429 tells it to stop and show the reason.
        if (_perPerson.AddOrUpdate(ticket.UserId, 1, (_, n) => n + 1) > MaxConnectionsPerPerson)
        {
            _perPerson.AddOrUpdate(ticket.UserId, 0, (_, n) => n - 1);
            log.LogWarning("Docs live connection refused: per-person cap reached. userId={UserId}", ticket.UserId);
            try
            {
                using var t = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await socket.CloseOutputAsync((WebSocketCloseStatus)4429,
                    "too many open documents", t.Token);
            }
            catch { /* already gone */ }
            return;
        }
        try
        {
            await RunConnectedAsync(socket, fileId, ticket, perm, db, ct);
        }
        finally
        {
            _perPerson.AddOrUpdate(ticket.UserId, 0, (_, n) => n - 1);
        }
    }

    private async Task RunConnectedAsync(
        WebSocket socket, Guid fileId, Ticket ticket, string perm, AppDbContext db, CancellationToken ct)
    {
        var conn = new Conn
        {
            Socket = socket,
            UserId = ticket.UserId,
            Outbox = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(2000)
            {
                SingleReader = true,
                FullMode = BoundedChannelFullMode.Wait, // TryWrite returns false; see Conn.Send
            }),
            Perm = perm,
        };

        using var life = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var room = RoomFor(fileId);

        var writer = WriteLoopAsync(conn, life.Token);

        // The lifetime cap closes politely rather than cancelling: a
        // cancelled socket is aborted, and an aborted socket looks to the
        // browser exactly like a network failure.
        using var expiry = new Timer(_ => conn.Close(4001, "reconnect"), null, ConnectionLifetime, Timeout.InfiniteTimeSpan);

        try
        {
            // Join and initial load under the room lock: nothing can be
            // appended between reading the database and being registered to
            // receive what comes next, so there is no gap and no overlap.
            await room.Lock.WaitAsync(life.Token);
            try
            {
                var doc = await db.DocsDocuments.AsNoTracking()
                    .Where(d => d.FileId == fileId)
                    .Select(d => new { d.State, d.StateSeq })
                    .FirstOrDefaultAsync(life.Token);
                if (doc is null)
                {
                    conn.Close(4404, "no document");
                    return;
                }

                // Level FIRST: the browser decides at "synced" whether to send
                // what it typed while offline, and needs to know it may.
                conn.Send(Frame(MsgEvent, JsonSerializer.SerializeToUtf8Bytes(
                    new { type = "perm", perm = conn.Perm }, JsonOpts)));
                conn.Send(Frame(MsgState, Seq(doc.StateSeq), doc.State));
                var last = doc.StateSeq;
                var updates = await db.DocsUpdates.AsNoTracking()
                    .Where(u => u.FileId == fileId && u.Seq > doc.StateSeq)
                    .OrderBy(u => u.Seq)
                    .Select(u => new { u.Seq, u.Data })
                    .ToListAsync(life.Token);
                foreach (var u in updates)
                {
                    conn.Send(Frame(MsgUpdate, Seq(u.Seq), u.Data));
                    last = u.Seq;
                }
                conn.Send(Frame(MsgSynced, Seq(last)));

                lock (room.Conns)
                {
                    foreach (var other in room.Conns)
                        if (other.LastAwareness is { } aw) conn.Send(Frame(MsgAwareness, aw));
                    room.Conns.Add(conn);
                }
            }
            finally
            {
                room.Lock.Release();
            }

            _ = WatchAsync(conn, fileId, ticket, life.Token);
            await ReadLoopAsync(conn, room, fileId, ticket, db, life.Token);
        }
        catch (OperationCanceledException)
        {
            // The request aborted (server shutting down, peer gone).
        }
        catch (WebSocketException)
        {
            // The peer vanished (tab closed, network dropped). Nothing to say.
        }
        catch (Exception ex)
        {
            // Never content — ids only (IAiGateway rule 4 applies to documents too).
            log.LogError(ex, "Docs live connection failed. fileId={FileId} userId={UserId}", fileId, ticket.UserId);
        }
        finally
        {
            lock (room.Conns) room.Conns.Remove(conn);
            AnnounceDeparture(room, conn);
            lock (room.Conns)
            {
                if (room.Conns.Count == 0) _rooms.TryRemove(new KeyValuePair<Guid, Room>(fileId, room));
            }

            // Let the write loop drain and send any close already queued,
            // then stop it. Only after it has finished may anything else
            // send on this socket.
            conn.Outbox.Writer.TryComplete();
            try { await writer.WaitAsync(TimeSpan.FromSeconds(2)); } catch { /* slow or dead peer */ }
            life.Cancel();

            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    using var t = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", t.Token);
                }
                catch { /* already gone */ }
            }
        }
    }

    private async Task ReadLoopAsync(
        Conn conn, Room room, Guid fileId, Ticket ticket, AppDbContext db, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var ms = new MemoryStream();

        while (!ct.IsCancellationRequested && conn.Socket.State == WebSocketState.Open)
        {
            ms.SetLength(0);
            WebSocketReceiveResult r;
            do
            {
                r = await conn.Socket.ReceiveAsync(buffer, ct);
                if (r.MessageType == WebSocketMessageType.Close) return;
                ms.Write(buffer, 0, r.Count);
                if (ms.Length > MaxMessageBytes)
                {
                    conn.Close((int)WebSocketCloseStatus.MessageTooBig, "message too large");
                    return;
                }
            } while (!r.EndOfMessage);

            if (r.MessageType != WebSocketMessageType.Binary || ms.Length < 1) continue;
            var msg = ms.ToArray();
            var payload = msg.AsMemory(1);

            switch (msg[0])
            {
                case MsgUpdate:
                    if (SpaceEndpoints.Rank(conn.Perm) < SpaceEndpoints.Rank("edit"))
                    {
                        // Not persisted, not forwarded. The browser was told its
                        // level on join; an update from a viewer is either a
                        // stale tab or a hand-made frame, and both get the same
                        // answer.
                        conn.Send(Frame(MsgEvent, JsonSerializer.SerializeToUtf8Bytes(
                            new { type = "readonly" }, JsonOpts)));
                        break;
                    }
                    await AppendAsync(conn, room, fileId, ticket, db, payload.ToArray(), ct);
                    break;

                case MsgAwareness:
                    conn.LastAwareness = payload.ToArray();
                    TrackAwarenessClocks(conn, payload.Span);
                    var frame = Frame(MsgAwareness, payload.Span);
                    Conn[] others;
                    lock (room.Conns) others = [.. room.Conns.Where(c => c != conn)];
                    foreach (var o in others) o.Send(frame);
                    break;
            }
        }
    }

    private static async Task AppendAsync(
        Conn conn, Room room, Guid fileId, Ticket ticket, AppDbContext db, byte[] update, CancellationToken ct)
    {
        await room.Lock.WaitAsync(ct);
        try
        {
            // Raw INSERT … RETURNING rather than db.Add: this DbContext lives
            // as long as the socket, and tracked entities would accumulate in
            // it for every keystroke batch of a thirty-minute session.
            var seq = (await db.Database.SqlQuery<long>($"""
                INSERT INTO docs.updates (file_id, tenant_id, user_id, data)
                VALUES ({fileId}, {ticket.TenantId}, {ticket.UserId}, {update})
                RETURNING seq AS "Value"
                """).ToListAsync(ct)).Single();

            conn.Send(Frame(MsgAck, Seq(seq)));
            var frame = Frame(MsgUpdate, Seq(seq), update);
            lock (room.Conns)
                foreach (var o in room.Conns)
                    if (o != conn) o.Send(frame);
        }
        finally
        {
            room.Lock.Release();
        }
    }

    private static async Task WriteLoopAsync(Conn conn, CancellationToken ct)
    {
        try
        {
            await foreach (var frame in conn.Outbox.Reader.ReadAllAsync(ct))
            {
                if (frame.Length == 0)
                {
                    await conn.Socket.CloseOutputAsync(
                        (WebSocketCloseStatus)conn.CloseCode, conn.CloseReason, ct);
                    return;
                }
                await conn.Socket.SendAsync(frame, WebSocketMessageType.Binary, true, ct);
            }
        }
        catch (InvalidOperationException)
        {
            // Outbox completed with "outbox full": too far behind. Abort, and
            // the browser reloads from the database on reconnect.
            conn.Socket.Abort();
        }
    }

    /// <summary>
    /// Re-read the caller's level on a timer, in a scope of its own (the
    /// connection's DbContext belongs to the read loop and is not
    /// thread-safe). A share removed, a file trashed, or the person no
    /// longer able to see it at all: each lands here within the interval.
    /// </summary>
    private async Task WatchAsync(Conn conn, Guid fileId, Ticket ticket, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            string? perm;
            try
            {
                await Task.Delay(PermissionRecheck, ct);

                // This process stopped being the only live-editing instance
                // (its lock connection died). Send the browser away to
                // reconnect — to whichever instance holds the lock now —
                // rather than keep a room another instance may also have.
                if (!guard.IsSoleInstance)
                {
                    conn.Close(4001, "reconnect");
                    return;
                }

                using var scope = scopes.CreateScope();
                var t = scope.ServiceProvider.GetRequiredService<TenantContext>();
                t.Set(ticket.TenantId, ticket.UserId, ticket.Role);
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var file = await db.SpaceFiles.AsNoTracking().FirstOrDefaultAsync(f => f.Id == fileId, ct);
                // Docs (or, for a spreadsheet, Sheets) switched off for the
                // organisation counts as access removed: the operator's switch
                // must reach open editors too. Each file answers to its own
                // kind's switch (LiveSwitch).
                perm = file is null || file.DeletedAt is not null || !await LiveSwitch.EnabledAsync(db, file.MimeType, ct)
                    ? null
                    : await SpaceEndpoints.FilePermAsync(db, file, ticket.UserId, ct);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                // A database blip must not end the watch — it would leave
                // the connection running on its last-known level for the
                // rest of its life. Say so, and look again next interval.
                log.LogWarning(ex, "Docs permission recheck failed; retrying. fileId={FileId} userId={UserId}",
                    fileId, ticket.UserId);
                continue;
            }

            if (perm is null)
            {
                // 4403: gone for good. The browser must NOT reconnect.
                conn.Close(4403, "access removed");
                return;
            }
            if (perm != conn.Perm)
            {
                conn.Perm = perm;
                conn.Send(Frame(MsgEvent, JsonSerializer.SerializeToUtf8Bytes(new { type = "perm", perm }, JsonOpts)));
            }
        }
    }

    // ------------------------------------------------------------------
    //  Awareness bookkeeping
    //
    //  y-protocols awareness update: varuint count, then per entry
    //  varuint clientId, varuint clock, varstring JSON state. We read only
    //  the ids and clocks, so that when a connection drops we can tell the
    //  room that its cursors are gone (state "null" at the same clock is
    //  accepted as a removal by applyAwarenessUpdate). Without this a
    //  closed tab's cursor lingers for thirty seconds, until the browsers'
    //  own timeout.
    // ------------------------------------------------------------------

    private static void TrackAwarenessClocks(Conn conn, ReadOnlySpan<byte> update)
    {
        try
        {
            var pos = 0;
            var count = ReadVarUint(update, ref pos);
            for (ulong i = 0; i < count && i < 64; i++)
            {
                var id = ReadVarUint(update, ref pos);
                var clock = ReadVarUint(update, ref pos);
                var len = (int)ReadVarUint(update, ref pos);
                var json = update.Slice(pos, len);
                pos += len;
                if (json.SequenceEqual("null"u8)) conn.AwarenessClocks.TryRemove(id, out _);
                else conn.AwarenessClocks[id] = clock;
            }
        }
        catch (Exception)
        {
            // Malformed: relayed anyway (the browsers decide), just not tracked.
        }
    }

    private static void AnnounceDeparture(Room room, Conn conn)
    {
        if (conn.AwarenessClocks.IsEmpty) return;
        using var ms = new MemoryStream();
        WriteVarUint(ms, (ulong)conn.AwarenessClocks.Count);
        foreach (var (id, clock) in conn.AwarenessClocks)
        {
            WriteVarUint(ms, id);
            WriteVarUint(ms, clock);
            WriteVarUint(ms, 4);
            ms.Write("null"u8);
        }
        var frame = Frame(MsgAwareness, ms.ToArray());
        lock (room.Conns)
            foreach (var o in room.Conns) o.Send(frame);
    }

    private static ulong ReadVarUint(ReadOnlySpan<byte> b, ref int pos)
    {
        ulong num = 0;
        var shift = 0;
        while (true)
        {
            var r = b[pos++];
            num |= (ulong)(r & 0x7f) << shift;
            if (r < 0x80) return num;
            shift += 7;
            if (shift > 63) throw new FormatException("varuint too long");
        }
    }

    private static void WriteVarUint(Stream s, ulong num)
    {
        while (num > 0x7f)
        {
            s.WriteByte((byte)(0x80 | (num & 0x7f)));
            num >>= 7;
        }
        s.WriteByte((byte)num);
    }

    // ------------------------------------------------------------------
    //  Framing
    // ------------------------------------------------------------------

    private static byte[] Seq(long seq)
    {
        var b = new byte[8];
        BinaryPrimitives.WriteInt64BigEndian(b, seq);
        return b;
    }

    private static byte[] Frame(byte type, ReadOnlySpan<byte> a, ReadOnlySpan<byte> b = default)
    {
        var f = new byte[1 + a.Length + b.Length];
        f[0] = type;
        a.CopyTo(f.AsSpan(1));
        b.CopyTo(f.AsSpan(1 + a.Length));
        return f;
    }
}
