/**
 * Блок «Гид по Камчатке» (Сыщик, 22.11): ссылки на тематические посадочные
 * из lib/landings/landings (featuredGuideLandings, 15–20 ссылок). Полный
 * вид — вне <main> на главной (подвал главной скрыт на телефоне, issue #43);
 * компактный — в подвале остальных страниц. Полный указатель (index) —
 * на хабах /articles и /kogda-ehat-na-kamchatku, чтобы все посадочные
 * сохраняли входящие ссылки. «Читайте также» берёт полный реестр.
 */
import Link from 'next/link';
import {
  featuredGuideLandings,
  guideAnchor,
  guideLandings,
  relatedLandings,
  type Landing,
} from '@/lib/landings/landings';

const LINK = 'text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors';

export function KamchatkaGuide({ variant }: { variant: 'full' | 'compact' | 'index' }) {
  const items = variant === 'index' ? guideLandings() : featuredGuideLandings();
  if (variant === 'compact') {
    return (
      <nav aria-label="Гид по Камчатке" data-kamchatka-guide="compact">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-3">
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
    <nav
      className="border-t border-[var(--border)] pt-10"
      aria-label="Гид по Камчатке"
      data-kamchatka-guide={variant}
    >
      <p
        className="ds-h2 mb-5"
        style={{ fontFamily: 'var(--font-playfair)' }}
      >
        Гид по Камчатке
      </p>
      <ul className="columns-2 md:columns-3 gap-x-8 [&>li]:mb-2 [&>li]:break-inside-avoid">
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
