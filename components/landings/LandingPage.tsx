/**
 * Страница посадочной целиком: шапка, главный кадр с H1 и хлебными крошками
 * (lib/landings/design, ТЗ Сыщика 21.11), тело (LandingContent).
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { LandingContent } from '@/components/landings/LandingContent';
import { LandingHero } from '@/components/landings/LandingMedia';
import { landingDesign, landingOgImagePath } from '@/lib/landings/design';
import { pageContainer } from '@/lib/layout/page-width';
import { landingBySlug, landingByPath, monthLinks, type Landing } from '@/lib/landings/landings';
import { loadToursFor, loadPublicTours, type LandingBlockTour } from '@/lib/landings/tours';
import { tourPath } from '@/lib/tours/tour-url';
import { landingWithLiveText, hasLiveMarks } from '@/lib/landings/live-text';
import { brandedTitle } from '@/lib/seo/title-fit';
import { defaultOgImages } from '@/lib/seo/og-image';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/**
 * Картинка превью: главный кадр страницы (крупнейший готовый вариант);
 * у страницы без кадра — общая картинка сайта.
 */
export function landingOgImages(landing: Landing): Array<{ url: string; width: number; height: number; alt: string }> {
  const hero = landingDesign(landing.slug).hero;
  if (!hero) return defaultOgImages();
  const path = landingOgImagePath(hero);
  const w = /\.(\d+)\.webp$/.exec(path);
  const width = w ? Math.min(Number(w[1]), hero.width) : hero.width;
  const height = Math.round((width * hero.height) / hero.width);
  return [{ url: `${SITE}${path}`, width, height, alt: hero.alt }];
}

export function landingPageMetadata(landing: Landing): Metadata {
  const url = `${SITE}${landing.path}`;
  const images = landingOgImages(landing);
  return {
    title: brandedTitle(landing.title),
    description: landing.description,
    alternates: { canonical: url },
    openGraph: { title: landing.title, description: landing.description, url, type: 'article', images },
    twitter: { card: 'summary_large_image', title: landing.title, description: landing.description, images: images.map((i) => i.url) },
  };
}

export function landingBreadcrumbJsonLd(landing: Landing): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: SITE },
      { '@type': 'ListItem', position: 2, name: landing.h1, item: `${SITE}${landing.path}` },
    ],
  };
}

/**
 * ItemList подборки (спецификация разметки Сыщика §4.4–4.5, повторный аудит
 * 21.11): у страницы с блоком туров — те же туры и в том же порядке, что на
 * экране (из базы на запросе, без кэша); у хаба «Когда ехать» — двенадцать
 * месяцев. Пустой блок — узла нет: список без элементов не размечается.
 */
export function landingItemListJsonLd(landing: Landing, tours: LandingBlockTour[] | null): Record<string, unknown> | null {
  const items: Array<{ name: string; url: string }> =
    landing.slug === 'kogda-ehat-na-kamchatku'
      ? monthLinks().map((m) => ({ name: landingByPath(m.href)?.h1 ?? m.label, url: `${SITE}${m.href}` }))
      : landing.tours.kind !== 'none' && tours && tours.length > 0
        ? tours.map((t) => ({ name: t.title, url: `${SITE}${tourPath(t)}` }))
        : [];
  if (items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${SITE}${landing.path}#list`,
    name: landing.h1,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, url: it.url })),
  };
}

export async function LandingPage({ slug, middle, footer }: {
  slug: string;
  /** Свой блок на месте блока туров (у /kogda-ehat-na-kamchatku — «По месяцам»). */
  middle?: ReactNode;
  /** Блок под текстом (у хаба месяцев — навигация по месяцам). */
  footer?: ReactNode;
}) {
  const base = landingBySlug(slug);
  // Живые числа текста (метки {{…}}, lib/landings/live-text) — из базы на запросе.
  const [tours, live] = await Promise.all([loadToursFor(base), hasLiveMarks(base) ? loadPublicTours() : Promise.resolve(null)]);
  const landing = landingWithLiveText(base, live);
  const itemList = landingItemListJsonLd(landing, tours);
  return (
    <>
      <JsonLd data={landingBreadcrumbJsonLd(landing)} />
      {itemList && <JsonLd data={itemList} />}
      <Header />
      <main className="ds-page">
        <LandingHero h1={landing.h1} photo={landingDesign(landing.slug).hero} />
        <div className={`${pageContainer('reading')} py-6 space-y-6`}>
          <LandingContent landing={landing} tours={tours} middle={middle} showH1={false} kuzmich />
          {footer}
        </div>
      </main>
    </>
  );
}
