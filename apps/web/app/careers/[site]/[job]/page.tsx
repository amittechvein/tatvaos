'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';

import { Spinner } from '@/components/ui/Kit';
import { closes, EMPLOYMENT, fetchCareersJob, type CareersJob } from '@/lib/careers';

// ============================================================================
//  One public job (decision 0010 §1).
//
//  The long fields are PLAIN TEXT, rendered as text with their line breaks —
//  the standing rule from #262: strangers read this, so nothing here is ever
//  treated as HTML and there is no sanitiser to get wrong.
//
//  No application form yet (0010 §5–§7 come next, with the consent notice).
//  The privacy contact is shown already, because it will be the first thing
//  a candidate needs once they can apply.
// ============================================================================

function money(n: number | null) {
  return n === null ? null : n.toLocaleString('en-IN');
}

export default function CareersJobPage({ params }: { params: Promise<{ site: string; job: string }> }) {
  const { site, job } = use(params);
  const [data, setData] = useState<CareersJob | null | 'loading'>('loading');

  useEffect(() => {
    let alive = true;
    void fetchCareersJob(site, job).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [site, job]);

  if (data === 'loading') return <main className="flex min-h-screen items-center justify-center bg-canvas"><Spinner /></main>;

  if (data === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md rounded-card border border-line bg-surface p-8 text-center shadow-raised">
          <h1 className="mb-2 text-lg font-semibold text-ink">This position is not open</h1>
          <p className="text-sm text-ink-muted">It may have been filled or closed.</p>
          <Link href={`/careers/${site}`} className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">
            See current openings
          </Link>
        </div>
      </main>
    );
  }

  const exp = data.experienceMinYears !== null || data.experienceMaxYears !== null
    ? data.experienceMaxYears === null ? `${data.experienceMinYears}+ years`
      : data.experienceMinYears === null ? `Up to ${data.experienceMaxYears} years`
      : `${data.experienceMinYears}–${data.experienceMaxYears} years`
    : null;
  const pay = data.salary
    ? `${data.salary.currency} ${[money(data.salary.min), money(data.salary.max)].filter(Boolean).join(' – ')} a ${data.salary.period}`
    : null;

  const section = (title: string, text: string | null) => text && (
    <section className="mb-6">
      <h2 className="mb-2 text-[15px] font-semibold text-ink">{title}</h2>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{text}</p>
    </section>
  );

  return (
    <main className="min-h-screen bg-canvas px-4 py-10">
      <article className="mx-auto w-full max-w-3xl">
        <Link href={`/careers/${site}`} className="text-sm text-ink-muted hover:underline">← {data.organisation} careers</Link>
        <h1 className="mt-3 text-2xl font-semibold text-ink">{data.title}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {[data.location, EMPLOYMENT[data.employmentType] ?? data.employmentType,
            data.vacancies > 1 ? `${data.vacancies} positions` : null].filter(Boolean).join(' · ')}
        </p>

        <dl className="my-6 grid gap-x-6 gap-y-2 rounded-card border border-line bg-surface p-5 text-sm sm:grid-cols-2">
          {exp && <><dt className="text-ink-muted">Experience</dt><dd className="text-ink">{exp}</dd></>}
          {data.qualification && <><dt className="text-ink-muted">Qualification</dt><dd className="text-ink">{data.qualification}</dd></>}
          {pay && <><dt className="text-ink-muted">Pay</dt><dd className="text-ink">{pay}</dd></>}
          {data.closingDate && <><dt className="text-ink-muted">Apply by</dt><dd className="text-ink">{closes(data.closingDate)}</dd></>}
          {data.skills.length > 0 && <><dt className="text-ink-muted">Skills</dt><dd className="text-ink">{data.skills.join(', ')}</dd></>}
        </dl>

        {section('About the role', data.description)}
        {section('Responsibilities', data.responsibilities)}
        {section('Requirements', data.requirements)}

        <div className="mt-8 rounded-card border border-line bg-surface p-5 text-sm">
          <p className="font-medium text-ink">Applications through this page are not open yet.</p>
          {data.privacyContact && (
            <p className="mt-2 text-ink-muted">Questions about your personal data: {data.privacyContact}</p>
          )}
        </div>

        <p className="mt-10 text-center text-xs text-ink-faint">Careers page by TatvaOS Hire</p>
      </article>
    </main>
  );
}
