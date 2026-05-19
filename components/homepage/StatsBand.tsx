const STATS = [
  { num: '778',  label: 'мест на карте' },
  { num: '294',  label: 'маршрута' },
  { num: '154',  label: 'требуют МЧС' },
  { num: '763',  label: 'профиля безопасности' },
  { num: '24/7', label: 'KVERT мониторинг' },
  { num: '2026', label: 'сезон открыт' },
];

export function StatsBand() {
  return (
    <div className="border-y border-[var(--border)] bg-[var(--bg-card)]">
      <div className="max-w-7xl mx-auto px-4 md:px-8">
        <dl className="grid grid-cols-3 md:grid-cols-6 divide-x divide-[var(--border)]">
          {STATS.map((s) => (
            <div
              key={s.label}
              className="flex flex-col items-center justify-center py-7 md:py-8 px-2 text-center"
            >
              <dt
                className="font-playfair font-bold text-[var(--accent)] leading-none mb-1.5"
                style={{ fontSize: 'clamp(1.35rem, 2.2vw, 1.9rem)' }}
              >
                {s.num}
              </dt>
              <dd className="text-[9px] tracking-[0.18em] uppercase text-[var(--text-muted)] font-medium leading-tight">
                {s.label}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
