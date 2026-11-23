/**
 * Privacy Policy — English translation of /legal/privacy (17.11).
 *
 * Перевод русского оригинала, без новых обязательств: при правке
 * app/legal/privacy/page.tsx эту страницу нужно править тем же смыслом
 * (сторож tests/unit/legal-en-pages.test.tsx сверяет редакцию и разделы).
 * Реквизиты — из lib/legal/requisites, как записаны (по-русски), получатели —
 * из реестра lib/legal/third-party-registry.
 */
import Link from 'next/link';
import { pageContainer } from '@/lib/layout/page-width';
import { ChevronLeft } from 'lucide-react';
import PageShell from '@/components/shared/PageShell';
import { REQUISITES } from '@/lib/legal/requisites';
import { THIRD_PARTIES, crossBorderRecipients } from '@/lib/legal/third-party-registry';
import LegalLangSwitch from '@/components/legal/LegalLangSwitch';
import { legalAlternates } from '@/lib/legal/legal-i18n';

export const metadata = {
  alternates: legalAlternates('privacy', 'en'),
  // Перевод, не отдельный документ: GSC 18–21.11 давал показы на позиции ~4 без кликов.
  robots: { index: false, follow: true },
  // absolute: шаблон корневого layout дописал бы « | Ведар» к английской странице.
  title: { absolute: 'Privacy Policy | Vedar' },
  description: 'Vedar privacy policy (English translation): what personal data is processed, purposes and legal bases, storage, sharing and data subject rights.',
};

const h2 = 'text-xl font-semibold text-[var(--text-primary)] mt-8 mb-4';
const mail = <a href="mailto:info@vedarai.ru" className="text-[var(--ocean)] hover:underline">info@vedarai.ru</a>;

export default function PrivacyPageEn() {
  return (
    <PageShell title="Privacy Policy">
    <main lang="en" className="bg-transparent text-[var(--text-primary)] py-12">
      <div className={pageContainer('reading')}>
        <Link href="/" className="inline-flex items-center text-[var(--accent)] hover:text-[var(--accent)]/80 mb-8">
          <ChevronLeft className="w-5 h-5 mr-1" />
          Home
        </Link>

        <LegalLangSwitch doc="privacy" current="en" />

        <h1 className="text-3xl font-bold mb-8">Privacy Policy</h1>

        <div className="prose prose-invert max-w-none space-y-6 text-[var(--text-secondary)]">
          <p className="text-sm text-[var(--text-muted)]" data-testid="legal-translation-note">
            This is an English translation of the Russian original, provided for convenience. The original:{' '}
            <Link href="/legal/privacy" hrefLang="ru" lang="ru" className="text-[var(--ocean)] hover:underline">vedarai.ru/legal/privacy</Link>.
            Company details are given as registered, in Russian.
          </p>
          <p className="text-sm text-[var(--text-muted)]">Version of 20 November 2026. Effective upon publication.</p>

          <section>
            <h2 className={h2}>1. General provisions</h2>
            <p>
              This Privacy Policy (the “Policy”) sets out how personal data of users of the travel platform{' '}
              {REQUISITES.brand}{' '}
              (Vedar, vedarai.ru), owned by {REQUISITES.shortName} (OGRN {REQUISITES.ogrn}, INN {REQUISITES.inn})
              (the “Operator”), is collected, stored, used and protected.
            </p>
            <p>
              A notification of the intention to process personal data is submitted to Roskomnadzor
              before processing begins (Part 1, Article 22 of Federal Law No. 152-FZ of 27.07.2006).
              This page does not confirm that the Operator has been entered in the register: the entry can be checked
              in the register of operators at pd.rkn.gov.ru.
            </p>
            <p>
              The Policy has been drawn up in accordance with:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Federal Law No. 152-FZ of 27.07.2006 “On Personal Data”</li>
              <li>Federal Law No. 242-FZ of 21.07.2014 (localisation of data of citizens of the Russian Federation)</li>
              <li>Decree of the Government of the Russian Federation No. 1119 of 01.11.2012 (levels of protection)</li>
              <li>Federal Law No. 149-FZ of 27.07.2006 “On Information”</li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>2. Personal data processed</h2>
            <p>The Operator processes the following categories of personal data:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Identification data: surname, first name, patronymic</li>
              <li>Contact data: email address, phone number</li>
              <li>Account data: login, password hash, registration date</li>
              <li>Booking data: group composition, tour date, special requirements</li>
              <li>The Operator does not process payment data: the Platform does not accept payments, tourists
                  pay Partners directly</li>
              <li>Technical data: IP address, browser type, cookie data, browsing history, UTM tags</li>
              <li>Data on interaction with the AI assistant Kuzmich: dialogue history (chat_sessions), synthesised notes on the user’s interests (user_ai_memory), route photos sent by the user</li>
              <li>Lead form data: name, phone, email, budget, preferences — when tour request forms are filled in</li>
              <li>For Partners additionally: INN, OGRN/OGRNIP, bank details, information about the responsible person</li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>3. Purposes and legal bases of processing</h2>
            <p>Personal data is processed on the following legal bases:</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse mt-2">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="text-left py-2 pr-4 text-[var(--text-primary)]">Purpose</th>
                    <th className="text-left py-2 text-[var(--text-primary)]">Legal basis</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  <tr>
                    <td className="py-2 pr-4">User registration and identification</td>
                    <td className="py-2">Consent (clause 1, Part 1, Article 6 of 152-FZ)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Performance of the booking contract</td>
                    <td className="py-2">Contract (clause 5, Part 1, Article 6 of 152-FZ)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Notifications about booking status</td>
                    <td className="py-2">Contract (clause 5, Part 1, Article 6 of 152-FZ)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Personalisation of tour recommendations, operation of the AI assistant</td>
                    <td className="py-2">Consent (Article 16 of 152-FZ, automated processing)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Processing of lead requests and qualification of enquiries</td>
                    <td className="py-2">Consent (clause 1, Part 1, Article 6 of 152-FZ)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Marketing mailings</td>
                    <td className="py-2">Consent (clause 1, Part 1, Article 6 and Article 15 of 152-FZ)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Compliance with legal requirements</td>
                    <td className="py-2">Law (clause 2, Part 1, Article 6 of 152-FZ)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-sm">
              <strong>On automated processing (Article 16 of 152-FZ):</strong> the Platform generates
              individual tour recommendations and AI notes based on behavioural data (booking history,
              dialogues with Kuzmich, routes viewed, lead form data). Such processing is carried out
              solely for personalisation and has no legally significant consequences for the User.
              AI notes are stored only in an encrypted database and are not transferred to third parties.
              The User may opt out by sending a request to{' '}
              {mail}.
            </p>
            <p className="mt-4 text-sm">
              In accordance with Article 16 of Federal Law No. 152-FZ of 27.07.2006 (as amended
              in 2023), automated processing of personal data by the AI assistant is carried out
              solely on the basis of a separate, explicitly expressed consent of the personal data subject.
            </p>
          </section>

          <section>
            <h2 className={h2}>4. Storage and protection of data</h2>
            <p>
              Personal data is stored exclusively on servers located in the territory of the
              Russian Federation, in accordance with Part 5, Article 18 of Federal Law No. 152-FZ (as amended by Federal Law No. 242-FZ).
            </p>
            <p>
              Technical protection measures applied: encryption of data transmission channels (TLS 1.3),
              password hashing (bcrypt), role-based access control (RBAC), regular backups,
              anomaly monitoring.
            </p>
            <p>
              Retention periods:
            </p>
            <ul className="list-disc pl-6 space-y-1 text-sm">
              <li>Profile data — until the account is deleted or 3 years from the last activity (last sign-in to the Platform or registration)</li>
              <li>Booking history — 5 years from the tour date (tax and accounting requirements, Article 23 of the Tax Code of the Russian Federation)</li>
              <li>AI dialogue data (chat_sessions) — 3 years from the last interaction</li>
              <li>AI notes about the user (user_ai_memory) — until the account is deleted or upon request</li>
              <li>Lead form data — 3 years from the last change to the request (limitation period)</li>
              <li>Technical logs — 90 days from the time of the entry</li>
              <li>Data transferred under legal requirements — in accordance with the applicable retention periods</li>
            </ul>
            <p className="text-sm">
              Technical logs include logs of page visits and tour selection, browser
              errors, requests to the AI assistant and to the programming interfaces for AI agents, usage of
              language model requests, notifications, incoming notifications from external booking
              systems, as well as logs of account actions (registration, role change) and
              administrator actions. Entries older than 90 days are deleted. Entries for which the Platform
              keeps records for its entire period of operation (page visits, requests to programming interfaces,
              usage, granting of access rights, administrator actions) are kept, but without the IP address, browser
              data, the address of the page the visitor came from, visitor and calling-program
              identifiers, the text of the request to the programming interface, the email address
              and the INN. Logs of the Platform’s own operation that contain no user data (runs of
              service programs, synchronisations) are not covered by this period.
            </p>
          </section>

          <section>
            <h2 className={h2}>5. Transfer of data to third parties</h2>
            <p>
              The Operator transfers personal data to Partners (tour operators) only
              to the extent necessary to fulfil a specific booking (full name, contact details,
              group composition, special requirements).
            </p>
            <p>
              A request in which no provider is named (tour selection, trip plan, the “Contact” form)
              is visible to Partners — tour operators shown by the Platform in its showcase —
              and may be passed to several of them. The name, contact details and the text of the request are transferred.
              Consent to such transfer is requested in the request form as a separate text.
            </p>
            <p>
              In addition, code of third-party services runs on the Platform’s pages. The list below is
              not a paraphrase but the same list from which these services are actually loaded
              (<code>lib/legal/third-party-registry</code>): whatever is not listed here is not
              loaded.
            </p>
            <ul className="list-disc pl-6 space-y-1 text-sm">
              {THIRD_PARTIES.map((tp) => (
                <li key={tp.id}>
                  <strong>{tp.en.title}</strong>
                  {tp.en.entity ? ` (${tp.en.entity})` : ' (legal entity not established)'} — {tp.en.purpose}.
                  {' '}Domain: <code>{tp.host}</code>. Jurisdiction:{' '}
                  {tp.jurisdiction === 'RU' ? 'Russia' : tp.jurisdiction === 'unknown' ? 'not established' : tp.jurisdiction}.
                </li>
              ))}
            </ul>
            <p className="text-sm">
              These services are loaded <strong>only after your consent</strong>. Without consent
              the Platform works fully, and no data is transferred to them. You can change your decision by
              clearing the site data in your browser — the question will then be asked again.
            </p>
            {crossBorderRecipients().length > 0 && (
              <p className="text-sm">
                <strong>Cross-border transfer.</strong> Some recipients are located outside the
                Russian Federation:{' '}
                {crossBorderRecipients().map((t) => `${t.en.title} (${t.jurisdiction === 'unknown' ? 'jurisdiction not established' : t.jurisdiction})`).join(', ')}.
                The transfer takes place only with your consent to the relevant category.
              </p>
            )}
            <p>
              The Operator does not sell personal data to third parties for commercial purposes.
              Data may be transferred without the data subject’s consent only at the request of authorised
              state bodies in the manner established by the legislation of the Russian Federation.
            </p>
            <p>
              Notifications about requests containing the User’s name and contact phone number are sent
              to the Operator’s employees and to Partners via the Russian messenger <strong>MAX</strong>. The Telegram messenger is used by the Operator
              only for service messages that contain no personal data: the request number is sent there,
              while the name and phone number remain in MAX and in the personal account.
            </p>
            <p>
              In accordance with Article 12 of Federal Law No. 152-FZ, when AI services are used,
              requests may be sent to servers outside the Russian Federation. Before such sending, phone numbers
              and email addresses are automatically removed from the text of messages that a tourist writes to Kuzmich —
              on the website, in Telegram and MAX, and in the chat window on a partner’s website. The name and
              other information about oneself written in words are not recognised by this cleaning: they may go to the
              external service together with the question. Photos and voice messages sent to Kuzmich are received
              by the recognition model as they are. Therefore such requests are not fully anonymised: do not
              write in the chat anything you are not prepared to share.
            </p>

            <h3 id="alice" className="text-lg font-semibold text-[var(--text-primary)] mt-6 mb-3">
              Alice AI and the Yandex plugin platform
            </h3>
            <p>
              If you use Vedar through Alice AI, a service of Yandex LLC, Alice calls Vedar’s tools through
              the programming interface for AI agents (MCP) at <code>https://vedarai.ru/api/mcp</code>. Other
              AI agents use the same interface; everything below applies to them as well.
            </p>
            <p>
              <strong>What Vedar receives.</strong> Not your conversation with Alice, but a tool call: the
              tool name and the parameters Alice composed from your question, such as search words, a place,
              dates and the number of people. For a request, also the name, phone number and comment, if you
              gave them to Alice. What goes into a free-text field (search words, comment) is decided by
              Alice: it may include what you wrote about yourself. Each call also carries an IP address and
              the name of the calling program. Vedar does not ask for your Yandex account data, and no Vedar
              account is needed.
            </p>
            <p>
              <strong>A request is not sent by itself.</strong> A request call saves a draft and returns a
              link to a Vedar page. There you see what will be sent and to whom, give your consent to the
              processing of personal data yourself and press “Send”. Consent is recorded only from this page:
              Vedar does not record a consent flag that an AI agent passes in a call. The page cannot prove that
              a person, not a program, pressed “Send”: the AI agent sees the link too. Cancelling or moving a
              request through an AI agent works the same way: it is confirmed on a Vedar page. A request is not
              a booking: the provider confirms it.
            </p>
            <p><strong>Who receives the data.</strong></p>
            <ul className="list-disc pl-6 space-y-1 text-sm">
              <li>
                Yandex LLC receives Vedar’s answers to Alice’s calls. Vedar builds them from its own
                database: tours, places, conditions, free dates. The answers contain no information about other
                tourists; the answer to a request does not repeat your phone number. Yandex processes your
                conversation with Alice under its own rules.
              </li>
              <li>
                The provider of the request (tour operator, guide, carrier, accommodation host or rental
                company) receives it only after you send it on the Vedar page. A request without a named
                provider is seen by the tour operators on Vedar’s storefront, as stated above.
              </li>
              <li>Vedar staff receive a notification about the request via MAX, as stated above.</li>
              <li>
                External language models. No model is used when a tool is called: the answer is built from
                the database. After a request is sent, its comment may go to a model, for machine translation
                for the provider if it is not written in Russian, and for analysing the request and selecting
                tours for it. Before that, phone numbers and email addresses are removed from the text; the
                name and phone number from the request fields are not passed to the model.
              </li>
            </ul>
            <p><strong>Legal bases and retention periods.</strong></p>
            <ul className="list-disc pl-6 space-y-1 text-sm">
              <li>
                A request draft (name, phone number, comment and the other parameters) is processed as steps
                you started yourself to conclude a contract (clause 5, part 1, Article 6 of 152-FZ). It is not
                passed to anyone, and the link is valid for 60 minutes. When the request is sent, the name and
                phone number are erased from the draft at once; a draft that was not sent is deleted after the
                link expires, when the next draft is written or by the daily retention cleanup.
              </li>
              <li>
                A sent request is processed with your consent (clause 1, part 1, Article 6 of 152-FZ) and kept
                like a request from a website form: 3 years from its last change (section 4).
              </li>
              <li>
                The log of calls to the interface is kept to run and protect the service (clause 7, part 1,
                Article 6 of 152-FZ). It holds the tool name, the outcome, the duration, a daily hash of the
                caller (computed from the IP address and the program name with a secret salt; the IP address
                itself is not recorded) and the main call parameter: its name always, its value only for
                tools that read. The name of the calling program and the same hash are also recorded per day.
                After 90 days the hash and the parameter value are erased and the per-day records are deleted
                (section 4).
              </li>
              <li>
                To limit the number of requests from one number, Vedar keeps a hash of the phone number, not
                the number itself. These records are deleted after 30 days when the next request arrives, and no
                later than after 90 days, like technical logs (section 4).
              </li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>6. Rights of the personal data subject</h2>
            <p>In accordance with Articles 14–17 of Federal Law No. 152-FZ, the personal data subject has the right to:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Obtain information about the processing of their personal data</li>
              <li>Demand clarification of inaccurate or incomplete data</li>
              <li>Demand blocking or destruction of data in cases provided for by law</li>
              <li>Withdraw consent to processing at any time (withdrawal does not affect the lawfulness
                  of processing carried out before it was received)</li>
              <li>Appeal against actions or inaction of the Operator to Roskomnadzor (rkn.gov.ru)
                  or to a court</li>
            </ul>
            <p>
              Requests should be sent to{' '}
              {mail}.
              The response period is 10 working days from receipt of the request (Articles 14 and 20 of 152-FZ); it may be extended by no more than 5 working days, with notice to the data subject.
            </p>
          </section>

          <section>
            <h2 className={h2}>7. Cookies and analytics</h2>
            <p>
              The Platform uses cookies and similar technologies to ensure the operation
              of the service, authentication, remembering user settings and collecting aggregated
              analytical statistics (Yandex Metrica).
            </p>
            <p>
              The User can manage cookies through browser settings. Disabling functional cookies
              may cause certain sections of the Platform to work incorrectly.
            </p>
          </section>

          <section>
            <h2 className={h2}>8. Changes to the Policy</h2>
            <p>
              The Operator may amend this Policy. The current version is published at
              vedarai.ru/legal/privacy. In the event of material changes, Users are notified by
              email at least 10 days before the changes take effect.
            </p>
          </section>

          <section>
            <h2 className={h2}>9. Contacts and responsible person</h2>
            <p className="font-mono text-sm leading-7">
              Personal data operator:<br />
              {REQUISITES.shortName}, INN {REQUISITES.inn}, OGRN {REQUISITES.ogrn}<br />
              {REQUISITES.address}<br />
              Director: {REQUISITES.director}<br />
              Email for personal data matters: {mail}<br />
              User enquiries: {mail}
            </p>
          </section>
        </div>
      </div>
    </main>
    </PageShell>
  );
}
