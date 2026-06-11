'use client';

const STATS = [
  { num: '294',    label: 'маршрута в базе' },
  { num: '778',    label: 'локаций с координатами' },
  { num: '154',    label: 'маршрута с регистрацией МЧС' },
  { num: '763',    label: 'профиля безопасности' },
  { num: '24 / 7', label: 'SAR-мониторинг' },
  { num: '2026',   label: 'сезон открыт' },
];

export function StatsBand() {
  return (
    <div className="overflow-hidden border-y border-[var(--border)] bg-[var(--bg-card)] group">
      {/* Marquee — two copies for seamless loop */}
      <div className="flex animate-marquee whitespace-nowrap py-6 group-hover:[animation-play-state:paused]" aria-hidden>
        {[...STATS, ...STATS].map((s, i) => (
          <div
            key={i}
            className="inline-flex items-baseline gap-3 px-10 md:px-16 border-r border-[var(--border)] last:border-r-0 flex-shrink-0"
          >
            <span
              className="font-playfair font-bold text-[var(--text-primary)]"
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
        {STATS.map(s => (
          <div key={s.label}>
            <dt>{s.label}</dt>
            <dd>{s.num}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
