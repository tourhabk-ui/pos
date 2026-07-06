import type { Metadata } from 'next';
import { pool } from '@/lib/db-pool';
import ParkClient from './_ParkClient';

// Имя парка — из справочника parks (migration 712), не из хардкода.
// Ошибка БД не должна ронять метаданные — generic fallback.
async function getParkName(slug: string): Promise<string> {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return 'Природный парк Камчатки';
  try {
    const { rows } = await pool.query<{ display_name: string }>(
      `SELECT display_name FROM parks WHERE slug = $1 AND is_active = true LIMIT 1`,
      [slug]
    );
    return rows[0]?.display_name ?? 'Природный парк Камчатки';
  } catch {
    return 'Природный парк Камчатки';
  }
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const name = await getParkName(slug);
  return {
    title: `${name} — маршруты, карты офлайн, регистрация МЧС | Ведар`,
    description: `Маршруты, офлайн-карты и регистрация в МЧС для ${name}. Скачайте карту до выхода в поле.`,
    alternates: { canonical: `/park/${slug}` },
  };
}

export default async function ParkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ParkClient slug={slug} />;
}
