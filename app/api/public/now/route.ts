/**
 * GET /api/public/now
 *
 * "Сейчас на Камчатке" — погода + сезон + ближайший выезд.
 */

import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { wmoDescriptionRu } from '@/lib/weather/wmo-hazard';

export const dynamic = 'force-dynamic';

/**
 * Чем край занят в этом месяце. Северного сияния здесь нет (29.10): на
 * Камчатке оно видно только в сильную магнитную бурю, редко и в любой
 * месяц — у ноября и декабря его не больше, чем у прочих, и строка «сезон
 * сияния» обещала то, чего календарь не даёт.
 */
const MONTH_SEASONS: Record<number, string> = {
  1: 'Снегоходы, подлёдная рыбалка, ски-туринг',
  2: 'Снегоходы, подлёдная рыбалка',
  3: 'Снегоходы, подлёдная рыбалка, ски-туринг',
  4: 'Ски-туринг, весенние восхождения',
  5: 'Начало треккингового сезона',
  6: 'Вулканы, треккинг, рыбалка на чавычу',
  7: 'Вулканы, медведи, рыбалка, сплавы',
  8: 'Вулканы, медведи, нерка, вертолётные туры',
  9: 'Осенние краски, рыбалка, термальные источники',
  10: 'Термальные источники, поздняя рыбалка',
  11: 'Начало зимнего сезона',
  12: 'Снегоходы, собачьи упряжки',
};

export async function GET() {
  const month = new Date().getMonth() + 1;
  const seasonNote = MONTH_SEASONS[month] ?? '';

  // Погода — Open-Meteo. Описание — общим словарём кодов WMO (29.10): своя
  // лестница «код ≤ 3 — ясно» называла ясным и сплошную облачность (код 3),
  // а туман — «облачно». Незнакомый код — null, а не догадка (§4.0).
  let temperature: number | null = null;
  let weatherDesc: string | null = null;
  try {
    const wRes = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=53.04&longitude=158.65&current_weather=true',
      { signal: AbortSignal.timeout(5000) },
    );
    if (wRes.ok) {
      const wData = await wRes.json() as { current_weather?: { temperature?: number; weathercode?: number } };
      temperature = wData.current_weather?.temperature ?? null;
      weatherDesc = wmoDescriptionRu(wData.current_weather?.weathercode);
    } else {
      logSwallowedFailure('public-now', 'погода', new Error(`Open-Meteo HTTP ${wRes.status}`));
    }
  } catch (err) {
    // Нет погоды — поля null, а причина в логе: «не смог» не равно «ясно».
    logSwallowedFailure('public-now', 'погода', err);
  }

  // Ближайший выезд — из живого календаря tour_availability (свободные места
  // из реальных броней), а не из полу-мёртвой tour_departures, где счётчик
  // занятости никогда не заполнялся. Тур — с витрины (#2642): без
  // is_published публичная плашка звала на выезд черновика.
  let nextDeparture: { date: string; tourName: string; operatorName: string; slots: number } | null = null;
  try {
    const dRes = await pool.query(
      `SELECT ta.date AS departure_date, t.title AS tour_name, p.name AS operator_name,
              GREATEST(0, LEAST(ta.available_slots, COALESCE(t.max_participants, ta.available_slots)) - occ.taken) AS available_slots
       FROM tour_availability ta
       JOIN operator_tours t ON t.id = ta.operator_tour_id AND ${publicTourSql('t')}
       JOIN partners p ON p.id = t.operator_id
       CROSS JOIN LATERAL (
${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
       ) occ
       WHERE ta.date >= CURRENT_DATE
         AND ta.is_cancelled = FALSE
         AND ta.deleted_at IS NULL
         AND GREATEST(0, LEAST(ta.available_slots, COALESCE(t.max_participants, ta.available_slots)) - occ.taken) > 0
       ORDER BY ta.date ASC
       LIMIT 1`,
    );
    if (dRes.rows[0]) {
      const r = dRes.rows[0];
      nextDeparture = {
        date: r.departure_date,
        tourName: r.tour_name,
        operatorName: r.operator_name,
        slots: Number(r.available_slots),
      };
    }
  } catch (err) {
    // Плашка без выезда — не «выездов нет»: отказ базы называется в логе (§4.0).
    logSwallowedFailure('public-now', 'ближайший выезд', err);
  }

  return NextResponse.json({
    success: true,
    data: {
      temperature,
      weatherDesc,
      seasonNote,
      month,
      nextDeparture,
    },
  });
}
