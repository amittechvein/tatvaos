'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { familyApi } from '@/lib/family';

// ---------------------------------------------------------------------------
//  The sender's name in a message header, linked to their contact card when
//  the address is in the address book.
//
//  One lookup per address per session. The answer is cached — including
//  "not a contact" — so reading a thread from one person costs one request,
//  not one per message, and a name that is not a contact stays plain text
//  without asking again. The 404 is a normal answer, not an error.
// ---------------------------------------------------------------------------

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function key(email: string): string {
  return email.trim().toLowerCase();
}

function resolve(f: AuthedFetch, email: string): Promise<string | null> {
  const k = key(email);
  const hit = cache.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = familyApi.lookup(f, k)
    .then((c) => c?.id ?? null)
    .catch(() => null)
    .then((id) => {
      cache.set(k, id);
      inflight.delete(k);
      return id;
    });
  inflight.set(k, p);
  return p;
}

export function SenderName({ address, label, className }: {
  address: { email: string };
  /** Already-formatted display text — the caller's displayName() result. */
  label: string;
  className?: string;
}) {
  const { authedFetch } = useAuth();
  const [contactId, setContactId] = useState<string | null>(() => cache.get(key(address.email)) ?? null);

  useEffect(() => {
    let alive = true;
    void resolve(authedFetch, address.email).then((id) => { if (alive) setContactId(id); });
    return () => { alive = false; };
  }, [authedFetch, address.email]);

  if (!contactId) return <span className={className}>{label}</span>;
  return (
    <Link
      href={`/family/contacts?open=${encodeURIComponent(contactId)}`}
      title="Open in Contacts"
      className={`${className ?? ''} no-underline hover:underline`.trim()}
    >
      {label}
    </Link>
  );
}
