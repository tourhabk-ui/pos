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
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { notFound } from 'next/navigation';
import { unstable_cache } from 'next/cache';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { recommendTrip, type DayPlan } from '@/lib/planner';
import { topToursByActivity, toursByIds, type TopTour } from '@/lib/tours/top-tour-by-activity';
import { presetPlanDates, planFillNote, presetCalendarDays, presetDayTour } from '@/lib/plans/preset-plan';
import { tripLengthWords } from '@/lib/planner/calendar-days';
import { tourPath } from '@/lib/tours/tour-url';
import { findPlanPreset, planLastModified } from '@/lib/plans/presets';
import { OtherPlans } from '@/components/plans/OtherPlans';
import { PlanKindOffers, PlanTourRule } from '@/components/plans/PlanKindOffers';
import { offerOrderDay } from '@/lib/tours/offer-order';
import { brandedTitle, fitTitle, PLAN_TITLE_TAILS } from '@/lib/seo/title-fit';
import { defaultOgImages } from '@/lib/seo/og-image';

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
    // Хвост — по длине: целиком в выдачу, а не с многоточием (аудит 01.10:
    // заголовки планов были по 86–91 знаку при видимых ~60).
    title: brandedTitle(fitTitle(preset.title, PLAN_TITLE_TAILS)),
    description: preset.description,
    alternates: { canonical: `${SITE}/plans/${preset.slug}` },
    openGraph: {
      title: preset.title,
      description: preset.description,
      url: `${SITE}/plans/${preset.slug}`,
      images: defaultOgImages(),
    },
  };
}

// Даты плана — ближайший старт в сезоне главного интереса, N дней — N
// календарных дней (lib/plans/preset-plan, аудит 07.11, H16).

function formatPrice(from: number, to: number): string | null {
  if (!from && !to) return null;
  if (from === to) return `${from.toLocaleString('ru-RU')} ₽`;
  return `${from.toLocaleString('ru-RU')} – ${to.toLocaleString('ru-RU')} ₽`;
}

/**
 * Расчёт плана — на сутки в кэше данных. Страница рендерится динамически
 * (ответ no-store), и `revalidate` выше ничего не кэшировал: recommendTrip
 * пересчитывался на каждый запрос, и все 16 /plans/* отвечали за 9–14 с
 * (аудит SEO 29.09, Н7). Ключ — slug и даты поездки: даты сдвигаются раз в
 * сутки, вместе с ними и расчёт. Пустой план не кэшируется: пустота от
 * недоступной БД не должна жить сутки.
 */
const loadPresetPlan = unstable_cache(
  // `day` — день жребия правила 1в (дата Камчатки): аргумент входит в ключ
  // кэша, и после полуночи по Камчатке тур дня пересчитывается.
  async (slug: string, arrival: string, departure: string, day: string): Promise<{
    days: DayPlan[]; engineTours: Record<string, TopTour>; kindTours: Record<string, TopTour>; fillNote: string | null;
  }> => {
    const preset = findPlanPreset(slug);
    if (!preset) throw new Error(`нет пресета ${slug}`);
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
    if (rec.days.length === 0) throw new Error('движок вернул пустой план');
    // Тур дня — тот, что поставил движок (H16); подбор по виду — только дням
    // без него. Строка тура для страницы — из витрины по id.
    const engineTours = await toursByIds(rec.days.flatMap((d) => (d.realTour?.tourId ? [String(d.realTour.tourId)] : [])));
    const unplanned = rec.days.filter((d) => d.type === 'activity' && !(d.realTour?.tourId && engineTours[String(d.realTour.tourId)]));
    const kindTours = unplanned.length > 0 ? await topToursByActivity(unplanned.map((d) => d.activityType), { day }) : {};
    return { days: rec.days, engineTours, kindTours, fillNote: planFillNote(rec.warnings) };
  },
  // v2 (13.10): в строке тура плана появились slug и is_public оператора.
  // v3 (29.10): тур дня — по правилу 1в, а не по рейтингу и цене; в строке
  // появилось offers_of_kind.
  // v4 (07.11, H16): даты — N календарных дней; тур дня — движка; строка
  // недобора.
  ['plan-preset-v4'],
  { revalidate: 86400 },
);

export default async function PlanPresetPage({ params }: PageProps) {
  const { slug } = await params;
  const preset = findPlanPreset(slug);
  if (!preset) notFound();

  // Движок может быть недоступен (БД, таймаут) — страница обязана открыться.
  let days: DayPlan[] = [];
  let engineTours: Record<string, TopTour> = {};
  let kindTours: Record<string, TopTour> = {};
  let fillNote: string | null = null;
  const { arrival, departure } = presetPlanDates(preset.days, preset.interests);
  try {
    ({ days, engineTours, kindTours, fillNote } = await loadPresetPlan(slug, arrival, departure, offerOrderDay()));
  } catch (e) {
    // План живёт на интро и CTA, но отказ движка — в лог (§4.0).
    console.error('[plans/[slug]] план не рассчитан', { slug, message: e instanceof Error ? e.message : String(e) });
  }

  const priceFrom = days.reduce((s, d) => s + (d.priceFrom || 0), 0);
  // Дни страницы — подряд по календарю: пропуск — свободный день (H16).
  const calendar = days.length > 0 ? presetCalendarDays(days, preset.days) : [];
  const dayTours = calendar.map((d) => (d.type === 'activity' ? presetDayTour(d as DayPlan, engineTours, kindTours) : null));
  const anyKindTour = dayTours.some((t) => t?.source === 'kind');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TouristTrip',
    name: preset.title,
    description: preset.description,
    touristType: preset.interests.join(', '),
    // Дата ревизии текста — та же, что видит читатель и что отдаёт sitemap;
    // без неё страница неотличима от заброшенной (стратегия 14.08).
    dateModified: planLastModified(preset).toISOString().slice(0, 10),
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
              <span>{tripLengthWords(preset.days)}</span>
              {priceFrom > 0 && <span>· активности от {priceFrom.toLocaleString('ru-RU')} ₽ на человека</span>}
            </div>
            {/* Посадочный кластер называет дату ревизии и источник условий
                (стратегия 14.08): в safety-first продукте страница без даты
                неотличима от устаревшей, а устаревшая вредит сильнее
                отсутствующей. */}
            {preset.cluster && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Обновлено {preset.cluster.updated} · {preset.cluster.sourceNote}
              </p>
            )}
          </header>

          {preset.cluster && preset.cluster.limitations.length > 0 && (
            <section className="ds-card p-4 space-y-2" style={{ borderLeft: '4px solid var(--warning)' }}>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Что учесть честно
              </h2>
              <ul className="space-y-1.5">
                {preset.cluster.limitations.map((l) => (
                  <li key={l} className="text-sm flex gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <span aria-hidden style={{ color: 'var(--warning)' }}>—</span>
                    <span>{l}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {calendar.length > 0 ? (
            <section className="space-y-3">
              <h2 className="ds-h2">План по дням</h2>
              {/* Недобор — словами движка, а не молчанием (H16). */}
              {fillNote && (
                <p className="text-sm" data-testid="plan-fill-note" style={{ color: 'var(--warning)' }}>{fillNote}</p>
              )}
              {/* Туры, подобранные по виду, выбраны правилом 1в — оно названо (§0). */}
              {anyKindTour && <PlanTourRule />}
              {calendar.map((day, i) => {
                const picked = dayTours[i];
                const tour = picked?.tour;
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
                      <div className="relative flex items-center justify-between gap-2 px-3 py-2 rounded-md"
                        style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
                        {/* Ссылка на тур — слоем под содержимым, имя оператора — своей
                            ссылкой поверх (владелец 13.10): <a> в <a> недопустим. */}
                        <Link
                          // Дата дня — в форму брони (B-3): availableDate движка
                          // (реальный слот), иначе расчётная дата дня плана.
                          href={`${tourPath(tour)}?date=${('availableDate' in day ? day.availableDate : undefined) ?? new Date(new Date(arrival).getTime() + (day.day - 1) * 86400000).toISOString().slice(0, 10)}`}
                          className="absolute inset-0 z-[1] rounded-md"
                          aria-label={`${tour.title}: оставить заявку`} />
                        <span className="relative z-[2] pointer-events-none text-xs min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                          {tour.title} · <OperatorNameLink name={tour.operator_name} slug={tour.operator_slug} isPublic={tour.operator_public} className="pointer-events-auto" />
                        </span>
                        <span className="relative z-[2] pointer-events-none text-xs font-semibold whitespace-nowrap flex-none" style={{ color: 'var(--accent)' }}>
                          от {Number(tour.base_price).toLocaleString('ru-RU')} ₽ · оставить заявку
                        </span>
                      </div>
                    )}
                    {tour && picked?.source === 'kind' && <PlanKindOffers activityType={day.activityType} offers={tour.offers_of_kind} />}
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

          <OtherPlans current={preset.slug} />
        </div>
      </main>
    </>
  );
}
