import React from 'react';
import Link from 'next/link';
import { MapPin, Clock, Mountain, ArrowRight } from 'lucide-react';
import { pool } from '@/lib/db-pool';

/**
 * Реальный тур на главной вместо выдуманной «истории путешественницы».
 *
 * Прежний TravelerCard рисовал фейк: несуществующую Марию, придуманную цитату
 * и «47 лайков». Платформа обещает не врать (§7) — на витрине это особенно
 * важно. Здесь — настоящий опубликованный тур из operator_tours (тот же фильтр
 * видимости, что и каталог: is_active + is_published + deleted_at IS NULL).
 *
 * Честная деградация (§8): нет опубликованных туров или упала БД → компонент
 * возвращает null, а не заглушку. Пусто честнее фейка.
 */

const ACTIVITY_LABELS: Record<string, string> = {
  trekking:   'Треккинг',
  fishing:    'Рыбалка',
  thermal:    'Термальные источники',
  helicopter: 'Вертолётный тур',
  boat_trip:  'Морской тур',
  bears:      'Наблюдение за медведями',
  rafting:    'Сплав',
  snowmobile: 'Снегоходный тур',
};

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'Лёгкий', moderate: 'Средний', medium: 'Средний', hard: 'Сложный', expert: 'Экспертный',
};

interface FeaturedTourRow {
  id: number;
  title: string;
  short_description: string | null;
  description: string | null;
  base_price: string | null;
  tour_image: string | null;
  photos: string[] | null;
  activity_type: string | null;
  difficulty: string | null;
  duration_hours: string | null;
  duration_type: string | null;
  multi_day_count: number | null;
  location_name: string | null;
  operator_name: string | null;
}

function fmtPrice(v: string | null): string | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString('ru-RU')} ₽`;
}

function fmtDuration(r: FeaturedTourRow): string | null {
  if (r.multi_day_count && r.multi_day_count > 1) return `${r.multi_day_count} дн.`;
  if (r.duration_type === 'multi_day') return 'Несколько дней';
  const h = r.duration_hours ? Number(r.duration_hours) : NaN;
  if (Number.isFinite(h) && h > 0) return h >= 8 ? '1 день' : `${h} ч`;
  return null;
}

async function getFeaturedTour(): Promise<FeaturedTourRow | null> {
  try {
    const { rows } = await pool.query<FeaturedTourRow>(`
      SELECT ot.id, ot.title, ot.short_description, ot.description,
             ot.base_price::text, ot.tour_image, ot.photos,
             ot.activity_type, ot.difficulty,
             ot.duration_hours::text, ot.duration_type, ot.multi_day_count,
             ot.location_name,
             p.name AS operator_name
        FROM operator_tours ot
        JOIN partners p ON p.id = ot.operator_id
       WHERE ot.is_active = true
         AND ot.is_published = true
         AND ot.deleted_at IS NULL
       ORDER BY (ot.tour_image IS NOT NULL
                 OR (ot.photos IS NOT NULL AND array_length(ot.photos, 1) > 0)) DESC,
                ot.created_at DESC
       LIMIT 1
    `);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function FeaturedTour() {
  const tour = await getFeaturedTour();
  if (!tour) return null; // честная пустота вместо фейка

  const image = tour.tour_image ?? tour.photos?.[0] ?? null;
  const activity = tour.activity_type ? (ACTIVITY_LABELS[tour.activity_type] ?? tour.activity_type) : null;
  const difficulty = tour.difficulty ? (DIFFICULTY_LABELS[tour.difficulty] ?? tour.difficulty) : null;
  const duration = fmtDuration(tour);
  const price = fmtPrice(tour.base_price);
  const blurb = tour.short_description ?? (tour.description ? tour.description.slice(0, 130) : null);

  return (
    <section className="px-4 mb-2" aria-label="Тур недели">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-baseline justify-between mb-3">
          <h2
            className="text-2xl md:text-3xl font-bold text-[var(--text-primary)]"
            style={{ fontFamily: 'var(--font-playfair)' }}
          >
            Тур недели
          </h2>
          <Link href="/routes?kind=tour" className="text-sm text-[var(--ocean)] hover:opacity-80 transition-all duration-200">
            Все туры
          </Link>
        </div>

        <Link
          href={`/marketplace/tours/${tour.id}`}
          className="group block relative rounded-lg overflow-hidden h-[300px] md:h-[380px]"
        >
          {/* Фон: реальное фото тура; нет фото — тёплый земляной градиент, не фейк */}
          {image ? (
            <div
              className="absolute inset-0 bg-cover bg-center transition-all duration-200 group-hover:scale-[1.03]"
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
              <span className="inline-flex items-center gap-1.5 self-start text-[11px] uppercase tracking-wide text-white/85 mb-2">
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
              {difficulty && (
                <span className="inline-flex items-center gap-1.5 text-xs text-white backdrop-blur-md bg-black/40 border border-white/15 rounded-2xl px-3 py-1.5">
                  <Mountain size={13} />
                  {difficulty}
                </span>
              )}
              {tour.operator_name && (
                <span className="text-xs text-white/70 px-1 py-1.5">
                  {tour.operator_name}
                </span>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="text-white">
                {price ? (
                  <>
                    <span className="text-xs text-white/70">от </span>
                    <span className="text-xl md:text-2xl font-bold" style={{ fontFamily: 'var(--font-playfair)' }}>{price}</span>
                    <span className="text-xs text-white/70"> / чел</span>
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
