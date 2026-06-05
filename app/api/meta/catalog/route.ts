/**
 * Meta Product Catalog — Каталог туров TourHab
 *
 * Публичный GET endpoint в формате Meta Product Feed (JSON).
 * Используется как источник данных для:
 *   - Instagram Shopping
 *   - WhatsApp Business Catalog
 *   - Messenger Product Messages
 *
 * Настройка:
 *   Meta Business Suite → Commerce Manager → Catalog → Data Sources
 *   → Add Data Feed → URL: vedarai.ru/api/meta/catalog
 *   → Schedule: Daily
 *
 * GET /api/meta/catalog → JSON Product Feed
 */

import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vedarai.ru';
const FALLBACK_IMAGE = `${APP_URL}/images/hero/hero-dark.jpeg`;

interface TourRow {
  id: number;
  title: string;
  description: string | null;
  base_price: string;
  location_name: string | null;
  activity_type: string | null;
  tour_image: string | null;
  operator_name: string | null;
  is_active: boolean;
}

function buildProductEntry(tour: TourRow) {
  const price = parseFloat(tour.base_price);
  const priceFormatted = `${price.toFixed(2)} RUB`;

  // Первое изображение из tour_image или fallback
  const imageLink = tour.tour_image
    ? (tour.tour_image.startsWith('http') ? tour.tour_image : `${APP_URL}${tour.tour_image}`)
    : FALLBACK_IMAGE;

  const category = activityCategory(tour.activity_type);

  return {
    id: `tour_${tour.id}`,
    title: tour.title,
    description: (tour.description ?? tour.title).slice(0, 9999),
    availability: 'in stock',
    condition: 'new',
    price: priceFormatted,
    link: `${APP_URL}/marketplace/tours/${tour.id}`,
    image_link: imageLink,
    brand: tour.operator_name ?? 'Vedarai',
    google_product_category: category,
  };
}

function activityCategory(activity: string | null): string {
  switch (activity) {
    case 'helicopter': return 'Travel > Air Travel';
    case 'fishing':    return 'Travel > Tours & Activities > Fishing Tours';
    case 'boat_trip':  return 'Travel > Tours & Activities > Boat Tours';
    default:           return 'Travel > Tours & Activities';
  }
}

export async function GET() {
  try {
    const result = await pool.query<TourRow>(
      `SELECT
         ot.id, ot.title, ot.description, ot.base_price,
         ot.location_name, ot.activity_type, ot.tour_image,
         ot.is_active,
         p.name AS operator_name
       FROM operator_tours ot
       LEFT JOIN partners p ON p.id = ot.operator_id
       WHERE ot.is_active = true
         AND ot.deleted_at IS NULL
       ORDER BY ot.base_price ASC
       LIMIT 500`,
    );

    const products = result.rows.map(buildProductEntry);

    return NextResponse.json(
      { data: products },
      {
        headers: {
          'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
          'Content-Type': 'application/json',
        },
      },
    );
  } catch {
    return NextResponse.json(
      { error: 'Не удалось загрузить каталог' },
      { status: 500 },
    );
  }
}
