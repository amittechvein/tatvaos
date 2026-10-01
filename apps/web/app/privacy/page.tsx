import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * The privacy policy, public, no sign-in.
 *
 * Written 21 Sept 2026 because Google Play asks every app for a privacy policy
 * URL and there was none anywhere (tatvaos.com did not resolve; /privacy was a
 * 404). Amit: "Privacy policy url".
 *
 * EVERY SENTENCE HERE WAS CHECKED AGAINST THE CODE OR PRODUCTION THAT DAY.
 * Change the product and you may be changing this page. In particular:
 *   • OpenAI is named because production's AI settings point at
 *     api.openai.com, and the per-organisation switch (core.tenants.allow_ai)
 *     is OFF by default. The sentence mirrors the disclosure the API itself
 *     returns (OrgAiEndpoints) - keep the two saying the same thing.
 *     From 30 Sept 2026 the AI sentences are the AI constant below, copied
 *     from AiDisclosure.cs and checked by tests/ai/privacy-text-matches.py.
 *   • Live captions (lib/useCaptions.ts) are NOT described here yet: a
 *     Connect disclosure, kept out of the Mail AI text by Mr. Singh (1 Oct
 *     2026) until he writes that sentence.
 *   • Transcription: production had NO transcription service configured on
 *     21 Sept. ConnectNotesWorker.TranscribeAsync does NOT check allow_ai;
 *     if an outside transcription service is ever configured, that gap must be
 *     closed first or the "nothing is sent while AI is off" sentence is false.
 *   • SMS: Infobip or MSG91 (Shared/Notify/Notify.cs). Translation of mail is
 *     self-hosted LibreTranslate when switched on, so it names no vendor.
 *   • The mobile app has no analytics, advertising, crash-reporting or
 *     location code (apps/mobile/package.json) - Play's data safety form
 *     says the same.
 * What the page PROMISES is customer-facing: changes go past the CTO.
 */

export const metadata: Metadata = {
  title: 'Privacy policy — TatvaOS',
  description: 'How TatvaOS handles the personal data of the people who use it.',
};

// The date the Mail AI text goes live. A placeholder until then: the page
// must not claim a date it was not published on (privacy-text-matches.py
// fails while any PENDING marker is left).
const UPDATED = '[PENDING: the date this text goes live]';

/**
 * What TatvaOS AI sends, WORD FOR WORD as apps/api/Shared/Ai/AiDisclosure.cs
 * (Mr. Singh, 30 Sept 2026: "in the same words everywhere"). The admin page
 * builds its sentences from those constants; tests/ai/privacy-text-matches.py
 * fails when any one of them is not here exactly. Edit both, or neither.
 */
const AI = {
  helpMeWrite: "the draft a person has typed, only when they ask for it to be rewritten",
  suggestedReplies: "the sender's name, the subject and the new text of an email, when a person opens it",
  summarise: "the sender's name, the date and the new text of each email in a conversation, when a person asks for a summary",
  sorting: "the sender's name, the subject and the first 1,000 characters of the new text of every new email that arrives, including ones about health, children or money, without anyone clicking anything",
  neverSent: "The sender's email address, earlier messages quoted below the new text, attachments and junk mail are never sent. Suggested replies and sorting also skip mail your organisation sent and mail from automated senders.",
  whoDecides: "Mail AI is off by default. Only your organisation's administrator can turn it on, and they can turn each feature off again at any time. When Mail AI is turned on, Help me write starts on; suggested replies, Summarise and sorting stay off until the administrator turns each one on. Sorting is not offered to hospitals and clinics.",
  retention: "OpenAI does not use what we send to train its models. OpenAI keeps it for up to 30 days to check for misuse, unless the law requires it to be kept longer.",
  meetingNotes: "the meeting's transcript",
  toWhom: 'OpenAI, in the United States',
};
const CONTACT = 'support@tatvaos.com';

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-8 text-base font-semibold text-ink">{children}</h2>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-sm leading-relaxed text-ink-muted">{children}</p>;
}

function L({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mb-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-muted">
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </ul>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10">
      <article className="mx-auto w-full max-w-[720px] rounded-card border border-line bg-surface p-6 shadow-card sm:p-10">
        <h1 className="mb-1 text-2xl font-semibold text-ink">Privacy policy</h1>
        <p className="mb-6 text-xs text-ink-muted">Last updated {UPDATED}</p>

        <P>
          TatvaOS is a workspace for organisations: mail, video meetings, files, calendar and
          contacts, on the web and in the TatvaOS app for Android. It is provided by Techvein IT
          Solutions Pvt. Ltd. (&ldquo;Techvein&rdquo;, &ldquo;we&rdquo;). This page explains what
          personal data TatvaOS handles, why, and the choices you have.
        </P>

        <H>Who is responsible for your data</H>
        <P>
          You use TatvaOS through an account your organisation gave you, such as your employer or
          school. Your organisation decides who gets an account, which products they can use and
          how long data is kept. We handle your data on your organisation&rsquo;s behalf and
          according to its settings. For most requests about your data, speak to your
          organisation&rsquo;s administrator first.
        </P>

        <H>What we collect</H>
        <L items={[
          <><strong className="text-ink">Account details:</strong> your name, work email address, role,
            and a mobile number or personal recovery email if you or your administrator add one.</>,
          <><strong className="text-ink">What you create:</strong> emails and their attachments, contacts,
            calendar events, files you store, and messages sent in meeting chat.</>,
          <><strong className="text-ink">Meetings:</strong> your audio, video and screen are relayed live to
            the other people in the meeting. A meeting is recorded only when its host starts
            recording or sets it to record automatically, and everyone in the meeting is told when
            recording starts. Recordings can produce written notes of the meeting. Meetings of the
            &ldquo;Private&rdquo; type are encrypted end to end and cannot be recorded.</>,
          <><strong className="text-ink">Security records:</strong> when and from where you sign in
            (including IP address and the app or browser used), and a record of important actions in
            your account, kept to protect it and investigate misuse.</>,
        ]} />

        <H>The Android app</H>
        <L items={[
          'It uses your camera and microphone only in a meeting, and only while you have them turned on.',
          'It captures your screen only after you choose to share it, and stops when you stop sharing.',
          'It keeps your sign-in securely on the device so you do not have to sign in every time.',
          'It shows a notification while you are sharing your screen, as Android requires.',
          'It does not use your location, does not read the contacts on your phone, and contains no advertising, analytics or tracking tools.',
        ]} />

        <H>How we use it</H>
        <P>
          Only to run TatvaOS for you and your organisation: delivering your mail, connecting your
          meetings, keeping your files, signing you in securely, preventing abuse, and giving your
          administrator the controls they need. We do not sell personal data, and we do not use it
          for advertising.
        </P>

        <H>Where it is stored</H>
        <P>
          On servers in Mumbai, India. Backups are kept so that data can be restored after a fault.
        </P>

        <H>Who else receives it</H>
        <P>We share personal data only in these cases:</P>
        <L items={[
          <><strong className="text-ink">Text messages:</strong> to send you a one-time sign-in or recovery
            code, your mobile number and the code are passed to our SMS provider (Infobip or MSG91).</>,
          <><strong className="text-ink">AI features, only if your organisation turns them on:</strong>{' '}
            TatvaOS AI is off unless your organisation&rsquo;s administrator switches it on. Meetings and
            mail are switched on separately, and in mail each feature has its own switch. When a feature
            is on, the following is sent to {AI.toWhom}:
            <ul className="mt-1.5 list-[circle] space-y-1 pl-5">
              <li>for meeting notes: {AI.meetingNotes};</li>
              <li>Help me write: {AI.helpMeWrite};</li>
              <li>Suggested replies: {AI.suggestedReplies};</li>
              <li>Summarise conversation: {AI.summarise};</li>
              <li>Sort incoming mail: {AI.sorting}.</li>
            </ul>
            <span className="mt-1.5 block">
              {AI.neverSent} {AI.whoDecides} {AI.retention} Nothing is sent while these are off.
            </span></>,
          <><strong className="text-ink">The people you communicate with:</strong> the recipients of your
            emails, the participants in your meetings, and anyone you share a file with.</>,
          <><strong className="text-ink">The law:</strong> when we are legally required to, for example by a
            valid order from an Indian court or authority.</>,
        ]} />

        <H>How long we keep it</H>
        <P>
          For as long as your organisation uses TatvaOS, unless you or your administrator delete it
          sooner. Deleted email goes to Trash and is removed from there. When your organisation stops
          using TatvaOS, it can ask us to delete its data, apart from records we must keep for security
          or by law.
        </P>

        <H>How we protect it</H>
        <P>
          Everything travels encrypted between your device and our servers. Each organisation&rsquo;s
          data is kept separate from every other&rsquo;s. Passwords are stored only in a form that
          cannot be read back, and two-step sign-in is available.
        </P>

        <H>Your choices and rights</H>
        <P>
          You can ask to see, correct or delete your personal data, through your organisation&rsquo;s
          administrator or by writing to us. Depending on where you are, you may also have rights under
          the law, such as India&rsquo;s Digital Personal Data Protection Act, 2023.
        </P>

        <H>Children</H>
        <P>
          TatvaOS is provided to organisations, including schools. Where an organisation gives accounts
          to children, it is responsible for obtaining consent from a parent or guardian as the law
          requires.
        </P>

        <H>Changes to this policy</H>
        <P>
          If we change how we handle personal data, we will update this page and its date, and tell
          organisations about important changes.
        </P>

        <H>Contact</H>
        <P>
          Questions or requests: <a className="text-brand-600 hover:underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </P>

        <p className="mt-10 text-xs text-ink-muted">
          <Link className="hover:underline" href="/login">Sign in to TatvaOS</Link>
        </p>
      </article>
    </main>
  );
}
