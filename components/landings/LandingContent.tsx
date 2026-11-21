/**
 * Тело посадочной страницы Сыщика (lib/landings): текст до блока туров, блок
 * туров из базы (или свой блок страницы — «План по дням» у /plans), текст
 * после, перелинковка месяцев и разметка Article + FAQPage. Дата правки —
 * дата ревизии текста из исходника (`date`), видимая и в dateModified.
 *
 * Оформление (ТЗ Сыщика 21.11, lib/landings/design): «Коротко» в рамке,
 * оглавление с якорями, цветные блоки, фото в тексте, карточки туров с
 * обложкой, FAQ в <details>, блок «Спросите Кузьмича». Всё — в HTML сервера.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { JsonLd } from '@/components/seo/JsonLd';
import { LandingBody, SOURCES_RE } from '@/components/landings/LandingBody';
import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';
import { parseArticleMarkdown, faqFromBlocks, type Block } from '@/lib/articles/markdown';
import { articleJsonLd } from '@/lib/articles/article-jsonld';
import { isMonthLanding, monthLinks, MONTHS_HUB, type Landing } from '@/lib/landings/landings';
import { tourBlockHeading, tourBlockNote, type LandingBlockTour } from '@/lib/landings/tours';
import { landingDesign, landingOgImagePath, reviewedTourCover } from '@/lib/landings/design';
import { landingDates, landingDuration, landingPrice, landingSeason } from '@/lib/seo/query-landing-view';
import { tourPath } from '@/lib/tours/tour-url';
import { photoSrc, photoSrcSet } from '@/lib/images/variant';
import { slugify } from '@/lib/text/slugify';
import { operatorPausedOnTourBlocks } from '@/lib/operators/site-pause';
import { tourPhotoPosition } from '@/lib/tours/photo-focus';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/** Ссылка на Кузьмича в Telegram (слово владельца: вести на бота). */
export const KUZMICH_TG = 'https://t.me/kuzmichai_bot';

export function landingJsonLd(landing: Landing): Record<string, unknown> {
  const blocks = [...parseArticleMarkdown(landing.before), ...parseArticleMarkdown(landing.after)];
  const hero = landingDesign(landing.slug).hero;
  return articleJsonLd({
    url: `${SITE}${landing.path}`,
    site: SITE,
    headline: landing.h1,
    description: landing.description,
    datePublished: landing.date,
    dateModified: landing.date,
    faq: faqFromBlocks(blocks),
    image: hero ? landingOgImagePath(hero) : null,
  });
}

/**
 * id заголовков H2: транслит текста (тот же, что у слагов сайта), без
 * повторов; «landing-tours» занят блоком туров. Стабильны между выкладками,
 * пока не меняется текст заголовка.
 */
export function headingIds(blocks: readonly Block[]): Map<Block, string> {
  const used = new Set<string>(['landing-tours']);
  const ids = new Map<Block, string>();
  for (const b of blocks) {
    if (b.t !== 'h2') continue;
    const base = slugify(b.text) || 'razdel';
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    ids.set(b, id);
  }
  return ids;
}

export function LandingToc({ items }: { items: Array<{ id: string; label: string }> }) {
  return (
    <nav className="landing-toc" aria-label="Оглавление" data-landing-toc="">
      <p className="landing-toc-title">На этой странице</p>
      <ol>
        {items.map((it) => <li key={it.id}><a className="landing-toc-link" href={`#${it.id}`}>{it.label}</a></li>)}
      </ol>
    </nav>
  );
}

/** «Спросите Кузьмича» — статичный блок, без виджета чата. */
export function LandingKuzmich() {
  return (
    <aside className="landing-kuzmich" aria-labelledby="landing-kuzmich" data-landing-kuzmich="">
      <img src="/images/brand/bear-128.webp" alt="" width={48} height={48} loading="lazy" decoding="async" />
      <div>
        <h2 id="landing-kuzmich" className="landing-kuzmich-title">Спросите Кузьмича</h2>
        <p>Кузьмич — ИИ-помощник Ведара. Спросите про сезон, дорогу и что взять с собой: он отвечает по данным платформы.</p>
        <a className="landing-btn" href={KUZMICH_TG} rel="noopener noreferrer" target="_blank">Написать в Telegram @kuzmichai_bot</a>
      </div>
    </aside>
  );
}

function tourCover(t: LandingBlockTour): string | null {
  if (operatorPausedOnTourBlocks(t.operator_slug)) return null;
  return reviewedTourCover(t.slug, t.cover);
}

function TourCover({ src }: { src: string | null }) {
  if (!src) {
    return <span className="landing-tour-cover landing-tour-cover--plain" aria-hidden="true" />;
  }
  return (
    <img
      className="landing-tour-cover"
      src={photoSrc(src, 640)}
      srcSet={photoSrcSet(src)}
      sizes="(max-width: 640px) 100vw, 24rem"
      alt=""
      width={640}
      height={400}
      loading="lazy"
      decoding="async"
      style={{ objectPosition: tourPhotoPosition(src) }}
    />
  );
}

export function LandingTours({ landing, tours }: { landing: Landing; tours: LandingBlockTour[] | null }) {
  if (landing.tours.kind === 'none') return null;
  return (
    <section className="space-y-3" aria-labelledby="landing-tours" data-landing-tours>
      <h2 id="landing-tours" className="ds-h2 landing-h2" style={{ fontFamily: 'var(--font-playfair)' }}>{tourBlockHeading(landing.tours)}</h2>
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
          <ul className="landing-tours">
            {tours.map((t) => { const cover = tourCover(t); return (
              <li key={t.id} className="landing-tour-card text-sm" data-landing-tour={t.id}>
                <Link className="landing-tour-link" href={tourPath(t)}>
                  <TourCover src={cover} />
                  <span className="landing-tour-title">{t.title}</span>
                </Link>
                <div className="landing-tour-meta">
                  {cover && (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Фото: <OperatorNameLink name={t.operator_name} slug={t.operator_slug} isPublic={t.operator_public} />
                    </p>
                  )}
                  <p style={{ color: 'var(--text-secondary)' }}>
                    Оператор: <OperatorNameLink name={t.operator_name} slug={t.operator_slug} isPublic={t.operator_public} />
                  </p>
                  <p style={{ color: 'var(--text-primary)' }}>
                    {[landingPrice(t, 'ru') ?? 'цена по запросу', landingDuration(t, 'ru'), landingSeason(t, 'ru'), landingDates(t, 'ru')].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </li>
            ); })}
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

export function LandingContent({ landing, tours, showH1 = true, middle, withJsonLd = true, kuzmich = false }: {
  landing: Landing;
  tours: LandingBlockTour[] | null;
  /** H1 страницы — у своей страницы посадочной; у апгрейда H1 рисует страница. */
  showH1?: boolean;
  /** Свой блок на месте блока туров (у /plans — «План по дням»). */
  middle?: ReactNode;
  /** false — у страницы своя разметка FAQPage (/catalog, витрина рыбалки): без дубля. */
  withJsonLd?: boolean;
  /** Блок «Спросите Кузьмича» перед источниками (у своей страницы посадочной). */
  kuzmich?: boolean;
}) {
  const design = landingDesign(landing.slug);
  const before = parseArticleMarkdown(landing.before);
  const after = landing.after.trim() ? parseArticleMarkdown(landing.after) : [];
  const ids = headingIds([...before, ...after]);
  const showTours = !middle && landing.tours.kind !== 'none';
  const h2 = (bs: Block[]) => bs.flatMap((b) => (b.t === 'h2' && ids.has(b) ? [{ id: ids.get(b)!, label: b.text }] : []));
  const tocItems = [...h2(before), ...(showTours ? [{ id: 'landing-tours', label: tourBlockHeading(landing.tours) }] : []), ...h2(after)];
  const toc = tocItems.length >= 3 ? <LandingToc items={tocItems} /> : null;
  const firstQa = [...before, ...after].find((b) => b.t === 'qa') ?? null;
  const hasSources = after.some((b) => b.t === 'h2' && SOURCES_RE.test(b.text));
  const callouts = design.callouts ?? [];
  const figures = design.figures ?? [];
  return (
    <article className="landing-article space-y-6" data-landing={landing.slug}>
      {withJsonLd && <JsonLd data={landingJsonLd(landing)} />}
      {showH1 && (
        <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>{landing.h1}</h1>
      )}
      {formatRecordDate(landing.date) && (
        <p className="text-xs text-[var(--text-muted)]" data-record-modified="">
          Обновлено: <time dateTime={recordDateIso(landing.date) ?? undefined}>{formatRecordDate(landing.date)}</time>
        </p>
      )}
      <LandingBody blocks={before} ids={ids} callouts={callouts} figures={figures} afterLead={toc} openQa={firstQa} />
      {middle ?? <LandingTours landing={landing} tours={tours} />}
      {after.length > 0 && (
        <LandingBody blocks={after} ids={ids} callouts={callouts} figures={figures} openQa={firstQa} beforeSources={kuzmich && hasSources ? <LandingKuzmich /> : undefined} />
      )}
      {kuzmich && !hasSources && <LandingKuzmich />}
      {isMonthLanding(landing) && <MonthsNav current={landing.path} />}
    </article>
  );
}
