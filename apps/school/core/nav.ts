import type { Account } from "./accounts";
import type { School } from "./api";

/** The first screen for this phone: home when signed in, sign-in when a school is saved, else welcome (FR-C01). */
export function routeFor(active: Account | null, school: School | null) {
  if (active) return active.role === "STUDENT" ? "/home" : "/staff";
  return school ? "/sign-in" : "/welcome";
}
