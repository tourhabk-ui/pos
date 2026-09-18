/**
 * /plans — хаб готовых планов («Мой план 2.0», A-1).
 * Внутренняя перелинковка программатик-страниц + вход в живой планировщик.
 *
 * 18.09: хаб переписан под запрос «Камчатка туры план» для AI-ответов с
 * веб-поиском (Нейро, ChatGPT search, Perplexity): заголовок в форме
 * запроса, прямой ответ в первом экране, вопросы-ответы с разметкой
 * FAQPage, список планов как ItemList, честная дата ревизии. Числа — из
 * PLAN_PRESETS, не из головы (lib/plans/faq.ts).
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { PLAN_PRESETS, plansHubLastModified } from '@/lib/plans/presets';
import { buildPlansFaq } from '@/lib/plans/faq';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Туры на Камчатку: готовые планы поездки на 5, 7, 10 и 14 дней',
  description: 'Готовые планы поездки на Камчатку по дням: вулканы, рыбалка, медведи, океан. У каждого дня — реальный тур оператора с ценой и датой, статус безопасности и бронь.',
  alternates: { canonical: `${SITE}/plans` },
  openGraph: {
    title: 'Туры на Камчатку: готовые планы поездки',
    description: 'Планы на 5, 7, 10 и 14 дней с реальными турами, ценами и статусом безопасности.',
    url: `${SITE}/plans`,
  },
};

const DAY_GROUPS = [5, 7, 10, 14] as const;

export default function PlansHubPage() {
  const faq = buildPlansFaq();
  const updated = plansHubLastModified().toISOString().slice(0, 10);

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };

  const listJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Готовые планы поездки на Камчатку',
    url: `${SITE}/plans`,
    dateModified: updated,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: PLAN_PRESETS.length,
      itemListElement: PLAN_PRESETS.map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: p.title,
        url: `${SITE}/plans/${p.slug}`,
      })),
    },
  };

  return (
    <>
      <JsonLd data={faqJsonLd} />
      <JsonLd data={listJsonLd} />
      <Header />
      <main className="ds-page">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
          <header className="space-y-3">
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Туры на Камчатку: готовые планы поездки
            </h1>
            {/* Прямой ответ на запрос — в первом экране, чтобы его можно было
                процитировать целиком. Числа — из пресетов. */}
            <p className="text-base leading-relaxed" style={{ color: 'var(--text-primary)' }}>
              {PLAN_PRESETS.length} готовых планов на {DAY_GROUPS.join(', ').replace(/, (\d+)$/, ' и $1')} дней:
              вулканы, рыбалка, медведи, океан, сезонные и для первой поездки. Каждый план собран
              движком платформы по дням из реальных данных: точки, сезонность, занятость туров.
              У каждого дня — тур оператора с ценой и датой, статус безопасности и заявка на бронь,
              которую подтверждает человек.
            </p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Обновлено {updated} · цены и даты — из живого каталога на момент открытия страницы
            </p>
          </header>

          {DAY_GROUPS.map((n) => {
            const group = PLAN_PRESETS.filter((p) => p.days === n);
            if (group.length === 0) return null;
            return (
              <section key={n} className="space-y-3">
                <h2 className="ds-h2">{n} дней</h2>
                <div className="space-y-2">
                  {group.map((p) => (
                    <Link key={p.slug} href={`/plans/${p.slug}`} className="ds-card block p-4">
                      <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{p.title}</div>
                      <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{p.description}</div>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}

          <section className="space-y-3">
            <h2 className="ds-h2">Вопросы о поездке на Камчатку</h2>
            <div className="space-y-2">
              {faq.map((f) => (
                <details key={f.question} className="ds-card p-4">
                  <summary className="font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                    {f.question}
                  </summary>
                  <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {f.answer}
                  </p>
                </details>
              ))}
            </div>
          </section>

          <section className="ds-card p-6 text-center space-y-3">
            <h2 className="font-playfair text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Нужен план под ваши даты?
            </h2>
            <Link href="/planner" className="ds-btn ds-btn-primary inline-flex px-6 py-3">
              Открыть планировщик
            </Link>
          </section>
        </div>
      </main>
    </>
  );
}
