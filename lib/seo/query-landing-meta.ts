import type { Metadata } from 'next';
import { defaultOgImages } from '@/lib/seo/og-image';
import { LANDING_OG_LOCALE, landingAlternates, type QueryLanding } from '@/lib/seo/query-landings';
import { landingLead, landingTitle, type LandingSummary } from '@/lib/seo/query-landing-view';

/**
 * Метаданные посадочной: свой title/description, canonical, hreflang только у
 * группы. С `summary` (туры страницы прочитаны и есть) заголовок и описание
 * несут числа из базы — сколько туров, цена «от», годы свободных дат; без неё
 * — прежние слова без чисел.
 */
export function landingMetadata(
  l: QueryLanding,
  site = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru',
  summary: LandingSummary | null = null,
): Metadata {
  const self = `${site}${l.path}`;
  const languages = landingAlternates(l, site);
  const title = landingTitle(l, summary);
  const description = landingLead(l, summary) ?? l.description;
  return {
    // absolute: шаблон корневого layout дописал бы « | Ведар» к чужому языку.
    title: { absolute: title },
    description,
    alternates: { canonical: self, ...(Object.keys(languages).length ? { languages } : {}) },
    openGraph: {
      url: self, title, description, images: defaultOgImages(),
      locale: LANDING_OG_LOCALE[l.lang], type: 'website', siteName: l.lang === 'ru' ? 'Ведар' : 'Vedar',
    },
    robots: { index: true, follow: true },
  };
}
