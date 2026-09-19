import Link from 'next/link';
import { BrandMark, BrandName } from '@/components/ui/Brand';

// ============================================================================
//  The Platform page — core.tatvaos.com/platform. The developer console:
//  where TatvaOS faces programs rather than people. (platform.tatvaos.com
//  used to be its own door; since 17 Sept 2026 that host 301s here, path
//  preserved, and keeps answering until its DNS retires — see
//  infra/docker/conf.d/platform.caddy.)
//
//  DELIBERATELY STATIC AND SERVER-RENDERED: this page is what a client's
//  developer reads before they have signed in to anything, so it must not
//  require auth, must not fetch, and must say true things only. Everything
//  that needs an account (generating an app password, and later API keys)
//  links INTO the product where auth already lives, rather than reinventing
//  a session here.
//
//  The connection settings are duplicated from MailAppPasswordEndpoints'
//  settings block — acceptable for a static page, and the risk is named:
//  IF A PORT OR HOST EVER CHANGES, CHANGE IT THERE AND HERE. The API remains
//  the authority; this is the brochure.
// ============================================================================

const mono = 'rounded bg-canvas px-1.5 py-0.5 font-mono text-[13px] text-ink';

export default function DeveloperConsolePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      {/* The product mark, from /brand like every other door's. Plain <img>
          rather than next/image: two small static PNGs on a static page need
          no optimisation pipeline, and this page must stay dependency-free. */}
      <div className="flex items-center gap-3">
        <BrandMark product="platform" width={44} height={44} />
        <BrandName product="platform" alt="TatvaOS Platform" width={132} height={66}
                   className="h-11 w-auto" />
      </div>
      <h1 className="mt-6 text-3xl font-bold tracking-tight text-ink">
        Connect your software to TatvaOS
      </h1>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-muted">
        Settings and credentials for using TatvaOS from outside TatvaOS — a mail
        client, a phone, or your own software.
      </p>

      {/* ---- Mail client settings -------------------------------------- */}
      <section className="mt-10 rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="text-lg font-semibold tracking-tight text-ink">
          Use your mailbox from any mail app
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Outlook, Thunderbird, Apple Mail, a phone — or software that sends mail
          for you, like an ERP or a school-management system.
        </p>

        <dl className="mt-5 grid grid-cols-[150px_1fr] gap-y-2 text-sm">
          <dt className="text-ink-muted">Incoming (IMAP)</dt>
          <dd><span className={mono}>mail.tatvaos.com</span> · port <span className={mono}>993</span> · SSL/TLS</dd>
          <dt className="text-ink-muted">Outgoing (SMTP)</dt>
          <dd><span className={mono}>mail.tatvaos.com</span> · port <span className={mono}>587</span> · STARTTLS</dd>
          <dt className="text-ink-muted">Username</dt>
          <dd>your full address, e.g. <span className={mono}>you@yourschool.com</span></dd>
          <dt className="text-ink-muted">Password</dt>
          <dd>an <strong>app password</strong> — never your TatvaOS sign-in password</dd>
        </dl>

        <p className="mt-5 text-sm text-ink-muted">
          Generate your app password in{' '}
          <Link href="/mail/settings/app-passwords" className="font-medium text-brand-600 hover:underline">
            Mail → Settings → App passwords
          </Link>
          . It is shown once, works only for mail, and can be revoked without
          touching anything else you can sign in to.
        </p>
      </section>

      {/* ---- What's coming --------------------------------------------- */}
      <section className="mt-6 rounded-card border border-dashed border-line bg-surface/50 p-6">
        <h2 className="text-lg font-semibold tracking-tight text-ink">APIs — being built</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Programmatic access for organisations, authenticated by API keys
          managed here. Planned first, in order:
        </p>
        <ul className="mt-4 space-y-2 text-sm text-ink-muted">
          <li>· <strong className="text-ink">People</strong> — create and deactivate users in your organisation</li>
          <li>· <strong className="text-ink">Mailboxes</strong> — create addresses as you onboard staff</li>
          <li>· <strong className="text-ink">Meetings</strong> — create TatvaOS Connect meetings from your own systems</li>
        </ul>
        <p className="mt-4 text-xs text-ink-faint">
          Nothing on this list is callable yet — this page will carry the keys
          and the documentation when each one ships, and nothing ships here
          before it works.
        </p>
      </section>

      <p className="mt-10 text-xs text-ink-faint">
        Questions, or an integration this page doesn&rsquo;t cover yet? Write to{' '}
        <a href="mailto:support@tatvaos.com" className="text-brand-600 hover:underline">support@tatvaos.com</a>.
      </p>
    </main>
  );
}
