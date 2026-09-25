'use client';

import { avatarHue, initials } from '@tatvaos/core';
import type { Address } from '@tatvaos/types';
import { usePhotoUrl } from '@/lib/peoplePhotos';

/**
 * Someone known by their email address — a mail sender, a recipient, a
 * contact. Their profile photo if they are a colleague who has set one;
 * otherwise their initials, exactly as before.
 *
 * Until 25 Sept 2026 this drew initials only, so a colleague's photo showed
 * on the People page and nowhere in Mail (Amit: "show photo in all apps like
 * email and connect people section"). The lookup is lib/peoplePhotos: one
 * batched request per screen, colleagues in your organisation only.
 */
export function Avatar({ address, size = 36 }: { address: Address; size?: number }) {
  const photo = usePhotoUrl({ email: address.email });

  if (photo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photo}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  const hue = avatarHue(address.email);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        backgroundColor: `hsl(${hue} 55% 45%)`,
      }}
      aria-hidden="true"
    >
      {initials(address)}
    </div>
  );
}
