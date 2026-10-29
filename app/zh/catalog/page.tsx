/**
 * /zh/catalog — китайский каталог, пара русской /catalog.
 * Список — тот же, что на /zh (lib/zh/entry): факты из базы, без среза.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { ZhTourList } from '@/components/zh/ZhTourList';
import { ZH_CATALOG } from '@/lib/zh/catalog-copy';
import { loadZhTours } from '@/lib/zh/entry';
import { ZH_CATALOG_PATH, catalogHreflang } from '@/lib/zh/pages';
import { recordZhEntryHit } from '@/lib/analytics/agent-entry-hits';
import { defaultOgImages } from '@/lib/seo/og-image';
import { loadCnyRate } from '@/lib/currency/cbr-rate';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: { absolute: ZH_CATALOG.title },
  description: ZH_CATALOG.description,
  alternates: {
    canonical: `${SITE}${ZH_CATALOG_PATH}`,
    languages: catalogHreflang(SITE),
  },
  openGraph: {
    url: `${SITE}${ZH_CATALOG_PATH}`,
    title: ZH_CATALOG.title,
    description: ZH_CATALOG.description,
    images: defaultOgImages(),
    locale: 'zh_CN',
    type: 'website',
    siteName: 'Vedar',
  },
  robots: { index: true, follow: true },
};

export default async function ZhCatalogPage() {
  recordZhEntryHit(ZH_CATALOG_PATH, (await headers()).get('user-agent'));
  const [tours, cny] = await Promise.all([loadZhTours(), loadCnyRate()]);
  return (
    <>
      <Header />
      <main className="ds-page" lang="zh-CN">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
          <header className="space-y-3">
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {ZH_CATALOG.h1}
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{ZH_CATALOG.intro}</p>
          </header>
          <ZhTourList tours={tours} cny={cny} />
          <footer className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            <Link className="underline" href="/catalog">俄文目录</Link>
            {' · '}<Link className="underline" href="/zh/harbin">从哈尔滨飞往堪察加</Link>
            {' · '}<Link className="underline" href="/zh">中文首页</Link>
          </footer>
        </div>
      </main>
    </>
  );
}
