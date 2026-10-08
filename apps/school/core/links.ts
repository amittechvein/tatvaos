/** The app screen for a notification's link (web paths), or null when the app has no such screen. */
export function appRouteFor(link: string | null): string | null {
  if (!link) return null;
  const path = link.replace(/^https?:\/\/[^/]+/, "");
  if (/homework/i.test(path)) return "/homework";
  if (/announcement|notice/i.test(path)) return "/notices";
  if (/fee|payment|receipt/i.test(path)) return "/fees";
  if (/attendance|leave/i.test(path)) return "/attendance";
  if (/calendar|event/i.test(path)) return "/calendar";
  return null;
}
