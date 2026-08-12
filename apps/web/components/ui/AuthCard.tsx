/** The centred card the anonymous auth screens share. */
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas p-4">
      <div className="w-full max-w-[440px] rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
        {children}
      </div>
    </div>
  );
}

/** Shared control styling for these screens. */
export const AUTH_INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none '
  + 'transition placeholder:text-ink-faint focus:border-brand-500';

export const AUTH_BUTTON =
  'w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition '
  + 'hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50';
