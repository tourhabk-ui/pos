/**
 * Список лежит в группе `(list)` вместе со своим `loading.tsx` намеренно.
 * Файл загрузки раздела оборачивает и ВЛОЖЕННЫЕ адреса: пока он стоял в
 * корне раздела, карточка под ним отдавала скелет со статусом 200 раньше, чем
 * успевала сказать «не найдено» или «переехало», — 404 и 308 карточек
 * становились soft-404 и meta-refresh (аудит SEO 29.09, Н2). Группа не
 * меняет адрес, а скелет списка остаётся мгновенным (navigation-loading).
 */
import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import MarketplaceClient from '@/components/marketplace/MarketplaceClient';
import BottomNav from '@/components/shared/BottomNav';
import { CatalogFooter } from '@/components/marketplace/CatalogFooter';
import KuzmichContacts from '@/components/shared/KuzmichContacts';
import {
  queryMarketplaceToursForPage,
  queryCatalogSummaryForPage,
  type MarketplaceToursResult,
  type CatalogSummary,
} from '@/lib/search';
import { parseMarketplaceSearchParams, buildToursItemListJsonLd } from '@/lib/tours/marketplace-page';
import { defaultOgImages } from '@/lib/seo/og-image';
import { catalogHreflang } from '@/lib/zh/pages';
import { plural } from '@/lib/home/data-freshness';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Туры на Камчатку 2026 — цены и даты от местных операторов',
  description: 'Туры на Камчатку 2026: вулканы, рыбалка, медведи, термальные источники — цены и свободные даты от местных операторов, заявка без комиссии.',
  keywords: [
    'туры Камчатка',
    'туры Камчатка 2026',
    'рыбалка Камчатка тур',
    'бронирование туров Камчатка',
    'рыболовные туры Камчатка',
    'восхождение на вулканы Камчатка',
    'термальные источники тур',
  ],
  alternates: {
    canonical: `${SITE}/catalog`,
    languages: catalogHreflang(SITE),
  },
  openGraph: {
    images: defaultOgImages(),
    title: 'Туры на Камчатку 2026 — цены и даты от местных операторов',
    description: 'Туры по Камчатке: программа, цена и условия на виду, потом заявка оператору.',
    type: 'website',
    url: `${SITE}/catalog`,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Туры на Камчатку 2026 — цены и даты от местных операторов',
    description: 'Каталог реальных туров от операторов Камчатки с прозрачными условиями.',
  },
};

/**
 * Сервер НЕ читает `searchParams` (аудит 02.10): ожидание этого промиса
 * само по себе делает страницу потоковой — в первом HTML пустой каркас с
 * `<template>`, а туры приезжают отдельным куском, который робот без JS не
 * собирает. Сервер рендерит список по умолчанию, фильтры из адреса применяет
 * клиент после монтирования (`MarketplaceClient`).
 *
 * У /catalog остаётся ВТОРАЯ граница — скелет `loading.tsx` в группе (list):
 * он нужен переходу с таб-бара на медленной сети (navigation-loading, полевой
 * прогон 04.08), и из-за него список по-прежнему уезжает вторым куском. Снять
 * скелет ради роботов без JS — решение владельца, не этой правки; /operators,
 * где скелета нет, отдаёт список в первом HTML. Сторож:
 * tests/unit/list-pages-not-streamed.test.ts.
 */
export default async function CatalogPage() {
  const { filters, initialKey } = parseMarketplaceSearchParams({});

  // Отказ не глушится (§4.0): null — «не знаю», клиент дозапросит туры сам,
  // а в лог уходит имя запроса и SQLSTATE.
  const [toursRes, summaryRes] = await Promise.allSettled([
    queryMarketplaceToursForPage(filters),
    queryCatalogSummaryForPage(),
  ]);
  const initial: MarketplaceToursResult | null = toursRes.status === 'fulfilled' ? toursRes.value : null;
  const summary: CatalogSummary | null = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
  for (const [name, r] of [['tours', toursRes], ['summary', summaryRes]] as const) {
    if (r.status === 'rejected') {
      const e = r.reason as { code?: string; message?: string } | undefined;
      console.error('[/catalog] SSR: запрос ' + name + ' не выполнен', { sqlstate: e?.code, message: e?.message });
    }
  }

  const structuredData = initial ? buildToursItemListJsonLd(initial.tours, SITE, '/catalog') : null;

  // Короткий FAQ под коммерческий запрос «туры на Камчатку» (аудит AI-видимости
  // 30.10). Число туров — из ответа БД, без него фраза без числа (§4.0).
  const total = initial?.total ?? 0;
  const faq = [
    {
      question: 'Где купить тур на Камчатку?',
      answer: `В этом каталоге — ${total > 0 ? `${total} ${plural(total, 'тур', 'тура', 'туров')}` : 'туры'} местных операторов Камчатки с программой, ценой и датами. Выберите тур и отправьте заявку: оператор подтверждает её сам.`,
    },
    {
      question: 'Ведар Камчатка — турагентство?',
      answer: 'Нет. Ведар — бесплатный для туриста информационный портал. Тур выполняет местный оператор под своим именем.',
    },
    {
      question: 'Как забронировать тур?',
      answer: `Откройте тур и отправьте заявку на дату; порядок бронирования описан на странице ${SITE}/bronirovanie-turov-kamchatka.`,
    },
  ];
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })),
  };

  return (
    <>
      {structuredData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      )}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
      <Header />
      <MarketplaceClient
        initialTours={initial?.tours ?? []}
        initialTotal={initial?.total ?? 0}
        initialDay={initial?.day ?? null}
        initialKey={initial === null ? null : initialKey}
        summary={summary}
      />
      <section aria-labelledby="catalog-faq" className="mx-auto w-full max-w-[1280px] px-6 xl:px-8 pb-6">
        <h2 id="catalog-faq" className="ds-h2 mb-3">Частые вопросы о турах на Камчатку</h2>
        <dl className="space-y-3">
          {faq.map((f) => (
            <div key={f.question}>
              <dt className="font-medium text-[var(--text-primary)]">{f.question}</dt>
              <dd className="text-sm text-[var(--text-secondary)]">{f.answer}</dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="mx-auto w-full max-w-[1280px] px-6 xl:px-8 pb-10">
        <KuzmichContacts />
      </div>
      <CatalogFooter />
      {/* Таб-бар с активным «Туры»: пункт объявлен activeOn для этих путей
          (BottomNav.tsx), а страницы его не рендерили — подсветка не
          срабатывала нигде (аудит П5, #56/#62/#98). На md+ он скрыт сам. */}
      <BottomNav activePath="/catalog" />
    </>
  );
}
