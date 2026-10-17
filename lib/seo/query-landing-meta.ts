import type { Metadata } from 'next';
import { defaultOgImages } from '@/lib/seo/og-image';
import { LANDING_OG_LOCALE, landingAlternates, type QueryLanding } from '@/lib/seo/query-landings';

/** Метаданные посадочной: свой title/description, canonical, hreflang только у группы. */
export function landingMetadata(l: QueryLanding, site = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru'): Metadata {
  const self = `${site}${l.path}`;
  const languages = landingAlternates(l, site);
  return {
    // absolute: шаблон корневого layout дописал бы « | Ведар» к чужому языку.
    title: { absolute: l.title },
    description: l.description,
    alternates: { canonical: self, ...(Object.keys(languages).length ? { languages } : {}) },
    openGraph: {
      url: self, title: l.title, description: l.description, images: defaultOgImages(),
      locale: LANDING_OG_LOCALE[l.lang], type: 'website', siteName: l.lang === 'ru' ? 'Ведар' : 'Vedar',
    },
    robots: { index: true, follow: true },
  };
}
