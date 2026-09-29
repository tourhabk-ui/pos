/**
 * GET /api/cron/place-slug-census — видимые места без адреса и кто держит их
 * адрес. ТОЛЬКО ЧТЕНИЕ.
 *
 * Повод. Миграция 1111 (29.09) раздавала адрес по имени видимым местам без
 * slug, если он свободен среди мест и маршрутов. На проде адрес получили 6
 * из 24 ожидаемых: у остальных 18 естественный адрес свободен и среди живых
 * маршрутов, и среди видимых мест, — значит его держит кто-то невидимый
 * снаружи. Догадка «скрытый или слитый дубль того же места» правдоподобна,
 * но двигать по догадке адреса нельзя: у скрытого дубля может быть своя
 * история (редирект слитой записи, ссылки из рассылок).
 *
 * Поэтому перепись называет держателя каждого адреса: место (видимо ли,
 * слито ли и во что) или маршрут, и второго претендента, если он есть.
 * Судит тем же `translit_ru_slug`, что 779 и 1111 — своей транслитерации
 * здесь нет, иначе перепись и миграция разошлись бы.
 *
 * Наружу — имена мест и маршрутов, адреса и флаги. Персональных данных в
 * этих таблицах нет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface CensusRow {
  id: string;
  name: string;
  base: string;
  place_holder_id: string | null;
  place_holder_name: string | null;
  place_holder_visible: boolean | null;
  place_holder_merged_into: string | null;
  route_holder_id: string | null;
  route_holder_title: string | null;
  claimants: number;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<CensusRow>(
      `WITH missing AS (
         SELECT p.id::text AS id, p.name, translit_ru_slug(p.name) AS base
           FROM places p
          WHERE p.slug IS NULL
            AND p.is_visible = TRUE
            AND p.merged_into_id IS NULL
            AND p.name IS NOT NULL
       )
       SELECT miss.id, miss.name, miss.base,
              hp.id::text             AS place_holder_id,
              hp.name                 AS place_holder_name,
              hp.is_visible           AS place_holder_visible,
              hp.merged_into_id::text AS place_holder_merged_into,
              hr.id::text             AS route_holder_id,
              hr.title                AS route_holder_title,
              (SELECT count(*)::int FROM missing m2 WHERE m2.base = miss.base) AS claimants
         FROM missing miss
         LEFT JOIN places hp           ON hp.slug = miss.base
         LEFT JOIN kamchatka_routes hr ON hr.slug = miss.base
        ORDER BY miss.name`,
    );

    // Один исход на место — чтобы список читался глазами, а не собирался.
    const holderOf = (r: CensusRow): string => {
      if (r.base === '') return 'empty_base';
      if (r.place_holder_id) {
        if (r.place_holder_merged_into) return 'merged_place';
        return r.place_holder_visible ? 'visible_place' : 'hidden_place';
      }
      if (r.route_holder_id) return 'route';
      if (r.claimants > 1) return 'namesake';
      return 'free';
    };

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      base: r.base,
      holder: holderOf(r),
      place_holder: r.place_holder_id
        ? {
            id: r.place_holder_id,
            name: r.place_holder_name,
            visible: r.place_holder_visible,
            merged_into: r.place_holder_merged_into,
          }
        : null,
      route_holder: r.route_holder_id
        ? { id: r.route_holder_id, title: r.route_holder_title }
        : null,
      claimants: r.claimants,
    }));

    const byHolder: Record<string, number> = {};
    for (const i of items) byHolder[i.holder] = (byHolder[i.holder] ?? 0) + 1;

    return NextResponse.json({
      ok: true,
      collected_at: new Date().toISOString(),
      missing_total: items.length,
      by_holder: byHolder,
      items,
    });
  } catch (err) {
    // Третий исход: не смог посчитать — это не «все адреса на месте».
    const e = err as { code?: string; message?: string };
    console.error('[place-slug-census] перепись не выполнена:', { sqlstate: e?.code, message: e?.message });
    return NextResponse.json({ ok: false, reason: e?.message ?? 'база не ответила' }, { status: 500 });
  }
}
