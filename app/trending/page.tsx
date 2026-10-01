import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { loadTrending, type TrendingPlace, type TrendingRoute } from '@/lib/trending/load';
import { TrendingClient } from './_TrendingClient';

// Списки собираются на сервере и на каждый запрос (аудит 01.10): прежде
// страница была оболочкой, а данные тянул браузер — поисковик видел 21–23
// слова. Популярность меняется со счётчиком просмотров, копия со сборки ей
// не подходит. Сторож: tests/unit/trending-ssr.test.ts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  alternates: { canonical: '/trending' },
  title: 'Популярные маршруты и места Камчатки',
  // По счётчику просмотров за всё время, а не «прямо сейчас» (lib/trending/load).
  description: 'Самые просматриваемые места и маршруты Камчатки на Ведаре: что открывают чаще всего, с переходом на карточку места или маршрута.',
};

export default async function TrendingPage() {
  let places: TrendingPlace[] = [];
  let routes: TrendingRoute[] = [];
  let failed = false;
  try {
    const data = await loadTrending('all', 12);
    places = data.places ?? [];
    routes = data.routes ?? [];
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[trending] список не прочитан:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    failed = true;
  }
  return (
    <>
      <Header />
      <TrendingClient places={places} routes={routes} failed={failed} />
    </>
  );
}
