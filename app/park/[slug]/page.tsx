import type { Metadata } from 'next';
import { fitTitle, PARK_TITLE_TAILS } from '@/lib/seo/title-fit';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { loadParkPage, type ParkPageData } from '@/lib/parks/park-page';
import { defaultOgImages } from '@/lib/seo/og-image';
import ParkClient from './_ParkClient';

// Карточка парка собирается на сервере (аудит 01.10): прежде страница была
// оболочкой, а содержимое клиент тянул из API в браузере — поисковик видел
// 12–13 слов без заголовка. Рендер на запросе: справочник и маршруты живые.
export const dynamic = 'force-dynamic';

/**
 * Один поход в базу на рендер: метаданные и страница зовут загрузчик
 * независимо. 'failed' — база не ответила; null — парка нет.
 */
const getPark = cache(async (slug: string): Promise<ParkPageData | null | 'failed'> => {
  try {
    return await loadParkPage(slug);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[park] парк не прочитан:', slug, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return 'failed';
  }
});

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const park = await getPark(slug);
  if (park === null) return { title: 'Парк не найден', robots: { index: false, follow: false } };
  const name = park === 'failed' ? 'Природный парк Камчатки' : park.displayName;
  // Полный хвост давал 70–78 знаков с « | Ведар» — выдача резала (аудит 01.10).
  const title = fitTitle(name, PARK_TITLE_TAILS);
  const description = `Маршруты, офлайн-карты и регистрация в МЧС для ${name}. Скачайте карту до выхода в поле.`;
  return {
    title,
    description,
    alternates: { canonical: `/park/${slug}` },
    openGraph: {
      title,
      description,
      url: `/park/${slug}`,
      siteName: 'Ведар',
      locale: 'ru_RU',
      type: 'website',
      images: defaultOgImages(),
    },
  };
}

export default async function ParkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const park = await getPark(slug);
  if (park === null) notFound();

  return (
    <>
      <Header />
      {park === 'failed' ? (
        <div className="ds-page pt-24 pb-10 text-center">
          <p className="text-[var(--text-secondary)]">Не удалось загрузить карточку парка. Обновите страницу.</p>
        </div>
      ) : (
        <ParkClient park={park} />
      )}
    </>
  );
}
