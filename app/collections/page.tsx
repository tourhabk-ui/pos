import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { loadPublicCollections, type CollectionCardData } from '@/lib/collections/list';
import { CollectionsClient } from './_CollectionsClient';

// Список собирается на сервере и на каждый запрос (аудит 01.10): прежде
// страница была оболочкой, и поисковик видел 21–23 слова вместо подборок.
// Сторож: tests/unit/collections-ssr.test.ts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  alternates: { canonical: '/collections' },
  title: 'Подборки маршрутов Камчатки',
  description: 'Кураторские подборки лучших мест и маршрутов Камчатки — вулканы, источники, дикая природа',
};

export default async function CollectionsPage() {
  let collections: CollectionCardData[] = [];
  let failed = false;
  try {
    collections = await loadPublicCollections({ limit: 50 });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[collections] подборки не прочитаны:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    failed = true;
  }
  return (
    <>
      <Header />
      <CollectionsClient collections={collections} failed={failed} />
    </>
  );
}
