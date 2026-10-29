/**
 * «从哈尔滨飞往堪察加»: рейс, указ и туры на неделю. Факты — из lib/zh/harbin,
 * туры приходят уже отобранными. Брони на странице нет.
 */
import Link from 'next/link';
import { ZhTourList } from '@/components/zh/ZhTourList';
import type { CbrRate } from '@/lib/currency/cbr-rate';
import { HARBIN_PAGE, HARBIN_SOURCES } from '@/lib/zh/harbin';
import { ZH_PAGE } from '@/lib/mcp/zh-layer';
import type { ZhTourRow } from '@/lib/zh/entry';

export function HarbinFlight({ tours, cny = null }: { tours: ZhTourRow[] | null; cny?: CbrRate | null }) {
  return (
    <article className="max-w-3xl mx-auto px-4 py-8 space-y-8" data-zh-harbin>
      <header className="space-y-3">
        <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {HARBIN_PAGE.h1}
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{HARBIN_PAGE.intro}</p>
      </header>

      <section className="space-y-2" data-zh-harbin-flight>
        <h2 className="ds-h2">{HARBIN_PAGE.flightHeading}</h2>
        <div className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
          <p>{HARBIN_PAGE.flight}</p>
          <p>{HARBIN_PAGE.flightSince}</p>
          <p style={{ color: 'var(--text-secondary)' }}>{HARBIN_PAGE.flightDirection}</p>
        </div>
      </section>

      <section className="space-y-2" data-zh-harbin-visa>
        <h2 className="ds-h2">{HARBIN_PAGE.visaHeading}</h2>
        <div className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
          <p>{HARBIN_PAGE.visa}</p>
          <p>{HARBIN_PAGE.visaUntil}</p>
          <p style={{ color: 'var(--text-secondary)' }}>{HARBIN_PAGE.visaExcept}</p>
        </div>
      </section>

      <section className="space-y-3" data-zh-harbin-tours>
        <h2 className="ds-h2">{HARBIN_PAGE.toursHeading}</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{HARBIN_PAGE.toursNote}</p>
        {tours === null ? (
          <p className="ds-card p-4 text-sm" style={{ color: 'var(--warning)' }}>{ZH_PAGE.catalogUnavailable}</p>
        ) : tours.length === 0 ? (
          <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>{HARBIN_PAGE.toursEmpty}</p>
        ) : (
          <ZhTourList tours={tours} cny={cny} />
        )}
      </section>

      <section className="space-y-2" data-zh-harbin-sources>
        <h2 className="ds-h2">{HARBIN_PAGE.sourcesHeading}</h2>
        <ul className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
          {HARBIN_SOURCES.map((s) => (
            <li key={s.url}>
              <a className="underline break-all" style={{ color: 'var(--ocean)' }} href={s.url} rel="nofollow noopener noreferrer">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <footer className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        <Link className="underline" href="/zh/catalog">堪察加团队游目录</Link>
        {' · '}<Link className="underline" href="/zh">中文首页</Link>
      </footer>
    </article>
  );
}
