/**
 * «Нужно ли разрешение на посещение мест Камчатки» (#3566 п.5, 21.11).
 * Статическая: факты — константы справочника lib/safety/park-permit, базы не
 * спрашивает и открывается без сети, как и карточка маршрута с теми же фактами.
 */
import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { PermitGuideView } from '@/components/seo/PermitGuide';
import { defaultOgImages } from '@/lib/seo/og-image';
import { PERMIT_GUIDE_DESCRIPTION, PERMIT_GUIDE_PATH, PERMIT_GUIDE_TITLE } from '@/lib/seo/permit-guide';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  // Без absolute: шаблон layout добавит «| Ведар».
  title: PERMIT_GUIDE_TITLE,
  description: PERMIT_GUIDE_DESCRIPTION,
  alternates: { canonical: `${SITE}${PERMIT_GUIDE_PATH}` },
  openGraph: { url: `${SITE}${PERMIT_GUIDE_PATH}`, title: `${PERMIT_GUIDE_TITLE} | Ведар`, description: PERMIT_GUIDE_DESCRIPTION, images: defaultOgImages(), type: 'article', siteName: 'Ведар', locale: 'ru_RU' },
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <>
      <Header />
      <PermitGuideView />
    </>
  );
}
