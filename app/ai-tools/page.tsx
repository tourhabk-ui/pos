import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { defaultOgImages } from '@/lib/seo/og-image';
import { TravelAppsList } from '@/components/travel-apps/TravelAppsList';
import { listTravelApps, type ExternalTool } from '@/lib/agents/tools/taaft-search';

export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'Сторонние приложения для поездки на Камчатку: офлайн-карты, треки туристов, вершины, определение растений и животных по фото. Их делают другие компании.';

export const metadata: Metadata = {
  title: 'Приложения в дорогу',
  description: DESCRIPTION,
  openGraph: {
    images: defaultOgImages(),
    title: 'Приложения в дорогу — Камчатка',
    description: DESCRIPTION,
    type: 'website',
  },
  alternates: { canonical: '/ai-tools' },
};

export default async function TravelAppsPage() {
  let apps: ExternalTool[] | null = null;
  try {
    apps = await listTravelApps();
  } catch (err) {
    // «Не загрузилось» человеку, причина — в лог (§4.0).
    console.error('[ai-tools] список приложений не прочитан:', (err as { code?: string })?.code ?? '', err instanceof Error ? err.message : err);
  }
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <main className="flex-1 pt-[56px]">
        <TravelAppsList apps={apps} />
      </main>
      <Footer />
    </div>
  );
}
