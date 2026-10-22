import Link from 'next/link';
import NotFoundMarker from '@/components/shared/NotFoundMarker';

const LINKS = [
  { href: '/', label: 'На главную' },
  { href: '/catalog', label: 'Туры операторов' },
  { href: '/map', label: 'Карта Камчатки' },
  { href: '/sos', label: 'SOS и безопасность' },
] as const;

export default function NotFound() {
  return (
    <div className="min-h-screen bg-transparent flex items-center justify-center px-4 py-16">
      {/* Счётчик должен отличать «не нашёл» от «посмотрел»: адрес при 404 не меняется */}
      <NotFoundMarker />
      <div className="text-center max-w-xl">
        <h1 className="text-6xl font-bold text-[var(--text-primary)] mb-4">404</h1>
        <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-4">Страница не найдена</h2>
        <p className="text-base text-[var(--text-muted)] mb-8">
          Такой страницы нет. Ведар — информационный портал: здесь можно посмотреть туры операторов,
          карту и сведения о безопасности, а заявку и оплату вы оформляете напрямую с оператором.
        </p>
        <nav aria-label="Куда перейти" className="flex flex-wrap justify-center gap-3">
          {LINKS.map((link, i) => (
            <Link
              key={link.href}
              href={link.href}
              className={
                i === 0
                  ? 'inline-flex items-center justify-center px-6 py-3 min-h-[44px] text-sm bg-[var(--accent)] text-[var(--bg-card)] font-bold rounded-xl hover:bg-[var(--accent)]/90 transition-colors'
                  : 'inline-flex items-center justify-center px-6 py-3 min-h-[44px] text-sm border border-[var(--border)] text-[var(--text-primary)] font-semibold rounded-xl hover:bg-[var(--bg-hover)] transition-colors'
              }
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
