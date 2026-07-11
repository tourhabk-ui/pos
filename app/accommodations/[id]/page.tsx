import type { Metadata } from 'next';
import { pool } from '@/lib/db-pool';
import AccommodationDetailClient from './_AccommodationDetailClient';

export const revalidate = 600;

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { title: 'Объект не найден | Tourhab' };

  try {
    const { rows } = await pool.query<{ name: string; short_description: string | null }>(
      `SELECT name, short_description FROM accommodations WHERE id = $1 AND is_active = true`,
      [id]
    );
    const acc = rows[0];
    if (!acc) return { title: 'Объект не найден | Tourhab' };

    return {
      title: `${acc.name} — жильё на Камчатке | Tourhab`,
      description: acc.short_description ?? `${acc.name}: описание, номера, цены и бронирование`,
      alternates: { canonical: `https://vedarai.ru/accommodations/${id}` },
    };
  } catch {
    return { title: 'Жильё на Камчатке | Tourhab' };
  }
}

export default async function AccommodationDetailPage({ params }: Props) {
  const { id } = await params;
  return <AccommodationDetailClient accommodationId={id} />;
}
