// ============================================================================
//  The public careers page's two reads (decision 0010 §1). No session, no
//  credentials: these are the only Hire calls a stranger's browser makes.
//
//  Every "no" from the API is the same 404, and both functions turn it into
//  null — the page cannot tell, and does not try to tell, an unknown
//  organisation from one whose page is switched off.
// ============================================================================

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export interface CareersListItem {
  slug: string;
  title: string;
  location: string | null;
  employmentType: string;
  closingDate: string | null;
}

export interface CareersList { organisation: string; jobs: CareersListItem[] }

export interface CareersJob {
  organisation: string;
  slug: string;
  title: string;
  location: string | null;
  employmentType: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  qualification: string | null;
  skills: string[];
  vacancies: number;
  description: string | null;
  responsibilities: string | null;
  requirements: string | null;
  closingDate: string | null;
  salary: { min: number | null; max: number | null; currency: string; period: 'year' | 'month' } | null;
  privacyContact: string | null;
  applyOpen: boolean;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}/public/careers/${path}`, { credentials: 'omit', cache: 'no-store' });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export const fetchCareers = (site: string) => get<CareersList>(encodeURIComponent(site));
export const fetchCareersJob = (site: string, job: string) =>
  get<CareersJob>(`${encodeURIComponent(site)}/jobs/${encodeURIComponent(job)}`);

export const EMPLOYMENT: Record<string, string> = {
  full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', internship: 'Internship', temporary: 'Temporary',
};

export function closes(d: string | null): string | null {
  if (!d) return null;
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}
