import type { Metadata } from 'next';
import { NextRequest } from 'next/server';
import { AccommodationsClient, type AccommodationsInitial } from './_AccommodationsClient';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { defaultOgImages } from '@/lib/seo/og-image';
import { GET as getAccommodations } from '@/app/api/accommodations/route';
import { ACCOMMODATIONS_FIRST_PAGE_QUERY } from '@/lib/stay/catalog-first-page';

// Список читается на запросе: сборка Docker идёт без базы, и запечённый
// отказ жил бы до следующей сборки (tests/unit/no-build-time-db.test.ts).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Жильё на Камчатке — отели, хостелы, глэмпинг',
  description: 'Проверенные отели, хостелы, кемпинги и глэмпинг на Камчатке. Бронирование с подтверждением, реальные цены.',
  openGraph: {
    images: defaultOgImages(),
    title: 'Жильё на Камчатке',
    description: 'Отели, хостелы, глэмпинг и кемпинги — от центра Петропавловска до природных парков.',
    type: 'website',
  },
  alternates: { canonical: '/accommodations' },
};

/**
 * Первая страница витрины — с сервера (аудит vedarai.ru 01.10): список
 * собирался только в браузере, и в HTML не было ни одной ссылки на карточку
 * жилья — обход сайта не находил их ни с одной страницы.
 *
 * Спрашивается ТОТ ЖЕ обработчик, что зовёт браузер, с тем же запросом
 * первой загрузки: своего SQL у страницы нет, и отбор витрины (модерация,
 * сортировка, NULL-оценки) не может разойтись с клиентским.
 * Отказ — `null`: клиент тогда спросит сам, как раньше.
 */
async function loadFirstPage(): Promise<AccommodationsInitial | null> {
  try {
    const res = await getAccommodations(
      new NextRequest(`http://internal/api/accommodations?${ACCOMMODATIONS_FIRST_PAGE_QUERY}`),
    );
    const body = (await res.json()) as {
      success?: boolean;
      error?: string;
      data?: AccommodationsInitial['raw'];
    };
    if (!res.ok || !body.success || !body.data || !Array.isArray(body.data.accommodations)) {
      console.error('[accommodations] витрина не прочитана на сервере:', res.status, body.error ?? '');
      return null;
    }
    return { raw: body.data };
  } catch (err) {
    console.error('[accommodations] витрина не прочитана на сервере:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export default async function AccommodationsPage() {
  const initial = await loadFirstPage();
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <main className="flex-1 pt-[56px]">
        <AccommodationsClient initial={initial} />
      </main>
      <Footer />
    </div>
  );
}
