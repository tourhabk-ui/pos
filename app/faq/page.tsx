import type { Metadata } from 'next';
import { query } from '@/lib/database';
import { Header } from '@/components/layout/Header';
import FaqClient from './_FaqClient';
import { defaultOgImages } from '@/lib/seo/og-image';

// Рендер на каждый запрос. Без этого страница пререндерилась на сборке Docker,
// где базы нет, и навсегда отдавала «Вопросов пока нет» при тридцати вопросах
// в базе (аудит 01.10: x-nextjs-prerender, x-nextjs-cache: HIT). Тот же класс,
// что /svodka (#2119) и sitemap (#1053). Сторож: tests/unit/no-build-time-db.test.ts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Вопросы и ответы о турах на Камчатку',
  description: 'Ответы на 30+ вопросов о путешествии на Камчатку: когда ехать, вулканы, медведи, горячие источники, безопасность, цены, бронирование туров.',
  keywords: [
    'вопросы о турах на Камчатку',
    'Камчатка для туристов',
    'когда ехать на Камчатку',
    'вулканы Камчатки FAQ',
    'медведи Камчатка безопасность',
    'горячие источники Камчатка',
    'Долина гейзеров как добраться',
    'стоимость туров Камчатка',
  ],
  openGraph: {
    images: defaultOgImages(),
    title: 'Вопросы и ответы о турах на Камчатку',
    description: 'Всё, что нужно знать перед поездкой: вулканы, медведи, маршруты, цены, безопасность.',
    url: 'https://vedarai.ru/faq',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
  alternates: { canonical: 'https://vedarai.ru/faq' },
};

interface FaqRow {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  priority: number;
  helpful: number;
}

/**
 * null — запрос не выполнился. «Вопросов нет» и «не смогли спросить» — разные
 * ответы (§4.0): прежний пустой catch превращал отказ в «Вопросов пока нет».
 */
async function getFaqs(): Promise<FaqRow[] | null> {
  try {
    const result = await query<FaqRow>(
      `SELECT id::text, question, answer, category, priority, helpful
       FROM faqs
       ORDER BY priority ASC, helpful DESC, id
       LIMIT 100`,
      []
    );
    return result.rows;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[faq] вопросы не прочитаны:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return null;
  }
}

export default async function FaqPage() {
  const loaded = await getFaqs();
  const faqs = loaded ?? [];

  // FAQPage Schema.org — AI-боты и поисковики читают это как структурированные Q&A.
  // Без вопросов разметки нет: пустой mainEntity — невалидный FAQPage.
  const faqSchema = faqs.length > 0 ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.answer,
      },
    })),
  } : null;

  return (
    <>
      {faqSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
        />
      )}
      <Header />
      {/* Ответы рендерятся в разметке сразу (свёрнуты до клика) — отдельная
          скрытая копия для роботов больше не нужна. */}
      <FaqClient initialItems={faqs} initialFailed={loaded === null} />
    </>
  );
}
