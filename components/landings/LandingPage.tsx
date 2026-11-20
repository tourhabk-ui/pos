/** Страница посадочной целиком: шапка, хлебные крошки, тело (LandingContent). */
import Link from 'next/link';
import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { LandingContent } from '@/components/landings/LandingContent';
import { pageContainer } from '@/lib/layout/page-width';
import { landingBySlug, type Landing } from '@/lib/landings/landings';
import { loadToursFor } from '@/lib/landings/tours';
import { brandedTitle } from '@/lib/seo/title-fit';
import { defaultOgImages } from '@/lib/seo/og-image';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export function landingPageMetadata(landing: Landing): Metadata {
  const url = `${SITE}${landing.path}`;
  return {
    title: brandedTitle(landing.title),
    description: landing.description,
    alternates: { canonical: url },
    openGraph: { title: landing.title, description: landing.description, url, type: 'article', images: defaultOgImages() },
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

export async function LandingPage({ slug }: { slug: string }) {
  const landing = landingBySlug(slug);
  const tours = await loadToursFor(landing);
  return (
    <>
      <JsonLd data={landingBreadcrumbJsonLd(landing)} />
      <Header />
      <main className="ds-page">
        <div className={`${pageContainer('reading')} py-8 space-y-6`}>
          <nav className="text-sm" style={{ color: 'var(--text-muted)' }} aria-label="Хлебные крошки">
            <Link href="/">Главная</Link>
          </nav>
          <LandingContent landing={landing} tours={tours} />
        </div>
      </main>
    </>
  );
}
