import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { SectionSwipeBar, SAFETY_SECTION_ITEMS } from '@/components/layout/SectionSwipeBar';
import { JsonLd } from '@/components/seo/JsonLd';
import { defaultOgImages } from '@/lib/seo/og-image';
import { safetyHreflang } from '@/lib/zh/pages';
import { getSafetyLiveData } from '@/app/_home/data';
import {
  SAFETY_PAGE_DESCRIPTION,
  SAFETY_PAGE_TITLE,
  safetyArticleJsonLd,
} from '@/lib/seo/safety-page';
import SafetyAbout, { SafetyIntro, SafetyLiveIntro } from './SafetyAbout';
import SafetyClient from './_SafetyClient';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: SAFETY_PAGE_TITLE,
  description: SAFETY_PAGE_DESCRIPTION,
  alternates: { canonical: `${SITE}/safety`, languages: safetyHreflang(SITE) },
  openGraph: {
    images: defaultOgImages(),
    title: SAFETY_PAGE_TITLE,
    description: SAFETY_PAGE_DESCRIPTION,
    url: `${SITE}/safety`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'article',
  },
};

async function SafetyLive() {
  const live = await getSafetyLiveData().catch(() => null);
  return <SafetyClient live={live} />;
}

export default function SafetyPage() {
  return (
    <>
      <Header />
      <JsonLd data={safetyArticleJsonLd(SITE)} />
      {/* H1 и прямой ответ — в серверном HTML сразу, затем живая обстановка
          (радар), затем статья и FAQ. Бот без JS читает лид в первых абзацах. */}
      <div className="ds-page px-4" style={{ maxWidth: 680, margin: '0 auto', paddingBottom: 96 }}>
        <SectionSwipeBar items={SAFETY_SECTION_ITEMS} label="Разделы безопасности" className="-mx-4" />
        <SafetyIntro />
        <SafetyLiveIntro />
        <Suspense fallback={<p role="status" className="text-sm" style={{ color: 'var(--text-muted)' }}>Загрузка обстановки…</p>}>
          <SafetyLive />
        </Suspense>
        <SafetyAbout />
      </div>
      <BottomNav activePath="/safety" />
    </>
  );
}
