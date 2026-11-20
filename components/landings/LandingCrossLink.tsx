/**
 * Ссылка со старой страницы на посадочную по той же теме (каннибализация,
 * Сыщик 20.11; карта адресов — LANDING_CROSS_LINKS в lib/landings). Адреса
 * в карте нет — ничего не рисуется.
 */
import Link from 'next/link';
import { pageContainer } from '@/lib/layout/page-width';
import { LANDING_CROSS_LINKS } from '@/lib/landings/landings';

export function LandingCrossLink({ path }: { path: string }) {
  const link = LANDING_CROSS_LINKS[path];
  if (!link) return null;
  return (
    <nav className={`${pageContainer('reading')} py-4`} aria-label="Подробнее по теме" data-landing-cross-link>
      <p className="ds-card p-4 text-sm">
        Подробнее: <Link className="underline font-semibold" style={{ color: 'var(--ocean)' }} href={link.href}>{link.label}</Link>
      </p>
    </nav>
  );
}
