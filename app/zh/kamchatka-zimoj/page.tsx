/**
 * /zh/kamchatka-zimoj — 冬季的堪察加：雪山火山、海洋和温泉（Сыщик, 23.11.2026）。
 */
import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { ZhGuideView } from '@/components/zh/ZhGuide';
import { defaultOgImages } from '@/lib/seo/og-image';
import { ZH_CONTENT_LANGUAGE } from '@/lib/zh/pages';
import { ZH_WINTER_GUIDE, zhGuideHreflang } from '@/lib/zh/guides';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const GUIDE = ZH_WINTER_GUIDE;

export const metadata: Metadata = {
  title: { absolute: GUIDE.title },
  description: GUIDE.description,
  alternates: { canonical: `${SITE}${GUIDE.path}`, languages: zhGuideHreflang(GUIDE, SITE) },
  openGraph: {
    url: `${SITE}${GUIDE.path}`,
    title: GUIDE.title,
    description: GUIDE.description,
    images: defaultOgImages(),
    locale: 'zh_CN',
    type: 'article',
    siteName: 'Vedar',
  },
  robots: { index: true, follow: true },
};

export default function ZhWinterPage() {
  return (
    <>
      <Header />
      <main className="ds-page" lang={ZH_CONTENT_LANGUAGE}>
        <ZhGuideView guide={GUIDE} />
      </main>
    </>
  );
}
