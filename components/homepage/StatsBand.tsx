'use client';

const STATS = [
  { num: '778',  label: 'мест на карте' },
  { num: '294',  label: 'маршрута' },
  { num: '125',  label: 'партнёров' },
  { num: '20',   label: 'туров от операторов' },
  { num: '24/7', label: 'мониторинг безопасности' },
  { num: '2026', label: 'сезон открыт' },
];

export function StatsBand() {
  return (
    <div className="overflow-hidden border-y border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex animate-marquee whitespace-nowrap py-5" aria-hidden>
        {[...STATS, ...STATS].map((s, i) => (
          <div
            key={i}
            className="inline-flex items-baseline gap-3 px-8 md:px-14 border-r border-[var(--border)] last:border-r-0 flex-shrink-0"
          >
            <span
              className="font-playfair font-bold text-[var(--accent)]"
              style={{ fontSize: 'clamp(1.4rem, 2.2vw, 2rem)' }}
            >
              {s.num}
            </span>
            <span className="text-[11px] tracking-[0.2em] uppercase text-[var(--text-muted)] font-medium">
              {s.label}
            </span>
          </div>
        ))}
      </div>

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
