/**
 * Where docked composer windows sit along the bottom of the screen.
 *
 * Amit, 24 September 2026: three New message windows on a 1920px laptop at
 * 125% Windows scaling — a 1536px-wide browser — and the third was pushed
 * half off the left edge. Each window used to take a fixed 580px slot, and
 * the cap of three was "what a 1080p-wide window fits"; nobody's 1080p
 * screen is 1920 CSS pixels once Windows scales it.
 *
 * Now the widths are real and the room is measured: when the windows would
 * not fit, the OLDEST are minimised to a title strip (the draft stays in the
 * page — minimising no longer unmounts the editor), and the one just opened
 * or restored always stays open. Gmail does the same.
 *
 * Numbers must match the classes in Composer.tsx: sm:w-[560px] open,
 * sm:w-[360px] minimised.
 */
export const DOCK_EDGE = 20;
export const DOCK_GAP = 20;
export const DOCK_OPEN_W = 560;
export const DOCK_MIN_W = 360;
/** Below Tailwind's `sm` every window is full width and only the first shows. */
export const DOCK_PHONE_MAX = 640;
/** Never more than this many, however wide the screen. */
export const DOCK_MAX_WINDOWS = 3;

function widthOf(minimised: boolean[]): number {
  if (minimised.length === 0) return 0;
  return DOCK_EDGE * 2
    + minimised.reduce((n, m) => n + (m ? DOCK_MIN_W : DOCK_OPEN_W), 0)
    + DOCK_GAP * (minimised.length - 1);
}

/**
 * Which windows show minimised, and each one's `right` in px.
 *
 * @param chosen  per window, oldest first (= rightmost): did the PERSON minimise it
 * @param keep    index that must stay open — the one opened or restored last
 * @param room    viewport width in CSS px
 */
export function layoutDock(chosen: boolean[], keep: number, room: number) {
  const minimised = [...chosen];
  if (room >= DOCK_PHONE_MAX) {
    // Oldest first: the window you have been away from longest folds away.
    for (let i = 0; i < minimised.length && widthOf(minimised) > room; i++) {
      if (i !== keep) minimised[i] = true;
    }
  }
  const right: number[] = [];
  let x = DOCK_EDGE;
  for (const m of minimised) {
    right.push(x);
    x += (m ? DOCK_MIN_W : DOCK_OPEN_W) + DOCK_GAP;
  }
  return { minimised, right };
}

/**
 * Whether one more docked window can open: it must fit OPEN beside all the
 * others minimised. On a phone only one is ever visible, so the rest stay
 * mounted and hidden, as before — the room check does not apply there.
 */
export function dockHasRoom(docked: number, room: number): boolean {
  if (docked >= DOCK_MAX_WINDOWS) return false;
  if (docked === 0 || room < DOCK_PHONE_MAX) return true;
  return widthOf([...Array<boolean>(docked).fill(true), false]) <= room;
}
