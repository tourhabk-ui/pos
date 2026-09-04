/**
 * GET /api/cron/catalog-census — живые числа каталога для README.
 * Authorization: Bearer <CRON_SECRET>. READ-ONLY.
 *
 * ЗАЧЕМ. Таблица «Каталог» в README писалась руками и с июля держала
 * «~415 мест, ~421 маршрут», пока переписи 23.08 и 01.09 давали 379 и 288.
 * Внешний обзор репозитория 04.09 унаследовал завышенную пару как факт.
 * Та же болезнь, что с «778 местами» и «20 турами» (CLAUDE.md §4.1): по
 * завышенной цифре работа считается сделанной там, где она не начиналась.
 *
 * Теперь числа снимаются ЗДЕСЬ, и post-merge.yml переписывает блок README
 * между CATALOG:START/END вместе с датой замера (scripts/update-readme-stats
 * --catalog). Рукой в README цифры каталога больше не пишутся — сторож
 * tests/unit/readme-catalog-census.test.ts.
 *
 * ОПРЕДЕЛЕНИЯ — в ответе, не в голове читателя:
 *   places_living  — is_visible и не слитые (merged_into_id IS NULL);
 *   routes_living  — то же для kamchatka_routes;
 *   guides_certified — гиды с подтверждённой (is_verified) аттестацией,
 *                      у которой срок не истёк; считаются ЛЮДИ, не бумаги.
 *
 * ТРЕТЬЕ СОСТОЯНИЕ (§4.0): каждое число — number | null. Упавший запрос
 * даёт null и строку в лог, а не ноль и не прежнее значение.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export interface CatalogCensus {
  ok: true;
  probe: 'catalog_census_v1';
  measured_at: string;
  places_living: number | null;
  routes_living: number | null;
  guides_certified: number | null;
  definitions: Record<'places_living' | 'routes_living' | 'guides_certified', string>;
  errors: string[];
}

export const DEFINITIONS: CatalogCensus['definitions'] = {
  places_living: 'places: is_visible = true и merged_into_id IS NULL',
  routes_living: 'kamchatka_routes: is_visible = true и merged_into_id IS NULL',
  guides_certified: 'guide_certifications: различных guide_id с is_verified = true и неистёкшим expiry_date',
};

async function countOrNull(name: string, sql: string, errors: string[]): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ n: number }>(sql);
    const n = rows[0]?.n;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[catalog-census] ${name} не посчитан (SQLSTATE ${code}): ${message}`);
    errors.push(`${name}: ${message.slice(0, 120)}`);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const errors: string[] = [];
  const [places, routes, guides] = await Promise.all([
    countOrNull(
      'places_living',
      `SELECT COUNT(*)::int AS n FROM places WHERE is_visible = true AND merged_into_id IS NULL`,
      errors,
    ),
    countOrNull(
      'routes_living',
      `SELECT COUNT(*)::int AS n FROM kamchatka_routes WHERE is_visible = true AND merged_into_id IS NULL`,
      errors,
    ),
    countOrNull(
      'guides_certified',
      `SELECT COUNT(DISTINCT guide_id)::int AS n
         FROM guide_certifications
        WHERE is_verified = true
          AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)`,
      errors,
    ),
  ]);

  const body: CatalogCensus = {
    ok: true,
    probe: 'catalog_census_v1',
    measured_at: new Date().toISOString(),
    places_living: places,
    routes_living: routes,
    guides_certified: guides,
    definitions: DEFINITIONS,
    errors,
  };
  return NextResponse.json(body);
}
