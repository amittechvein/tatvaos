/**
 * Which camera to switch to next.
 *
 * Amit, 18 September 2026, in a meeting on his phone's browser: "need switch
 * camera option in the mobile browser". A phone has two cameras and the web
 * client had no way to change which one it used — the native app has had
 * "hold the camera button" since 16 Sept, and the browser is where most guests
 * join from.
 *
 * Pure, so it can be checked without a browser: the screen holds the device
 * list and the current device id, this decides where to go next.
 */

export type Camera = { deviceId: string; label?: string };

/** A label that reads like the back camera on Android and iOS. */
const BACK = /(back|rear|environment|world|trasera|arrière)/i;
const FRONT = /(front|user|selfie|facetime|delantera|avant)/i;

/**
 * The next camera after `currentId`, or null when there is nothing to switch
 * to. Deliberately NOT "the other one": a phone can report three or four
 * cameras (wide, ultra-wide, telephoto), and cycling through all of them is
 * what the button promises.
 *
 * Preference, when the current camera is not in the list (which happens: a
 * track started with facingMode carries a deviceId the enumeration has not
 * given labels to yet): go to the first camera that faces the OTHER way if the
 * labels say which way that is, else the first camera that is not the current
 * one.
 */
export function nextCamera(cameras: Camera[], currentId?: string | null): Camera | null {
  const list = (cameras ?? []).filter((c) => c && c.deviceId);
  if (list.length < 2) return null;

  const at = currentId ? list.findIndex((c) => c.deviceId === currentId) : -1;
  if (at >= 0) return list[(at + 1) % list.length] ?? null;

  const facing = list.find((c) => BACK.test(c.label ?? ''))
    ?? list.find((c) => FRONT.test(c.label ?? ''));
  return facing ?? list[0] ?? null;
}

/**
 * What to call the button's action: "Switch to back camera" says more than
 * "Switch camera" when the labels tell us which is which, and exactly as much
 * when they do not (they are blank until camera permission is granted).
 */
export function switchLabel(next: Camera | null): string {
  if (!next) return 'Switch camera';
  if (BACK.test(next.label ?? '')) return 'Switch to back camera';
  if (FRONT.test(next.label ?? '')) return 'Switch to front camera';
  return 'Switch camera';
}
