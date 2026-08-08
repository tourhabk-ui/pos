/**
 * /plans/[slug] — программатик-страница готового плана («Мой план 2.0», A-1).
 *
 * «Камчатка за N дней под интересы X»: движок recommendTrip собирает дни на
 * ближайшие даты, страница показывает план и ведёт к брони реальных туров.
 * Из 84 планировщиков TAAFT никто не даёт индексируемых страниц про Камчатку
 * с реальной сделкой — эта ниша наша.
 *
 * ISR (сутки): рендер по запросу, без generateStaticParams — на этапе сборки
 * БД недоступна (Docker на Timeweb), и прогрев на билде уронил бы деплой.
 * Движок падает или отдаёт пусто → страница живёт на рукописном интро и CTA,
 * 500 недопустим.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { recommendTrip, type DayPlan } from '@/lib/planner';
import { topToursByActivity, type TopTour } from '@/lib/tours/top-tour-by-activity';
import { PLAN_PRESETS, findPlanPreset } from '@/lib/plans/presets';

export const revalidate = 86400;
export const dynamicParams = true;

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

const ZONE_LABELS: Record<string, string> = {
  avachinsky: 'Авачинская зона',
  western: 'Западная Камчатка',
  eastern: 'Восточная Камчатка',
  northern: 'Северная Камчатка',
};

interface PageProps { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const preset = findPlanPreset(slug);
  if (!preset) return { title: 'План поездки' };
  return {
    title: `${preset.title} — готовый план с турами и ценами`,
    description: preset.description,
    alternates: { canonical: `${SITE}/plans/${preset.slug}` },
    openGraph: {
      title: preset.title,
      description: preset.description,
      url: `${SITE}/plans/${preset.slug}`,
      images: [{ url: '/icons/og-image.jpg', width: 1200, height: 630 }],
    },
  };
}

/** Даты плана: старт через 30 дней (ISR-сутки держат их свежими). */
function planDates(days: number): { arrival: string; departure: string } {
  const arrival = new Date(Date.now() + 30 * 86400000);
  const departure = new Date(arrival.getTime() + days * 86400000);
  return {
    arrival: arrival.toISOString().slice(0, 10),
    departure: departure.toISOString().slice(0, 10),
  };
}

function formatPrice(from: number, to: number): string | null {
  if (!from && !to) return null;
  if (from === to) return `${from.toLocaleString('ru-RU')} ₽`;
  return `${from.toLocaleString('ru-RU')} – ${to.toLocaleString('ru-RU')} ₽`;
}

export default async function PlanPresetPage({ params }: PageProps) {
  const { slug } = await params;
  const preset = findPlanPreset(slug);
  if (!preset) notFound();

  // Движок может быть недоступен (БД, таймаут) — страница обязана открыться.
  let days: DayPlan[] = [];
  let tours: Record<string, TopTour> = {};
  const { arrival, departure } = planDates(preset.days);
  try {
    const rec = await recommendTrip({
      interests: preset.interests,
      arrivalDate: arrival,
      departureDate: departure,
      adults: 2,
      children: [],
      fitnessLevel: 'moderate',
      budgetTier: 'comfort',
      riskMode: 'safe_only',
    });
    days = rec.days;
    tours = await topToursByActivity(days.map((d) => d.activityType));
  } catch { /* план живёт на интро и CTA */ }

  const priceFrom = days.reduce((s, d) => s + (d.priceFrom || 0), 0);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TouristTrip',
    name: preset.title,
    description: preset.description,
    touristType: preset.interests.join(', '),
    itinerary: {
      '@type': 'ItemList',
      numberOfItems: days.length || preset.days,
      itemListElement: days.map((d, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: `День ${d.day}: ${d.title}`,
        // Сущность с координатами, не голое имя: geo — сильный сигнал места
        // для AI-ответов, а coords у дня движок даёт всегда.
        item: {
          '@type': 'TouristAttraction',
          name: d.title,
          ...(Array.isArray(d.coords) && d.coords.length === 2
            ? { geo: { '@type': 'GeoCoordinates', latitude: d.coords[0], longitude: d.coords[1] } }
            : {}),
        },
      })),
    },
    url: `${SITE}/plans/${preset.slug}`,
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <Header />
      <main className="ds-page">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
          <nav className="text-sm" style={{ color: 'var(--text-muted)' }}>
            <Link href="/">Главная</Link> · <Link href="/plans">Готовые планы</Link>
          </nav>

          <header className="space-y-3">
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {preset.title}
            </h1>
            <p className="text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {preset.intro}
            </p>
            <div className="flex flex-wrap gap-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <span>{preset.days} {preset.days < 5 ? 'дня' : 'дней'}</span>
              {priceFrom > 0 && <span>· активности от {priceFrom.toLocaleString('ru-RU')} ₽ на человека</span>}
            </div>
          </header>

          {days.length > 0 ? (
            <section className="space-y-3">
              <h2 className="ds-h2">План по дням</h2>
              {days.map((day) => {
                const tour = tours[day.activityType];
                const price = formatPrice(day.priceFrom, day.priceTo);
                return (
                  <article key={day.day} className="ds-card p-4 space-y-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        День {day.day}. {day.title}
                      </h3>
                      {price && <span className="text-xs flex-none" style={{ color: 'var(--text-secondary)' }}>{price}</span>}
                    </div>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{day.description}</p>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {ZONE_LABELS[day.zone] ?? day.zone}
                    </div>
                    {tour && (
                      <Link
                        // Дата дня — в форму брони (B-3): availableDate движка
                        // (реальный слот), иначе расчётная дата дня плана.
                        href={`/catalog/tours/${tour.id}?date=${day.availableDate ?? new Date(new Date(arrival).getTime() + (day.day - 1) * 86400000).toISOString().slice(0, 10)}`}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-md"
                        style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
                        <span className="text-xs min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                          {tour.title} · {tour.operator_name}
                        </span>
                        <span className="text-xs font-semibold whitespace-nowrap flex-none" style={{ color: 'var(--accent)' }}>
                          от {Number(tour.base_price).toLocaleString('ru-RU')} ₽ · забронировать
                        </span>
                      </Link>
                    )}
                  </article>
                );
              })}
            </section>
          ) : (
            <section className="ds-card p-5">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Живой план по дням соберётся в планировщике — под ваши даты, состав группы и темп.
              </p>
            </section>
          )}

          <section className="ds-card p-6 text-center space-y-3">
            <h2 className="font-playfair text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Этот план — отправная точка
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Планировщик пересоберёт его под ваши даты, детей, бюджет и погоду — и покажет живые места в турах.
            </p>
            <Link href="/planner" className="ds-btn ds-btn-primary inline-flex px-6 py-3">
              Собрать свой план
            </Link>
          </section>

          <section className="space-y-2">
            <h2 className="ds-h2">Другие готовые планы</h2>
            <div className="flex flex-wrap gap-2">
              {PLAN_PRESETS.filter((p) => p.slug !== preset.slug).slice(0, 6).map((p) => (
                <Link key={p.slug} href={`/plans/${p.slug}`}
                  className="text-sm px-3 py-1.5 rounded-full"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--ocean)' }}>
                  {p.title}
                </Link>
              ))}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
