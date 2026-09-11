'use client';

import { plural } from '@/lib/home/data-freshness';

export interface PlatformStats {
  routes: number;
  places: number;
  mchsRoutes: number;
  safetyProfiles: number;
}

interface StatsBandProps {
  /** Живые цифры из БД (null — БД недоступна: показываем только вневременные факты). */
  stats: PlatformStats | null;
}

export function StatsBand({ stats }: StatsBandProps) {
  // Цифры не хардкодим — устаревший хардкод врал (294/778 при реальных ~233/541).
  const items: { num: string; label: string }[] = [
    ...(stats
      ? [
          // Склонение по числу: «61 профиль», не «61 профилей» (#1780).
          { num: stats.routes.toLocaleString('ru-RU'),         label: `${plural(stats.routes, 'маршрут', 'маршрута', 'маршрутов')} в базе` },
          { num: stats.places.toLocaleString('ru-RU'),         label: `${plural(stats.places, 'локация', 'локации', 'локаций')} с координатами` },
          { num: stats.mchsRoutes.toLocaleString('ru-RU'),     label: `${plural(stats.mchsRoutes, 'маршрут', 'маршрута', 'маршрутов')} с регистрацией МЧС` },
          { num: stats.safetyProfiles.toLocaleString('ru-RU'), label: `${plural(stats.safetyProfiles, 'профиль', 'профиля', 'профилей')} безопасности` },
        ]
      : []),
    { num: '24 / 7', label: 'мониторинг угроз' },
    { num: '2026',   label: 'сезон открыт' },
  ];

  return (
    <div className="overflow-hidden border-y border-[var(--border)] bg-[var(--bg-card)] group">
      {/* Marquee — two copies for seamless loop */}
      <div className="flex animate-marquee whitespace-nowrap py-6 group-hover:[animation-play-state:paused]" aria-hidden>
        {[...items, ...items].map((s, i) => (
          <div
            key={i}
            className="inline-flex items-baseline gap-3 px-10 md:px-16 border-r border-[var(--border)] last:border-r-0 flex-shrink-0"
          >
            <span
              className="font-playfair font-bold text-[var(--text-primary)] tabular-nums"
              style={{ fontSize: 'clamp(1.5rem, 2.5vw, 2.2rem)' }}
            >
              {s.num}
            </span>
            <span className="text-xs tracking-[0.2em] uppercase text-[var(--text-muted)] font-medium">
              {s.label}
            </span>
          </div>
        ))}
      </div>

      {/* Accessible static version for screen readers */}
      <dl className="sr-only">
        {items.map(s => (
          <div key={s.label}>
            <dt>{s.label}</dt>
            <dd>{s.num}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
