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
import { fetchForecastDays, forecastCurrent } from '@/lib/planner/intelligence';
import { DEFAULT_WEATHER_PLACE } from '@/lib/kuzmich/weather-tool';
import { WEATHER_PAGE_DAYS } from '@/lib/weather/weather-page';

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

  // Погода — общий прогноз платформы (#2289, 29.10): та же точка и тот же
  // горизонт, что у /weather и виджета главной, значит та же запись кэша, и
  // своего запроса к Open-Meteo роут больше не делает (адрес исходящий общий,
  // его суточный лимит уже кончался). «Сейчас» — блок current, а чего в нём
  // нет — час прогноза (forecastCurrent). Описание — общим словарём кодов WMO
  // (29.10): своя лестница «код ≤ 3 — ясно» называла ясным и сплошную
  // облачность (код 3), а туман — «облачно». Незнакомый код — null (§4.0).
  let temperature: number | null = null;
  let weatherDesc: string | null = null;
  let weatherStaleSince: string | null = null;
  try {
    const f = await fetchForecastDays(DEFAULT_WEATHER_PLACE.lat, DEFAULT_WEATHER_PLACE.lng, WEATHER_PAGE_DAYS);
    if (f.ok) {
      const { now, hour } = forecastCurrent(f);
      temperature = now?.temp ?? hour?.temp ?? null;
      weatherDesc = wmoDescriptionRu(now?.weatherCode ?? hour?.weatherCode ?? null);
      // Источник не ответил, отдан последний удачный прогноз — это видно.
      weatherStaleSince = f.staleSince ?? null;
    } else {
      logSwallowedFailure('public-now', 'погода', new Error(f.reason));
    }
  } catch (err) {
    // Нет погоды — поля null, а причина в логе: «не смог» не равно «ясно».
    logSwallowedFailure('public-now', 'погода', err);
  }

  // Ближайший выезд — из живого календаря tour_availability (свободные места
  // из реальных броней), а не из полу-мёртвой tour_departures, где счётчик
  // занятости никогда не заполнялся. Тур — с витрины (#2642): без
  // is_published публичная плашка звала на выезд черновика. В одну дату —
  // меньший id: без дожима тур выбирался порядком строк, то есть случайно.
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
       ORDER BY ta.date ASC, t.id ASC
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
      weatherStaleSince,
      seasonNote,
      month,
      nextDeparture,
    },
  });
}
