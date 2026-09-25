import React from 'react';
import Link from 'next/link';
import { MapPin, Clock, ArrowRight, CalendarX } from 'lucide-react';
import type { Plate } from '@/app/_home/data';
import { plateDuration } from '@/lib/home/plate-facts';
import { priceUnitLabel, activityLabel } from '@/lib/tours/labels';
import { priceFrom } from '@/lib/tours/price-label';
import { AVAILABILITY_LABEL } from '@/lib/tours/catalog-availability';

/**
 * Реальный тур на главной вместо выдуманной «истории путешественницы».
 *
 * Прежний TravelerCard рисовал фейк: несуществующую Марию, придуманную цитату
 * и «47 лайков». Платформа обещает не врать (§7) — на витрине это особенно
 * важно. Здесь — настоящий опубликованный тур из operator_tours.
 *
 * Аудит 24.09 (#33, #120, #123): своей выборки у карточки больше нет. Прежде
 * она брала «самый новый тур с фото» (LIMIT 1) отдельным запросом — мимо
 * правила сезона, и тур с кончившимся сезоном мог стоять первым, пока
 * мобильная витрина того же тура уводила его в конец. Теперь тур приходит
 * из той же витрины, что и на телефоне (fetchPlates в app/_home/data.ts:
 * фильтр живого тура каталога, JOIN partners, порядок orderPlates по датам
 * и сезону), — первым элементом; остальные идут сеткой ниже (TourGrid).
 * Заголовок «Тур недели» снят: редакторского выбора за ним не было.
 *
 * Честная деградация: нет туров или упала БД → fetchPlates отдаёт [] (и
 * пишет отказ в лог), компонент возвращает null, а не заглушку.
 */

interface FeaturedTourProps {
  /** Первый тур витрины (fetchPlates) либо null — туров нет. */
  tour: Plate | null;
  /** Сколько туров в витрине всего — для ссылки «Все туры». */
  total: number;
}

export function FeaturedTour({ tour, total }: FeaturedTourProps) {
  if (!tour) return null; // честная пустота вместо фейка

  const image = tour.imageUrl;
  const activity = tour.category && tour.category !== 'tour' ? activityLabel(tour.category) : null;
  const duration = plateDuration(tour);
  // «13 000 ₽» либо null — цена не записана (priceFrom: null на входе — null на выходе).
  const price = priceFrom(tour.priceFrom, '₽')?.replace(/^от /, '') ?? null;
  const unit = priceUnitLabel(tour.priceUnit, true);
  const blurb = tour.description || null;

  return (
    <section className="px-4 mb-2" aria-labelledby="home-tours-title">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-baseline justify-between mb-3">
          <h2
            id="home-tours-title"
            className="text-2xl md:text-3xl font-bold text-[var(--text-primary)]"
            style={{ fontFamily: 'var(--font-playfair)' }}
          >
            Туры сезона
          </h2>
          {/* Одна витрина «всех туров» на платформе — /catalog, та же, что
              «Туры» в шапке и таб-баре. Прежде здесь стоял /routes?kind=tour,
              откуда middleware уводил 301-м на /marketplace (#123). */}
          <Link href="/catalog" className="text-sm text-[var(--ocean)] hover:opacity-80 transition-all duration-200">
            Все туры{total > 1 ? ` (${total})` : ''}
          </Link>
        </div>

        <Link
          href={`/marketplace/tours/${tour.id}`}
          className="group block relative rounded-lg overflow-hidden h-[300px] md:h-[380px]"
        >
          {/* Фон: реальное фото тура; нет фото — тёплый земляной градиент, не фейк.
              Кроп прижат к верху (bg-top): рамка широкая, а фото туров сплошь
              вертикальные — рыбак во весь рост с лососем. Центрирование срезало
              голову сверху и ноги снизу, оставляя безголовое туловище с рыбой.
              На горизонтальных снимках вертикального запаса почти нет, им это
              ничего не меняет. */}
          {image ? (
            <div
              className="absolute inset-0 bg-cover bg-top transition-all duration-200 group-hover:scale-[1.03]"
              style={{ backgroundImage: `url('${image}')`, filter: 'saturate(1.08)' }}
              aria-hidden
            />
          ) : (
            <div
              className="absolute inset-0"
              style={{ background: 'linear-gradient(135deg, var(--bg-hover), var(--bg-card))' }}
              aria-hidden
            />
          )}
          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(180deg, rgba(10,14,12,0.15) 0%, rgba(10,14,12,0.05) 38%, rgba(10,14,12,0.82) 100%)' }}
            aria-hidden
          />

          <div className="absolute inset-0 flex flex-col justify-end p-5 md:p-7">
            {activity && (
              <span className="inline-flex items-center gap-1.5 self-start text-xs uppercase tracking-wide text-white/85 mb-2">
                <MapPin size={12} />
                {activity}
              </span>
            )}

            <h3
              className="text-white font-bold text-2xl md:text-4xl leading-tight mb-2"
              style={{ fontFamily: 'var(--font-playfair)', textWrap: 'balance' }}
            >
              {tour.title}
            </h3>

            {blurb && (
              <p className="text-white/80 text-sm md:text-base leading-snug mb-4 max-w-2xl line-clamp-2">
                {blurb}
              </p>
            )}

            {/* Стекло допустимо: панель лежит поверх фото (§5) */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {duration && (
                <span className="inline-flex items-center gap-1.5 text-xs text-white backdrop-blur-md bg-black/40 border border-white/15 rounded-2xl px-3 py-1.5">
                  <Clock size={13} />
                  {duration}
                </span>
              )}
              {tour.availability === 'season_over' && (
                <span className="inline-flex items-center gap-1.5 text-xs text-white backdrop-blur-md bg-black/40 border border-white/15 rounded-2xl px-3 py-1.5">
                  <CalendarX size={13} />
                  {AVAILABILITY_LABEL.season_over}
                </span>
              )}
              {tour.operatorName && (
                <span className="text-xs text-white/80 px-1 py-1.5">
                  {tour.operatorName}
                </span>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="text-white">
                {price ? (
                  <>
                    {/* lining-nums: у Playfair старостильные цифры, и «13 000»
                        читалось как «13 ooo» (#124). Единица — из общего словаря
                        (priceUnitLabel), не литералом «/ чел»: у тура за группу
                        она другая. */}
                    <span className="text-xs text-white/80">от </span>
                    <span className="text-xl md:text-2xl font-bold lining-nums tabular-nums" style={{ fontFamily: 'var(--font-playfair)' }}>{price}</span>
                    <span className="text-xs text-white/80"> {unit}</span>
                  </>
                ) : (
                  <span className="text-sm text-white/85">Цена по запросу</span>
                )}
              </div>
              <span
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-white rounded-lg px-4 py-2.5 transition-all duration-200 group-hover:gap-2.5"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                Смотреть тур
                <ArrowRight size={16} />
              </span>
            </div>
          </div>
        </Link>
      </div>
    </section>
  );
}
