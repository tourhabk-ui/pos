/**
 * /zh/harbin — «从哈尔滨飞往堪察加» (слово владельца 25.10).
 * Факты и ссылки — lib/zh/harbin. Туры на неделю — из базы.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Header } from '@/components/layout/Header';
import { HarbinFlight } from '@/components/zh/HarbinFlight';
import { HARBIN_PAGE, HARBIN_PATH, loadSaturdayWeekTours } from '@/lib/zh/harbin';
import { recordZhEntryHit } from '@/lib/analytics/agent-entry-hits';
import { defaultOgImages } from '@/lib/seo/og-image';
import { loadCnyRate } from '@/lib/currency/cbr-rate';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: { absolute: HARBIN_PAGE.title },
  description: HARBIN_PAGE.description,
  alternates: { canonical: `${SITE}${HARBIN_PATH}` },
  openGraph: {
    url: `${SITE}${HARBIN_PATH}`,
    title: HARBIN_PAGE.title,
    description: HARBIN_PAGE.description,
    images: defaultOgImages(),
    locale: 'zh_CN',
    type: 'website',
    siteName: 'Vedar',
  },
  robots: { index: true, follow: true },
};

export default async function HarbinPage() {
  recordZhEntryHit(HARBIN_PATH, (await headers()).get('user-agent'));
  const [tours, cny] = await Promise.all([loadSaturdayWeekTours(), loadCnyRate()]);
  return (
    <>
      <Header />
      <main className="ds-page" lang="zh-CN">
        <HarbinFlight tours={tours} cny={cny} />
      </main>
    </>
  );
}
