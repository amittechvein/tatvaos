import { avatarHue, initials } from '@tatvaos/core';
import type { Address } from '@tatvaos/types';

export function Avatar({ address, size = 36 }: { address: Address; size?: number }) {
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
