'use client';

/**
 * The minimum the server enforces. Exported so no screen re-states it — a
 * client rule that drifts from the server's shows a green bar and then a
 * rejection, which reads as the form being broken.
 */
export const MIN_PASSWORD = 12;

/**
 * Length only — deliberately not a character-class score.
 *
 * Scores that reward a capital and a digit rate "Password1!" highly, and it is
 * on every wordlist there is. Length is the property that actually resists
 * guessing, so that is the only thing shown.
 */
export function PasswordStrength({ value }: { value: string }) {
  if (!value) return <div className="h-[22px]" />;

  const pct = Math.min(100, (value.length / 16) * 100);
  const weak = value.length < MIN_PASSWORD;
  const strong = value.length >= 16;
  const bar = weak ? 'bg-danger' : strong ? 'bg-ok' : 'bg-warn';
  const text = weak ? 'text-danger' : strong ? 'text-ok' : 'text-warn';
  const short = MIN_PASSWORD - value.length;

  return (
    <div className="mt-2">
      <div className="h-1 w-full overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full transition-all ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`mt-1 block text-xs ${text}`}>
        {weak
          ? `${short} more character${short === 1 ? '' : 's'}`
          : strong ? 'Good length' : 'Long enough'}
      </span>
    </div>
  );
}

/** The wording every password field shares. */
export const PASSWORD_HINT =
  'At least 12 characters. Length matters far more than symbols — a short phrase '
  + 'you will actually remember beats something unmemorable with a punctuation mark in it.';
