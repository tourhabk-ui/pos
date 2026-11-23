/**
 * Terms of Use — English translation of /legal/terms (17.11).
 *
 * Перевод русского оригинала, без новых обязательств: при правке
 * app/legal/terms/page.tsx эту страницу нужно править тем же смыслом
 * (сторож tests/unit/legal-en-pages.test.tsx сверяет редакцию и разделы).
 * Реквизиты — из lib/legal/requisites, как записаны (по-русски).
 */
import Link from 'next/link';
import { pageContainer } from '@/lib/layout/page-width';
import { ChevronLeft } from 'lucide-react';
import PageShell from '@/components/shared/PageShell';
import { REQUISITES } from '@/lib/legal/requisites';
import LegalLangSwitch from '@/components/legal/LegalLangSwitch';
import { legalAlternates, LEGAL_DOC_PATHS } from '@/lib/legal/legal-i18n';

export const metadata = {
  alternates: legalAlternates('terms', 'en'),
  // Перевод, не отдельный документ: GSC 18–21.11 давал показы на позиции ~2–4 без кликов.
  robots: { index: false, follow: true },
  // absolute: шаблон корневого layout дописал бы « | Ведар» к английской странице.
  title: { absolute: 'Terms of Use | Vedar' },
  description: 'Vedar user agreement (English translation): tour requests, payment directly to the Partner, rules of use, liability and company details.',
};

const h2 = 'text-xl font-semibold text-[var(--text-primary)] mt-8 mb-4';
const mail = <a href="mailto:info@vedarai.ru" className="text-[var(--ocean)] hover:underline">info@vedarai.ru</a>;
const privacyLink = (
  <Link href={LEGAL_DOC_PATHS.privacy.en} className="text-[var(--ocean)] hover:underline">Privacy Policy</Link>
);

export default function TermsPageEn() {
  return (
    <PageShell title="Terms of Use">
    <main lang="en" className="bg-transparent text-[var(--text-primary)] py-12">
      <div className={pageContainer('reading')}>
        <Link href="/" className="inline-flex items-center text-[var(--accent)] hover:text-[var(--accent)]/80 mb-8">
          <ChevronLeft className="w-5 h-5 mr-1" />
          Home
        </Link>

        <LegalLangSwitch doc="terms" current="en" />

        <h1 className="text-3xl font-bold mb-8">User Agreement</h1>

        <div className="prose prose-invert max-w-none space-y-6 text-[var(--text-secondary)]">
          <p className="text-sm text-[var(--text-muted)]" data-testid="legal-translation-note">
            This is an English translation of the Russian original, provided for convenience. The original:{' '}
            <Link href="/legal/terms" hrefLang="ru" lang="ru" className="text-[var(--ocean)] hover:underline">vedarai.ru/legal/terms</Link>.
            Company details are given as registered, in Russian.
          </p>
          <p className="text-sm text-[var(--text-muted)]">Version of 5 October 2026. Effective upon publication.</p>

          <section>
            <h2 className={h2}>1. Terms and definitions</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Platform</strong> — the online service {REQUISITES.brand} (Vedar), located at vedarai.ru, owned by {REQUISITES.shortName} (INN {REQUISITES.inn}, OGRN {REQUISITES.ogrn})</li>
              <li><strong>Operator</strong> — {REQUISITES.shortName}, {REQUISITES.address}</li>
              <li><strong>User</strong> — an individual aged 18 or over who uses the Platform for personal, non-commercial purposes</li>
              <li><strong>Partner</strong> — a legal entity or individual entrepreneur providing tourism and related services through the Platform</li>
              <li><strong>Booking</strong> — a User’s request for a Partner’s service for the specified date and group composition, made through the Platform and confirmed by the Partner</li>
              <li><strong>Personal account</strong> — a protected section of the Platform, available after registration, for managing bookings and settings</li>
              <li><strong>Services</strong> — tours, transfers, excursions, equipment rental and other tourism services listed by Partners</li>
              <li><strong>AI assistant</strong> — the software service “Kuzmich”, providing personalised tour selection, answers to questions and help with booking based on natural language processing algorithms</li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>2. Subject of the Agreement</h2>
            <p>
              This User Agreement (the “Agreement”) is concluded between the Operator and the User
              in accordance with the Civil Code of the Russian Federation (Articles 435–444), Federal Law No. 149-FZ of 27.07.2006
              “On Information, Information Technologies and Protection of Information”, Law of the Russian Federation No. 2300-1 of 07.02.1992
              “On Protection of Consumer Rights”, and Federal Law No. 132-FZ of 24.11.1996 “On the Fundamentals of Tourist Activity in the Russian Federation”.
            </p>
            <p>
              The Platform is an information system and is not a tour operator, travel agent or
              aggregator: it publishes information about Partners’ services and passes Users’ requests
              to Partners. No contract for the provision of a service is concluded and no payment for it
              is made through the Platform. The Platform does not accept payment for Partners’ services and is not the Partners’ agent for receiving
              payments: payments for a service are made between the User and the Partner directly.
              The Operator is not a tour operator or travel agent within the meaning of Federal Law No. 132-FZ of 24.11.1996
              “On the Fundamentals of Tourist Activity in the Russian Federation”: the provider of the service
              is the Partner, whose name and registration details are stated on the service page.
              The Operator is responsible for the accuracy of the information provided to the User about the Partner and the
              service within the limits established by law, and is not responsible for the quality of services directly
              provided by Partners.
            </p>
            <p>
              Use of the Platform (including viewing pages) constitutes unconditional acceptance of the terms
              of this Agreement. If the User does not agree with the terms, they should immediately
              stop using the Platform.
            </p>
          </section>

          <section>
            <h2 className={h2}>3. Registration and account</h2>
            <p>
              Registration is required to make bookings and use extended functionality.
              The User must provide accurate and up-to-date data. Registration of persons under 18
              is allowed only with the written consent of a parent or legal representative.
            </p>
            <p>
              The User is responsible for keeping their credentials (login, password) safe and for
              all actions performed using their account. If unauthorised access is detected, the User must
              notify the Operator immediately
              at: {mail}.
            </p>
            <p>
              The Operator may suspend or delete an account in the event of a breach of this
              Agreement or of actions capable of causing damage to the Platform, Partners or other Users.
            </p>
          </section>

          <section>
            <h2 className={h2}>4. Booking and payment for services</h2>
            <p>
              Through the Platform, the User sends a request for a service to a Partner. A request is not
              a payment and does not oblige the User to pay before it is confirmed by the Partner. A booking
              is considered made after the Partner confirms the request.
            </p>
            <p>
              The Platform does not accept Users’ money. Payment for a service is made by the
              User directly to the Partner — by the method and to the details provided by the Partner.
              The cash receipt and payment documents are issued by the Partner.
            </p>
            <p>
              The contract for the provision of tourism services (including a contract for the sale of a tourist product)
              is concluded directly between the User and the Partner. The Platform is not a party to
              such a contract.
            </p>
            <p>
              Refunds are made by the Partner who received the payment, in accordance with the cancellation terms of the
              service stated on its page and the requirements of Law of the Russian Federation No. 2300-1 of 07.02.1992
              “On Protection of Consumer Rights” (including Article 31 — within 10 days from the date the
              claim is made). At the User’s request, the Platform passes the User’s claim to the Partner.
            </p>
          </section>

          <section>
            <h2 className={h2}>5. Rules for using the Platform</h2>
            <p>
              The User may use the AI assistant “Kuzmich” to select tours and make
              bookings. Interaction with the AI assistant is recorded in order to improve the quality of the
              service in accordance with the{' '}
              {privacyLink}.
            </p>
            <p>The User is prohibited from:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Posting knowingly false reviews and misleading information</li>
              <li>Using automated tools (bots, scrapers) without the Operator’s permission</li>
              <li>Attempting to bypass the Platform’s authorisation or security systems</li>
              <li>Infringing copyright and related rights of third parties when publishing materials</li>
              <li>Using the Platform for fraudulent, unlawful or other bad-faith purposes</li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>6. Liability of the parties</h2>
            <p>
              The Platform makes reasonable efforts to check Partners (document verification, monitoring
              of reviews), but does not guarantee the completeness of such checks and is not liable for the actions
              or inaction of Partners in the direct provision of services. All claims regarding the quality of services
              are made directly to the Partner.
            </p>
            <p>
              The Platform is not liable for interruptions in operation caused by force majeure,
              actions of third parties, or scheduled maintenance.
            </p>
            <p>
              The Platform does not accept payment for Partners’ services and is not a party to the contract for their
              provision: the Partner is responsible for providing the service, its payment and refunds.
              The Operator’s liability is limited to the accuracy of the information it has published,
              within the limits established by Law of the Russian Federation No. 2300-1 of 07.02.1992 “On Protection of Consumer Rights”.
            </p>
          </section>

          <section>
            <h2 className={h2}>7. Intellectual property</h2>
            <p>
              All rights to the Platform’s intellectual property (design, software code,
              graphic elements, trade designations, algorithms) belong to the Operator or are used
              on lawful grounds. Reproduction, distribution and other use without the written
              permission of the Operator is prohibited.
            </p>
            <p>
              By posting reviews, photos and other content on the Platform, the User grants the Operator
              a non-exclusive, royalty-free licence to use such content for the purposes of
              operating and promoting the Platform.
            </p>
          </section>

          <section>
            <h2 className={h2}>8. Personal data</h2>
            <p>
              Personal data is processed in accordance with the Privacy Policy
              and the requirements of Federal Law No. 152-FZ of 27.07.2006 “On Personal Data”.
              The purposes, scope and procedure of data processing are described in detail in the{' '}
              {privacyLink}.
            </p>
          </section>

          <section>
            <h2 className={h2}>9. Amendment and termination of the Agreement</h2>
            <p>
              The Operator may unilaterally amend the terms of the Agreement. Notice of
              changes is published on this page at least 10 (ten) days before they
              take effect. The current version is always available at vedarai.ru/legal/terms.
            </p>
            <p>
              Continued use of the Platform after the changes take effect constitutes the
              User’s consent to the new version of the Agreement.
            </p>
          </section>

          <section>
            <h2 className={h2}>10. Governing law and dispute resolution</h2>
            <p>
              This Agreement is governed by the laws of the Russian Federation.
              The parties undertake to take measures to settle disputes out of court
              within 30 (thirty) days from the date a claim is made.
            </p>
            <p>
              If no agreement is reached, the dispute is referred to the court at the location
              of the Operator — Kamchatka Krai, Petropavlovsk-Kamchatsky — unless otherwise provided by
              mandatory rules of law on the jurisdiction of consumer disputes.
            </p>
          </section>

          <section>
            <h2 className={h2}>11. Operator details</h2>
            <p className="font-mono text-sm leading-7">
              {REQUISITES.fullName}<br />
              INN: {REQUISITES.inn}<br />
              OGRN: {REQUISITES.ogrn}<br />
              Legal address: {REQUISITES.address}<br />
              Director: {REQUISITES.director}<br />
              Email: {mail}<br />
              User support: {mail}
            </p>
          </section>
        </div>
      </div>
    </main>
    </PageShell>
  );
}
