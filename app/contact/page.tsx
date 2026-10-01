import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import ContactClient from './_ContactClient';
import { defaultOgImages } from '@/lib/seo/og-image';

export const metadata: Metadata = {
  title: 'Оставить заявку',
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
    </>
  );
}
