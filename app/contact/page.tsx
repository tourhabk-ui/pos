import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import ContactClient from './_ContactClient';
import { defaultOgImages } from '@/lib/seo/og-image';
import { REQUISITES } from '@/lib/legal/requisites';

export const metadata: Metadata = {
  // На странице и форма заявки, и реквизиты с почтой (аудит vedarai.ru 01.10).
  title: 'Контакты и заявка на тур по Камчатке',
  description: 'Оставьте заявку на тур по Камчатке. Наши специалисты подберут маршрут под ваши пожелания.',
  keywords: [
    'туры Камчатка',
    'туроператор Камчатка',
    'экскурсии Камчатка',
    'Петропавловск-Камчатский туры',
    'заявка на тур Камчатка',
  ],
  alternates: { canonical: 'https://vedarai.ru/contact' },
  openGraph: {
    images: defaultOgImages(),
    title: 'Оставить заявку на тур по Камчатке',
    description: 'Подбор маршрута по Камчатке: вулканы, рыбалка, горячие источники, экспедиции с локальными операторами.',
    url: 'https://vedarai.ru/contact',
    type: 'website',
    locale: 'ru_RU',
    siteName: 'Ведар',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Оставить заявку на тур по Камчатке',
    description: 'Подберем маршрут и оператора под ваш формат отдыха на Камчатке.',
  },
};

export default function ContactPage() {
  // Страница контактов организации, а не второе «местное заведение»
  // (аудит 01.10): сама организация описана один раз в app/layout.tsx, здесь —
  // ссылка на неё. Прежний блок повторял LocalBusiness со ссылкой на
  // vk.com/kamchatourhub, который отвечает 404.
  const contactPageSchema = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    url: 'https://vedarai.ru/contact',
    name: 'Связаться с Ведаром',
    about: { '@id': 'https://vedarai.ru/#organization' },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(contactPageSchema) }}
      />
      <Header />
      <ContactClient />
      {/* Кто стоит за формой (аудит 01.10): на странице контактов не было ни
          почты, ни юрлица. Реквизиты — из единого источника
          lib/legal/requisites, руками не вписываются. */}
      <section aria-labelledby="contact-requisites" className="bg-[var(--bg-primary)]">
        <div className="max-w-lg mx-auto px-4 pb-16">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6">
            <h2 id="contact-requisites" className="text-lg font-semibold text-[var(--text-primary)] mb-4">
              Как ещё связаться
            </h2>
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="text-[var(--text-muted)]">Почта</dt>
                <dd>
                  <a href={`mailto:${REQUISITES.emailSupport}`} className="text-[var(--ocean)] hover:underline">
                    {REQUISITES.emailSupport}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Кузьмич, помощник Ведара</dt>
                <dd className="flex flex-wrap gap-x-4 gap-y-1">
                  <a href="https://t.me/kuzmichai_bot" className="text-[var(--ocean)] hover:underline" rel="noopener noreferrer" target="_blank">Telegram</a>
                  <a href="https://max.ru/id4101147649_bot" className="text-[var(--ocean)] hover:underline" rel="noopener noreferrer" target="_blank">MAX</a>
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Исполнитель</dt>
                <dd className="text-[var(--text-primary)]">
                  {REQUISITES.shortName}, ИНН {REQUISITES.inn}, ОГРН {REQUISITES.ogrn}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Адрес</dt>
                <dd className="text-[var(--text-primary)]">{REQUISITES.address}</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>
    </>
  );
}
