'use client';

import { useEffect, useState } from 'react';
import { avatarHue, initials } from '@tatvaos/core';
import { useAuth } from '@/lib/auth';
import { avatarObjectUrl } from '@/lib/avatars';

/**
 * A person's profile photo, falling back to their initials.
 *
 * The photo is fetched with the session's token and shown via an object URL —
 * see lib/avatars for why an <img src> pointing at the endpoint cannot work.
 * Initials render immediately and stay until the image resolves, so a list
 * never flashes empty circles while photos load, and a failed fetch simply
 * leaves the initials in place.
 */
export function UserPhoto({
  userId,
  hasAvatar,
  name,
  email,
  size = 36,
}: {
  userId: string;
  hasAvatar?: boolean;
  name?: string | null;
  email: string;
  size?: number;
}) {
  const { authedFetch } = useAuth();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hasAvatar) { setUrl(null); return; }
    let alive = true;
    avatarObjectUrl(authedFetch, userId).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [authedFetch, userId, hasAvatar]);

  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        backgroundColor: `hsl(${avatarHue(email)} 55% 45%)`,
      }}
      aria-hidden="true"
    >
      {initials({ name: name ?? undefined, email })}
    </div>
  );
}
