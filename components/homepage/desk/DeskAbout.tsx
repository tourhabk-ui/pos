import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { PLATFORM_LINKS, type PlatformLink } from '@/lib/navigation/platform-links';
import { plural } from '@/lib/home/data-freshness';
import type { PlatformCounts } from '@/lib/stats/platform-counts';

/**
 * «О Ведаре» и дороги в остальную платформу — последний ряд десктопной главной
 * (вопрос владельца 30.09 «а где о нас и ссылки на остальное»: доска сводки
 * оставила от платформы только шапку и футер).
 *
 * Ссылки — из реестра PLATFORM_LINKS (один источник с футером и /menu),
 * здесь только выбор: своих подписей и адресов нет, переименовали страницу в
 * реестре — поменялось и тут. Цифры — getPlatformCounts, тот же счёт, что у
 * /about; не посчитались — цифр нет, текст остаётся (§4.0).
 */

/** Какие разделы реестра показать на главной и в каком порядке. */
export const DESK_ABOUT_HREFS = [
  '/routes', '/places', '/map', '/hub/fishing',
  '/plans', '/guides', '/accommodations', '/transfers',
  '/articles', '/for-operators', '/faq', '/mcp',
] as const;

export function deskAboutLinks(): PlatformLink[] {
  return DESK_ABOUT_HREFS
    .map((href) => PLATFORM_LINKS.find((l) => l.href === href))
    .filter((l): l is PlatformLink => !!l);
}

export function DeskAbout({ counts }: { counts: PlatformCounts | null }) {
  const facts = counts
    ? [
        { n: counts.places, label: plural(counts.places, 'место', 'места', 'мест') + ' с координатами' },
        { n: counts.routes, label: plural(counts.routes, 'маршрут', 'маршрута', 'маршрутов') },
        { n: counts.mchsRoutes, label: 'с обязательной регистрацией в МЧС' },
      ].filter((f) => f.n > 0)
    : [];

  return (
    <section className="grid grid-cols-1 gap-10 border-t border-[var(--border)] pt-16 lg:grid-cols-12 lg:gap-14" aria-labelledby="desk-about-title">
      <div className="flex flex-col gap-5 lg:col-span-5">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">О Ведаре</span>
        <h2 id="desk-about-title" className="font-playfair text-4xl font-bold leading-tight tracking-[-0.01em] text-[var(--text-primary)]">
          Полевой инструмент Камчатки
        </h2>
        <p className="text-[15px] leading-relaxed text-[var(--text-secondary)]">
          Места, маршруты и туры операторов в одном месте — вместе с тем, что меняет план сегодня:
          предупреждения, вулканы, погода. Карта и SOS работают без связи.
        </p>
        {facts.length > 0 && (
          <dl className="grid grid-cols-3 gap-4 border-y border-[var(--border)] py-5">
            {facts.map((f) => (
              <div key={f.label} className="flex flex-col gap-1">
                <dt className="order-2 text-[13px] leading-snug text-[var(--text-secondary)]">{f.label}</dt>
                <dd className="order-1 font-playfair text-3xl font-bold tabular-nums lining-nums text-[var(--text-primary)]">
                  {f.n.toLocaleString('ru-RU')}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <Link href="/about" className="group inline-flex items-center gap-1.5 text-base font-semibold text-[var(--ocean)] no-underline hover:no-underline">
          О платформе
          <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
        </Link>
      </div>

      <nav className="flex flex-col gap-4 lg:col-span-7" aria-label="Разделы платформы">
        <ul className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {deskAboutLinks().map((l) => {
            const Icon = l.icon;
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="group flex items-center gap-3 border-b border-[var(--border)] py-3.5 text-[15px] font-medium text-[var(--text-primary)] no-underline transition-colors duration-200 hover:text-[var(--accent)] hover:no-underline"
                >
                  <Icon size={18} className="flex-shrink-0 text-[var(--ocean)] transition-colors duration-200 group-hover:text-[var(--accent)]" aria-hidden />
                  <span className="min-w-0 flex-1 leading-snug">{l.label}</span>
                  <ArrowUpRight size={15} className="flex-shrink-0 text-[var(--text-secondary)] opacity-0 transition-all duration-200 group-hover:opacity-100" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
        <Link href="/menu" className="group inline-flex items-center gap-1.5 self-start text-base font-semibold text-[var(--ocean)] no-underline hover:no-underline">
          Все разделы платформы
          <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
        </Link>
      </nav>
    </section>
  );
}
