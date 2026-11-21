/**
 * Блок «Гид по Камчатке» (Сыщик, 22.11): ссылки на тематические посадочные
 * из единого реестра lib/landings/landings (guideLandings). Полный вид —
 * на главной и в /articles; компактный — в подвале. «Читайте также» —
 * на самих посадочных, 3–5 соседних страниц из текста и реестра.
 */
import Link from 'next/link';
import {
  guideAnchor,
  guideLandings,
  relatedLandings,
  type Landing,
} from '@/lib/landings/landings';

const LINK = 'text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors';

export function KamchatkaGuide({ variant }: { variant: 'full' | 'compact' }) {
  const items = guideLandings();
  if (variant === 'compact') {
    return (
      <nav aria-label="Гид по Камчатке" data-kamchatka-guide="compact">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-3">
          Гид по Камчатке
        </p>
        <ul className="flex flex-wrap gap-x-3 gap-y-1.5">
          {items.map((l) => (
            <li key={l.path}>
              <Link href={l.path} className={LINK}>
                {guideAnchor(l)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <section
      className="border-t border-[var(--border)] pt-10"
      aria-labelledby="kamchatka-guide-heading"
      data-kamchatka-guide="full"
    >
      <h2
        id="kamchatka-guide-heading"
        className="ds-h2 mb-5"
        style={{ fontFamily: 'var(--font-playfair)' }}
      >
        Гид по Камчатке
      </h2>
      <ul className="columns-2 md:columns-3 gap-x-8 [&>li]:mb-2 [&>li]:break-inside-avoid">
        {items.map((l) => (
          <li key={l.path}>
            <Link href={l.path} className={LINK}>
              {guideAnchor(l)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RelatedLandings({ landing }: { landing: Landing }) {
  const items = relatedLandings(landing, 5);
  if (items.length < 3) return null;
  return (
    <nav className="ds-card p-4 text-sm space-y-2" aria-label="Читайте также" data-related-landings="">
      <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Читайте также</h2>
      <ul className="space-y-1">
        {items.map((l) => (
          <li key={l.path}>
            <Link className="underline" style={{ color: 'var(--ocean)' }} href={l.path}>
              {guideAnchor(l)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
