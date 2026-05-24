import Link from 'next/link';

interface Fact {
  num: string;
  text: string;
  href?: string;
}

const FACTS: Fact[] = [
  { num: '6',   text: 'туристов погибло на Ключевском — 2022', href: '/safety/incidents/klyuchevskoy-2022' },
  { num: '154', text: 'маршрута требуют регистрации в МЧС',     href: '/routes?kind=route' },
  { num: '763', text: 'точки с профилем безопасности',          href: '/routes?kind=place' },
];

export function EditorialSection() {
  return (
    <section className="border-b border-[var(--border)] bg-[var(--bg-card)]">
      <div className="max-w-7xl mx-auto px-4 md:px-8 py-16 md:py-24 grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-20 items-center">

        {/* Left: pull quote */}
        <div>
          <div className="w-8 h-px bg-[var(--accent)] mb-7" />
          <h2
            className="font-playfair font-bold text-[var(--text-primary)] leading-[1.08]"
            style={{ fontSize: 'clamp(1.8rem, 3.2vw, 2.75rem)' }}
          >
            Штурман,{' '}
            <em className="italic text-[var(--accent)]">а не тур-агент</em>
          </h2>
          <p className="mt-6 text-[var(--text-secondary)] text-base leading-relaxed max-w-md">
            Мы не продаём туры. Мы собираем знание, которое защищает —
            реальные данные о вулканах, закрытых зонах и опасностях
            с актуальным статусом на каждой точке.
          </p>
          <Link
            href="/safety/incidents"
            className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-[var(--danger)] hover:underline"
          >
            Задокументированные трагедии на маршрутах
            <span aria-hidden>→</span>
          </Link>
        </div>

        {/* Right: facts with hairline rules */}
        <div>
          {FACTS.map((f, i) => {
            const inner = (
              <>
                <span
                  className="font-playfair font-bold shrink-0 tabular-nums"
                  style={{
                    fontSize: 'clamp(1.3rem, 1.8vw, 1.65rem)',
                    color: i === 0 ? 'var(--danger)' : 'var(--accent)',
                  }}
                >
                  {f.num}
                </span>
                <p className="text-sm text-[var(--text-secondary)] leading-snug">{f.text}</p>
              </>
            );

            return (
              <div key={i} className="border-t border-[var(--border)] py-5">
                {f.href ? (
                  <Link
                    href={f.href}
                    className="flex items-baseline gap-5 group hover:opacity-80 transition-opacity"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="flex items-baseline gap-5">{inner}</div>
                )}
              </div>
            );
          })}
          <div className="border-t border-[var(--border)]" />
        </div>

      </div>
    </section>
  );
}
