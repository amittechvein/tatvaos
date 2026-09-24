// ============================================================================
//  TatvaOS Docs — the live channel, browser end
// ============================================================================
//
//  The other end is apps/api/Modules/Docs/DocsLiveHub.cs; its header has the
//  wire format. Change both or neither.
//
//  The server is a relay that numbers and stores updates; all merging is Yjs,
//  here. Three documents' worth of state matter:
//
//    doc      what the editor shows — local edits land here first
//    remote   a shadow holding ONLY what the server has confirmed: its state,
//             other people's updates, and our own once ACKED. Never edited.
//    inflight our updates sent but not yet acked, in send order
//
//  Why the shadow: a connection can drop with updates in flight, and edits
//  keep happening while it is down. On every (re)sync we send the difference
//  between doc and remote — exactly what the server has not confirmed — so
//  nothing typed during a blip is lost, and nothing is sent twice for long
//  (Yjs ignores duplicates anyway).
//
//  "Saved" in the UI means inflight and queue are both empty: every
//  keystroke has been acked, and an ack is only sent after the row is in
//  docs.updates.
// ============================================================================

import * as Y from 'yjs';
import {
  Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates,
} from 'y-protocols/awareness';

const MSG_UPDATE = 0x01;
const MSG_AWARENESS = 0x02;
const MSG_ACK = 0x04;
const MSG_SYNCED = 0x05;
const MSG_EVENT = 0x06;
const MSG_STATE = 0x07;

/** Batch keystrokes: one frame per burst rather than one per character. */
const FLUSH_MS = 60;

export type LiveStatus = 'connecting' | 'synced' | 'offline' | 'closed';

export interface LiveEvent {
  type: 'comments' | 'meta' | 'perm' | 'readonly' | 'versions' | 'saved';
  [key: string]: unknown;
}

/**
 * COPY of the API base in lib/auth.tsx (`API`). The WebSocket URL is built
 * from it: absolute in local development, where the API is another port,
 * and relative (same origin, via Caddy) in production.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

function liveUrl(fileId: string, ticket: string): string {
  const base = API.startsWith('http')
    ? new URL(API)
    : new URL(API, window.location.origin);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${base.pathname.replace(/\/$/, '')}/docs/${fileId}/live`;
  base.search = `?ticket=${encodeURIComponent(ticket)}`;
  return base.toString();
}

function readSeq(b: Uint8Array, at: number): number {
  // u64 big-endian. Sequences fit comfortably in a double for centuries.
  const view = new DataView(b.buffer, b.byteOffset + at, 8);
  return Number(view.getBigInt64(0));
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(payload.length + 1);
  f[0] = type;
  f.set(payload, 1);
  return f;
}

export class DocsLiveProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  status: LiveStatus = 'connecting';
  /** Highest seq whose content is in `doc` — safe to claim in a checkpoint. */
  lastSeq = 0;
  /** The level the server last told us. Edits are only sent at edit or above. */
  perm = 'view';

  private readonly remote = new Y.Doc();
  private queue: Uint8Array[] = [];
  private inflight: Uint8Array[] = [];
  private ws: WebSocket | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private destroyed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly fileId: string,
    private readonly getTicket: () => Promise<string>,
    private readonly onEvent: (e: LiveEvent) => void,
  ) {
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    window.addEventListener('beforeunload', this.onUnload);
    void this.connect();
  }

  /** Re-render hook: status, perm, pending changes. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  get pending(): boolean {
    return this.queue.length > 0 || this.inflight.length > 0;
  }

  get canEdit(): boolean {
    return this.perm === 'edit' || this.perm === 'owner';
  }

  // ------------------------------------------------------------------

  private async connect() {
    if (this.destroyed) return;
    this.status = 'connecting';
    this.emit();

    let ticket: string;
    try {
      ticket = await this.getTicket();
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 404/409: the document is gone or in the trash. Retrying will not help.
      if (status === 404 || status === 409 || status === 403) {
        this.status = 'closed';
        this.emit();
        this.onEvent({ type: 'perm', perm: 'none', reason: (e as Error).message });
        return;
      }
      this.scheduleRetry();
      return;
    }
    if (this.destroyed) return;

    const ws = new WebSocket(liveUrl(this.fileId, ticket));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (ev) => this.onMessage(new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Anything sent and not acked may or may not be stored. It stays in
      // `doc`, and the next sync's diff against `remote` resends it.
      this.inflight = [];
      if (this.destroyed) return;
      if (ev.code === 4403 || ev.code === 4404) {
        this.status = 'closed';
        this.emit();
        this.onEvent({ type: 'perm', perm: 'none', reason: ev.reason });
        return;
      }
      this.status = 'offline';
      this.emit();
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (this.destroyed || this.retryTimer) return;
    const delay = Math.min(10_000, 500 * 2 ** this.retries) + Math.random() * 500;
    this.retries += 1;
    this.status = 'offline';
    this.emit();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  /** Try now rather than waiting out the backoff (the "Reconnect" button, going back online). */
  reconnectNow() {
    if (this.ws || this.destroyed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retries = 0;
    void this.connect();
  }

  private onMessage(msg: Uint8Array) {
    if (msg.length === 0) return;
    const type = msg[0];
    switch (type) {
      case MSG_STATE: {
        const seq = readSeq(msg, 1);
        const update = msg.subarray(9);
        if (update.length > 0) {
          Y.applyUpdate(this.remote, update, this);
          Y.applyUpdate(this.doc, update, this);
        }
        this.lastSeq = Math.max(this.lastSeq, seq);
        break;
      }
      case MSG_UPDATE: {
        const seq = readSeq(msg, 1);
        const update = msg.subarray(9);
        Y.applyUpdate(this.remote, update, this);
        Y.applyUpdate(this.doc, update, this);
        this.lastSeq = Math.max(this.lastSeq, seq);
        break;
      }
      case MSG_ACK: {
        const seq = readSeq(msg, 1);
        const mine = this.inflight.shift();
        if (mine) Y.applyUpdate(this.remote, mine, this);
        this.lastSeq = Math.max(this.lastSeq, seq);
        this.emit();
        break;
      }
      case MSG_SYNCED: {
        this.lastSeq = Math.max(this.lastSeq, readSeq(msg, 1));
        this.status = 'synced';
        this.retries = 0;
        // Everything the server has not confirmed: typed while offline, or
        // in flight when the last connection dropped.
        const diff = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.remote));
        this.queue = [];
        // An empty diff still encodes a couple of bytes (no structs, empty
        // delete set). Sending it would be harmless and useless.
        if (diff.length > 2 && this.canEdit) this.queue.push(diff);
        this.flush();
        const local = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
        this.send(frame(MSG_AWARENESS, local));
        this.emit();
        break;
      }
      case MSG_AWARENESS:
        applyAwarenessUpdate(this.awareness, msg.subarray(1), this);
        break;
      case MSG_EVENT: {
        let evt: LiveEvent;
        try {
          evt = JSON.parse(new TextDecoder().decode(msg.subarray(1))) as LiveEvent;
        } catch {
          return;
        }
        if (evt.type === 'perm' && typeof evt.perm === 'string') {
          this.perm = evt.perm;
          this.emit();
        }
        this.onEvent(evt);
        break;
      }
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;            // from the server
    if (!this.canEdit) return;              // a viewer's editor is read-only anyway
    this.queue.push(update);
    this.emit();
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  };

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.status !== 'synced' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.queue.length === 0) return;
    const merged = this.queue.length === 1 ? this.queue[0]! : Y.mergeUpdates(this.queue);
    this.queue = [];
    this.inflight.push(merged);
    this.send(frame(MSG_UPDATE, merged));
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    const changed = added.concat(updated, removed).filter((id) => id === this.doc.clientID);
    if (changed.length === 0) return;
    this.send(frame(MSG_AWARENESS, encodeAwarenessUpdate(this.awareness, changed)));
  };

  private send(f: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(f);
  }

  private onUnload = () => {
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
  };

  destroy() {
    this.destroyed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    window.removeEventListener('beforeunload', this.onUnload);
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.awareness.off('update', this.onAwarenessUpdate);
    this.doc.off('update', this.onDocUpdate);
    this.ws?.close(1000, 'closed');
    this.ws = null;
    this.awareness.destroy();
    this.doc.destroy();
    this.remote.destroy();
  }
}
