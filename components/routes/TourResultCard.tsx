'use client';

import Link from 'next/link';
import { Waves, Fish, Flame, Thermometer, Anchor, PawPrint, Snowflake, Plane, Mountain, ArrowRight } from 'lucide-react';

// Карточка тура оператора в выдаче поиска маршрутов. Туры живут в operator_tours
// (отдельно от мест/маршрутов), поэтому ссылка ведёт в /marketplace/tours/[id],
// а не в /routes/[id]. Появляется, когда поиск по каталогу совпал с турами —
// чтобы «сплав» находил тур по Быстрой, а не только описания вулканов.

export interface TourResult {
  id: number;
  title: string;
  tour_image: string | null;
  // NUMERIC из БД node-pg отдаёт строкой — принимаем оба варианта, приводим ниже.
  base_price: number | string;
  activity_type: string;
  location_name: string | null;
  operator_name: string;
}

const ACTIVITY: Record<string, { label: string; Icon: React.ElementType }> = {
  rafting:    { label: 'Сплав',       Icon: Waves },
  fishing:    { label: 'Рыбалка',     Icon: Fish },
  trekking:   { label: 'Треккинг',    Icon: Mountain },
  thermal:    { label: 'Источники',   Icon: Thermometer },
  helicopter: { label: 'Вертолёт',    Icon: Plane },
  boat_trip:  { label: 'Море',        Icon: Anchor },
  bears:      { label: 'Медведи',     Icon: PawPrint },
  snowmobile: { label: 'Снегоход',    Icon: Snowflake },
  volcano:    { label: 'Вулканы',     Icon: Flame },
};

export default function TourResultCard({ tour }: { tour: TourResult }) {
  const act = ACTIVITY[tour.activity_type] ?? { label: 'Тур', Icon: Mountain };
  const ActIcon = act.Icon;
  const price = Number(tour.base_price) || 0;

  return (
    <Link
      href={`/marketplace/tours/${tour.id}`}
      className="group block rounded-lg border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden transition-all duration-200 hover:border-[var(--accent)]/40 hover:shadow-sm"
    >
      {/* Фото */}
      <div className="relative" style={{ height: 148 }}>
        {tour.tour_image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={tour.tour_image}
            alt={tour.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-[var(--bg-hover)]">
            <ActIcon className="w-8 h-8 text-[var(--ocean)] opacity-30" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-14 pointer-events-none bg-gradient-to-t from-black/45 to-transparent" />
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full backdrop-blur-md bg-black/40 border border-white/15 text-white">
          <ActIcon className="w-3 h-3" />
          {act.label}
        </span>
      </div>

      {/* Тело */}
      <div className="p-3 space-y-1.5">
        <h3
          className="font-semibold text-[var(--text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--accent)] transition-colors"
          style={{ fontFamily: 'var(--font-playfair)', fontSize: '1rem' }}
        >
          {tour.title}
        </h3>
        <p className="text-xs text-[var(--text-muted)] line-clamp-1">{tour.operator_name}</p>
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="inline-flex text-xs font-semibold text-[var(--text-primary)] bg-[var(--bg-hover)] px-2 py-1 rounded">
            {price > 0 ? `от ${price.toLocaleString('ru-RU')} ₽` : 'Цена по запросу'}
          </span>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] group-hover:underline">
            Подробнее
            <ArrowRight className="w-3 h-3" />
          </span>
        </div>
      </div>
    </Link>
  );
}
