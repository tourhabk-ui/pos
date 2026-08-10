/**
 * GET /api/cron/relief-sanity — сходятся ли трек и название маршрута.
 *
 * Высоты, залитые 09.08, вскрыли невидимое: маршрут «Вулкан Кроноцкий» получил
 * высоты −1..45 м при вершине 3528. Модель рельефа не ошиблась — она честно
 * вернула уровень моря для координат, которые на уровне моря и лежат. Значит
 * трек ведёт не туда, куда обещает название.
 *
 * Человек планирует выход по названию, а идёт по треку. Если они про разные
 * места, он узнает об этом там, где выяснять поздно.
 *
 * Отдельный роут, а не режим замера покрытия. Сначала я приделал это к
 * `relief-coverage` — «тот же вопрос, тот же секрет» — и получил по рукам от
 * гарда: тот роут объявлен счётчиками без имён и координат, и это решение
 * записано в его шапке. Сверка по своей природе обязана называть маршруты
 * поимённо, иначе находкой нельзя воспользоваться. Два разных обещания не
 * живут в одном ответе.
 *
 * Read-only: один SELECT, ничего не пишет. Чинить автоматически нельзя —
 * имена мест на Камчатке путаные, и подгонка геометрии под название сделает
 * ложь достовернее, а не правду вернее.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret } from '@/lib/auth/cron';
import { checkRoutes, summarize, type RouteReliefRow } from '@/lib/routes/relief-sanity';

export const dynamic = 'force-dynamic';

interface SanityRow {
  id: string;
  title: string;
  lat: string | null;
  lng: string | null;
  track_lat: string | null;
  track_lng: string | null;
  max_ele: string | null;
  min_ele: string | null;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<SanityRow>(
      `SELECT id, title, lat, lng,
              (geometry->'coordinates'->0->>1) AS track_lat,
              (geometry->'coordinates'->0->>0) AS track_lng,
              -- Проверка типа обязательна: jsonb_array_length падает на
              -- элементе, который массивом не является, и один битый трек
              -- уронил бы сверку для всех остальных.
              (SELECT max((c->>2)::numeric) FROM jsonb_array_elements(geometry->'coordinates') c
                WHERE jsonb_typeof(c) = 'array' AND jsonb_array_length(c) >= 3) AS max_ele,
              (SELECT min((c->>2)::numeric) FROM jsonb_array_elements(geometry->'coordinates') c
                WHERE jsonb_typeof(c) = 'array' AND jsonb_array_length(c) >= 3) AS min_ele
         FROM kamchatka_routes
        WHERE geometry IS NOT NULL
          AND jsonb_typeof(geometry->'coordinates') = 'array'
          AND jsonb_array_length(geometry->'coordinates') >= 2`,
    );

    const num = (v: string | null) => (v === null ? null : Number(v));
    const parsed: RouteReliefRow[] = rows.map(r => ({
      id: String(r.id),
      title: r.title,
      lat: num(r.lat),
      lng: num(r.lng),
      trackLat: num(r.track_lat),
      trackLng: num(r.track_lng),
      maxElevationM: num(r.max_ele),
      minElevationM: num(r.min_ele),
    }));

    const findings = checkRoutes(parsed);
    return NextResponse.json({
      checked: parsed.length,
      findings,
      verdict: summarize(findings, parsed.length),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
  }
}
