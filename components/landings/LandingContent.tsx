/**
 * Тело посадочной страницы Сыщика (lib/landings): текст до блока туров, блок
 * туров из базы (или свой блок страницы — «План по дням» у /plans), текст
 * после, перелинковка месяцев и разметка Article + FAQPage. Дата правки —
 * дата ревизии текста из исходника (`date`), видимая и в dateModified.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArticleMarkdown } from '@/components/articles/ArticleMarkdown';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { JsonLd } from '@/components/seo/JsonLd';
import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';
import { parseArticleMarkdown, faqFromBlocks } from '@/lib/articles/markdown';
import { articleJsonLd } from '@/lib/articles/article-jsonld';
import { isMonthLanding, monthLinks, MONTHS_HUB, type Landing } from '@/lib/landings/landings';
import { tourBlockHeading, tourBlockNote, type LandingBlockTour } from '@/lib/landings/tours';
import { landingDates, landingDuration, landingPrice, landingSeason } from '@/lib/seo/query-landing-view';
import { tourPath } from '@/lib/tours/tour-url';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export function landingJsonLd(landing: Landing): Record<string, unknown> {
  const blocks = [...parseArticleMarkdown(landing.before), ...parseArticleMarkdown(landing.after)];
  return articleJsonLd({
    url: `${SITE}${landing.path}`,
    site: SITE,
    headline: landing.h1,
    description: landing.description,
    datePublished: landing.date,
    dateModified: landing.date,
    faq: faqFromBlocks(blocks),
  });
}

export function LandingTours({ landing, tours }: { landing: Landing; tours: LandingBlockTour[] | null }) {
  if (landing.tours.kind === 'none') return null;
  return (
    <section className="space-y-3" aria-labelledby="landing-tours" data-landing-tours>
      <h2 id="landing-tours" className="ds-h2 pt-4" style={{ fontFamily: 'var(--font-playfair)' }}>{tourBlockHeading(landing.tours)}</h2>
      {tours === null ? (
        <p className="ds-card p-4 text-sm" style={{ color: 'var(--warning)' }}>
          Туры сейчас не загрузились. Полный список — в <Link className="underline" href="/catalog">каталоге</Link>.
        </p>
      ) : tours.length === 0 ? (
        <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Подходящих туров на витрине сейчас нет. Все туры — в <Link className="underline" href="/catalog">каталоге</Link>.
        </p>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{tourBlockNote(landing.tours)}</p>
          <ul className="space-y-2">
            {tours.map((t) => (
              <li key={t.id} className="ds-card p-4 text-sm space-y-1" data-landing-tour={t.id}>
                <Link className="underline font-semibold" style={{ color: 'var(--ocean)' }} href={tourPath(t)}>{t.title}</Link>
                <p style={{ color: 'var(--text-secondary)' }}>
                  Оператор: <OperatorNameLink name={t.operator_name} slug={t.operator_slug} isPublic={t.operator_public} />
                </p>
                <p style={{ color: 'var(--text-primary)' }}>
                  {[landingPrice(t, 'ru') ?? 'цена по запросу', landingDuration(t, 'ru'), landingSeason(t, 'ru'), landingDates(t, 'ru')].filter(Boolean).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
          <Link className="underline text-sm" style={{ color: 'var(--ocean)' }} href="/catalog">Все туры в каталоге</Link>
        </>
      )}
    </section>
  );
}

/** Перелинковка месяцев: двенадцать месяцев и хаб «Когда ехать». */
export function MonthsNav({ current }: { current?: string }) {
  return (
    <nav className="ds-card p-4 text-sm space-y-2" aria-label="Камчатка по месяцам" data-landing-months>
      <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>Камчатка по месяцам</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {monthLinks().map((m) => (
          <li key={m.href}>
            {m.href === current
              ? <span aria-current="page" className="font-semibold">{m.label}</span>
              : <Link className="underline" style={{ color: 'var(--ocean)' }} href={m.href}>{m.label}</Link>}
          </li>
        ))}
      </ul>
      <Link className="underline" style={{ color: 'var(--ocean)' }} href={MONTHS_HUB.href}>{MONTHS_HUB.label}</Link>
    </nav>
  );
}

export function LandingContent({ landing, tours, showH1 = true, middle }: {
  landing: Landing;
  tours: LandingBlockTour[] | null;
  /** H1 страницы — у своей страницы посадочной; у апгрейда H1 рисует страница. */
  showH1?: boolean;
  /** Свой блок на месте блока туров (у /plans — «План по дням»). */
  middle?: ReactNode;
}) {
  return (
    <article className="space-y-6" data-landing={landing.slug}>
      <JsonLd data={landingJsonLd(landing)} />
      {showH1 && (
        <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>{landing.h1}</h1>
      )}
      {formatRecordDate(landing.date) && (
        <p className="text-xs text-[var(--text-muted)]" data-record-modified="">
          Обновлено: <time dateTime={recordDateIso(landing.date) ?? undefined}>{formatRecordDate(landing.date)}</time>
        </p>
      )}
      <ArticleMarkdown blocks={parseArticleMarkdown(landing.before)} />
      {middle ?? <LandingTours landing={landing} tours={tours} />}
      {landing.after.trim() && <ArticleMarkdown blocks={parseArticleMarkdown(landing.after)} />}
      {isMonthLanding(landing) && <MonthsNav current={landing.path} />}
    </article>
  );
}
