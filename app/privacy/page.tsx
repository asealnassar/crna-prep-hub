import type { Metadata } from 'next'
import Link from 'next/link'
import PrivacyChoicesButton from './PrivacyChoicesButton'

export const metadata: Metadata = {
  title: 'Privacy Policy | CRNA Prep Hub',
  description:
    'What CRNA Prep Hub collects, why, who it is shared with, and how to change your privacy choices or delete your data.',
}

const UPDATED = '22 September 2026'
const CONTACT = 'support@crnaprephub.com'

/**
 * The privacy policy.
 *
 * Written to be read. Every claim on this page is one the code actually
 * honours — the cookie table matches what the tracker sets, the retention
 * period matches analytics_prune's default, and the advertising section names
 * the two tags that are really in app/layout.tsx. If any of those change, this
 * page is wrong and has to change with them.
 */
export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-slate-200 bg-gradient-to-br from-indigo-50 to-white">
        <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
          <Link href="/" className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">
            CRNA Prep Hub
          </Link>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-slate-600">Last updated {UPDATED}</p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="space-y-10 text-[15px] leading-relaxed text-slate-700">
          <section>
            <p>
              CRNA Prep Hub helps nurses research CRNA programs and prepare their applications.
              This policy explains what we collect, why we collect it, who sees it, and what
              you can do about it. It is written to be read rather than to be survived.
            </p>
          </section>

          <Section title="Information you give us">
            <Item label="Account details">
              Your email address and a password when you register. Passwords are handled by our
              authentication provider, Supabase, and stored as salted hashes. We never see or
              store your password.
            </Item>
            <Item label="Content you create">
              Mock interview answers, personal statements, resumes, GPA and transcript figures,
              school notes and messages you send us. This is yours. We do not sell it and we do
              not share it with advertisers.
            </Item>
            <Item label="Payment details">
              Payments are processed by <External href="https://stripe.com/privacy">Stripe</External>.
              We never receive or store your card number. We keep a record of what was purchased
              and when, which is what our own accounting and your access depend on.
            </Item>
          </Section>

          <Section title="Artificial intelligence features">
            <p>
              The mock interview, resume review, personal statement analysis and transcript
              reading features work by sending the text you provide to{' '}
              <External href="https://openai.com/policies/privacy-policy">OpenAI</External>, which
              generates the response you see. That means the content you put into those tools
              leaves our servers and is processed by OpenAI under their terms.
            </p>
            <p className="mt-3">
              If there is anything you would not want a third-party provider to process, please
              do not put it into those features.
            </p>
          </Section>

          <Section title="Information we collect automatically">
            <p>
              We keep our own basic record of how the site is used, so we can tell which pages
              help people and where our visitors come from. When you allow it, we store:
            </p>
            <ul className="mt-3 list-disc space-y-1.5 pl-5">
              <li>a random identifier in a cookie, which identifies a browser and not a person;</li>
              <li>which pages were viewed, and in what order;</li>
              <li>
                the website that referred you — the site name only, such as{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5 text-[13px]">google.com</code>,
                never the full address;
              </li>
              <li>any campaign tag in the link you followed;</li>
              <li>whether you were on a phone, tablet or computer, and which browser family.</li>
            </ul>
            <p className="mt-3">
              We do <strong>not</strong> store your IP address, and we do not use fingerprinting
              or any other technique that would identify you across other websites. We never
              record the query string of a page address, because that is where things like
              password-reset tokens live.
            </p>
            <p className="mt-3">
              If you create an account, we link that browser identifier to your account so we can
              understand how people find us. If your browser sends a &ldquo;Do Not Track&rdquo;
              signal, we record nothing at all.
            </p>
          </Section>

          <Section title="Advertising">
            <p>
              We advertise on TikTok and Google. With your permission, both place their own
              cookies on your device and receive information about your visit, including the
              pages you view. When you register, we also tell TikTok that a registration
              happened, which includes the email address you used.
            </p>
            <p className="mt-3">
              None of this happens unless you have allowed advertising cookies. Their own
              policies govern what they do with it:{' '}
              <External href="https://policies.google.com/privacy">Google</External> and{' '}
              <External href="https://www.tiktok.com/legal/privacy-policy">TikTok</External>. You
              can also opt out of personalised Google advertising at{' '}
              <External href="https://adssettings.google.com">adssettings.google.com</External>.
            </p>
          </Section>

          <Section title="Cookies we use">
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[480px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-900">
                    <th className="py-2 pr-4 font-semibold">Cookie</th>
                    <th className="py-2 pr-4 font-semibold">Purpose</th>
                    <th className="py-2 font-semibold">Lasts</th>
                  </tr>
                </thead>
                <tbody className="text-slate-600">
                  <Row name="Supabase auth cookies" purpose="Keep you signed in. Required — the site cannot work without them." lasts="Session" />
                  <Row name="cph_consent" purpose="Remembers the privacy choices you made on this page." lasts="180 days" />
                  <Row name="cph_vid" purpose="A random id so we can tell a returning visitor from a new one." lasts="180 days" />
                  <Row name="cph_sid" purpose="A random id that groups one visit together." lasts="30 minutes" />
                  <Row name="Google and TikTok cookies" purpose="Advertising measurement, set by those companies." lasts="Set by them" />
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Your privacy choices">
            <p>
              You can change your mind at any time, and turning something off takes effect on the
              very next page you load.
            </p>
            <div className="mt-4">
              <PrivacyChoicesButton />
            </div>
            <p className="mt-4 text-sm text-slate-600">
              You can also clear these cookies at any time in your browser settings, and most
              browsers let you block them entirely.
            </p>
          </Section>

          <Section title="How long we keep things">
            <p>
              Usage records are deleted after 400 days. Your account and the content you created
              are kept until you ask us to delete them.
            </p>
          </Section>

          <Section title="Your rights">
            <p>
              Email <Mail /> to ask for a copy of your data, to correct it, or to delete your
              account and everything in it. We will respond within 30 days and we will not treat
              you differently for asking.
            </p>
            <p className="mt-3">
              Depending on where you live you may have additional rights — for example to object
              to processing, or to lodge a complaint with your local data protection authority.
              Write to us first and we will try to sort it out.
            </p>
          </Section>

          <Section title="Children">
            <p>
              This service is for adults pursuing graduate nursing education. It is not directed
              at anyone under 18 and we do not knowingly collect information from children.
            </p>
          </Section>

          <Section title="Changes to this policy">
            <p>
              If this policy changes we will update the date at the top of this page. If the
              change is significant, we will ask for your privacy choices again.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions about any of this: <Mail />.
            </p>
          </Section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-slate-500 sm:px-6">
          <span>&copy; 2026 CRNA Prep Hub</span>
          <div className="flex flex-wrap gap-4">
            <Link href="/" className="hover:text-slate-800">Home</Link>
            <Link href="/schools" className="hover:text-slate-800">Schools</Link>
            <Link href="/pricing" className="hover:text-slate-800">Pricing</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
      {children}
    </section>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="mt-3 first:mt-0">
      <strong className="font-semibold text-slate-900">{label}.</strong> {children}
    </p>
  )
}

function Row({ name, purpose, lasts }: { name: string; purpose: string; lasts: string }) {
  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="py-2.5 pr-4 font-mono text-[13px] text-slate-800">{name}</td>
      <td className="py-2.5 pr-4">{purpose}</td>
      <td className="py-2.5 whitespace-nowrap">{lasts}</td>
    </tr>
  )
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
    >
      {children}
    </a>
  )
}

function Mail() {
  return (
    <a
      href={`mailto:${CONTACT}`}
      className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
    >
      {CONTACT}
    </a>
  )
}
