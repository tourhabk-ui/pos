import type { Metadata } from 'next';
import { pool } from '@/lib/db-pool';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { metaDescription } from '@/lib/seo/meta-description';
import { notFound } from 'next/navigation';
import { loadAccommodationDetail, type AccommodationDetailData } from '@/lib/stay/accommodation-detail';
import AccommodationDetailClient from './_AccommodationDetailClient';

export const revalidate = 600;

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { title: 'Объект не найден' };

  try {
    const { rows } = await pool.query<{ name: string; short_description: string | null; description: string | null }>(
      `SELECT name, short_description, description FROM accommodations WHERE id = $1 AND ${publicAccommodationSql('')}`,
      [id]
    );
    const acc = rows[0];
    if (!acc) return { title: 'Объект не найден' };

    // Как у тура: короткое описание, а короче 110 знаков — добрать из полного
    // (перепись 13.10: у карточки было 57 знаков). Пусто — строка с именем.
    const short = (acc.short_description ?? '').trim();
    const description = (short.length >= 110 ? metaDescription(short) : metaDescription([short, acc.description ?? ''].filter(Boolean).join(' ')))
      || `${acc.name} — жильё на Камчатке: описание, условия и заявка владельцу.`;
    return {
      title: `${acc.name} — жильё на Камчатке`,
      description,
      alternates: { canonical: `https://vedarai.ru/accommodations/${id}` },
    };
  } catch (e) {
    // Не смогли прочитать — так и пишем в лог (§4.0), страница возьмёт заголовок раздела.
    const err = e as { code?: string; message?: string };
    console.error('[accommodations/[id]] метаданные не прочитаны:', id, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return { title: 'Жильё на Камчатке' };
  }
}

/**
 * Карточка собирается на сервере (аудит 01.10): прежде страница была
 * оболочкой, и поисковик видел 19 слов без заголовка. Нет объекта — 404;
 * база не ответила — клиент попробует сам и покажет отказ, а не пустоту.
 */
export default async function AccommodationDetailPage({ params }: Props) {
  const { id } = await params;
  let initialData: AccommodationDetailData | null = null;
  try {
    initialData = await loadAccommodationDetail(id);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[accommodations/[id]] карточка не прочитана:', id, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return <AccommodationDetailClient accommodationId={id} />;
  }
  if (!initialData) notFound();
  return <AccommodationDetailClient accommodationId={id} initialData={initialData} />;
}
