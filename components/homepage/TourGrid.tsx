import Link from 'next/link';
import { ArrowRight, CalendarX, MessageSquareText } from 'lucide-react';
import type { Plate } from '@/app/_home/data';
import { plateFacts } from '@/lib/home/plate-facts';
import { activityLabel } from '@/lib/tours/labels';
import { photoSrc } from '@/lib/images/variant';
import { AVAILABILITY_LABEL } from '@/lib/tours/catalog-availability';
import { HOME_CONTAINER } from '@/lib/home/desktop-layout';

/**
 * Сетка туров под «Турами сезона» на десктопной главной.
 *
 * Аудит 24.09 (#33): десктоп показывал ОДИН тур из восьми — единственную
 * ссылку на тур на странице в 5900 пикселей, без цены у остальных и без
 * возможности оставить заявку. Телефон тем временем листал все восемь.
 *
 * Источник — та же витрина, что у телефона и у карточки над сеткой
 * (fetchPlates, app/_home/data.ts): вторую выборку не заводим, иначе
 * порядок, фильтр живого тура и правило сезона разошлись бы между деревьями.
 * Первый тур витрины показан крупно (FeaturedTour), здесь — остальные.
 *
 * Факты карточки — plateFacts (цена с единицей, длительность, оператор), тот
 * же расчёт, что у мобильной карусели и каталога; чего нет в данных, того нет
 * и на карточке (§4.0): «Цена по запросу» словами, а не «от 0 ₽».
 *
 * Последняя клетка — заявка (/request): тур не подошёл — человек не должен
 * уходить со страницы без следующего шага.
 */
export function TourGrid({ plates }: { plates: readonly Plate[] }) {
  return (
    <section className={`${HOME_CONTAINER} pt-4 pb-4`} aria-label="Все туры сезона">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {plates.map((p) => {
          const f = plateFacts(p);
          const activity = p.category && p.category !== 'tour' ? activityLabel(p.category) : null;
          const meta = [f.duration, f.operator].filter(Boolean).join(' · ');
          return (
            <Link
              key={p.id}
              href={`/marketplace/tours/${p.id}`}
              className="no-underline hover:no-underline group flex flex-col rounded-lg overflow-hidden bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--accent)] transition-all duration-200"
            >
              <div className="relative aspect-[4/3] bg-[var(--bg-hover)] overflow-hidden">
                {p.imageUrl && (
                  <div
                    className="absolute inset-0 bg-cover bg-top transition-transform duration-200 group-hover:scale-[1.03]"
                    style={{ backgroundImage: `url('${photoSrc(p.imageUrl, 640)}')` }}
                    aria-hidden
                  />
                )}
              </div>
              <div className="flex flex-col flex-1 p-4 gap-1.5">
                {activity && (
                  <span className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{activity}</span>
                )}
                <h3 className="font-playfair text-lg font-bold leading-snug text-[var(--text-primary)] line-clamp-2">
                  {p.title}
                </h3>
                {meta && <p className="text-xs text-[var(--text-secondary)] line-clamp-1">{meta}</p>}
                {p.availability === 'season_over' && (
                  <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <CalendarX size={13} aria-hidden className="flex-shrink-0" />
                    {AVAILABILITY_LABEL.season_over}
                  </p>
                )}
                <div className="mt-auto pt-2 flex items-center justify-between gap-2">
                  {f.price ? (
                    <span className="text-base font-bold text-[var(--text-primary)] lining-nums tabular-nums">{f.price}</span>
                  ) : (
                    <span className="text-sm text-[var(--text-secondary)]">Цена по запросу</span>
                  )}
                  <ArrowRight size={16} className="text-[var(--accent)] flex-shrink-0 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
                </div>
              </div>
            </Link>
          );
        })}

        <Link
          href="/request"
          className="no-underline hover:no-underline group flex flex-col justify-between rounded-lg p-5 bg-[var(--bg-card)] border border-dashed border-[var(--accent)] hover:bg-[var(--bg-hover)] transition-all duration-200"
        >
          <div>
            <MessageSquareText size={22} className="text-[var(--accent)] mb-3" aria-hidden />
            <h3 className="font-playfair text-lg font-bold leading-snug text-[var(--text-primary)] mb-1.5">
              Не нашли свой тур?
            </h3>
            <p className="text-sm text-[var(--text-secondary)] leading-snug">
              Опишите поездку — даты, состав группы, пожелания. Подберём туры под вашу заявку.
            </p>
          </div>
          <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--accent)]">
            Оставить заявку
            <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
          </span>
        </Link>
      </div>
    </section>
  );
}
