/**
 * lib/agents/sdk/tourist-tools.ts
 *
 * SDK-инструменты для conversational booking.
 * Все SQL-запросы соответствуют реальной схеме БД:
 *   operator_tours: difficulty, location_name, max_participants, min_participants, multi_day_count
 *   operator_bookings: operator_tour_id, participants, final_price, tourist_email (нет user_id)
 *   tour_departures: несовместима с operator_tours (UUID vs BIGINT) — не используем
 */

import type { SDKTool } from './sdk-runner';
import { pool } from '@/lib/db-pool';
import { composeTrip } from '@/lib/planner/compose';
import { createPlannerCache, fetchAvailabilityForTour } from '@/lib/planner';
import { fetchWeatherForecast } from '@/lib/planner/intelligence';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

// Вычисляем длительность в днях из реальных колонок
const DURATION_EXPR = `COALESCE(t.multi_day_count, CEIL(t.duration_hours / 24.0)::int, 1)`;

// ── Search Tours ──────────────────────────────────────────────────

const searchTours: SDKTool = {
  name: 'search_tours',
  description: 'Поиск туров по критериям: тип активности, бюджет, даты, продолжительность. Возвращает список подходящих туров с ценами.',
  parameters: {
    type: 'object',
    properties: {
      activity_type: {
        type: 'string',
        description: 'Тип активности: fishing, trekking, volcano, thermal, bears, helicopter, boat_trip, rafting, snowmobile, photo, cultural',
      },
      max_price: {
        type: 'string',
        description: 'Максимальный бюджет в рублях (число)',
      },
      min_duration: {
        type: 'string',
        description: 'Минимальная продолжительность в днях',
      },
      max_duration: {
        type: 'string',
        description: 'Максимальная продолжительность в днях',
      },
      month: {
        type: 'string',
        description: 'Месяц (1-12) для фильтрации по сезону',
      },
      query: {
        type: 'string',
        description: 'Текстовый поиск по названию и описанию тура',
      },
      limit: {
        type: 'string',
        description: 'Количество результатов (по умолчанию 5)',
      },
    },
  },
  execute: async (args) => {
    const conditions: string[] = ['t.is_published = true', 't.is_active = true'];
    const params: unknown[] = [];
    let idx = 1;

    if (args.activity_type) {
      conditions.push(`t.activity_type = $${idx}`);
      params.push(String(args.activity_type));
      idx++;
    }
    if (args.max_price) {
      conditions.push(`t.base_price <= $${idx}`);
      params.push(Number(args.max_price));
      idx++;
    }
    if (args.min_duration) {
      conditions.push(`${DURATION_EXPR} >= $${idx}`);
      params.push(Number(args.min_duration));
      idx++;
    }
    if (args.max_duration) {
      conditions.push(`${DURATION_EXPR} <= $${idx}`);
      params.push(Number(args.max_duration));
      idx++;
    }
    if (args.month) {
      const m = Number(args.month);
      conditions.push(`(t.season_start IS NULL OR EXTRACT(MONTH FROM t.season_start) <= $${idx})`);
      params.push(m);
      idx++;
      conditions.push(`(t.season_end IS NULL OR EXTRACT(MONTH FROM t.season_end) >= $${idx})`);
      params.push(m);
      idx++;
    }
    if (args.query) {
      conditions.push(`(t.title ILIKE $${idx} OR t.description ILIKE $${idx})`);
      params.push(`%${String(args.query)}%`);
      idx++;
    }

    const limit = Math.min(Number(args.limit) || 5, 10);
    params.push(limit);

    const sql = `
      SELECT t.id, t.title, t.base_price, t.activity_type,
             ${DURATION_EXPR} AS duration_days,
             t.difficulty, t.location_name,
             t.min_participants, t.max_participants,
             t.available_slots, t.next_available_date,
             COALESCE(p.company_name, p.name) AS operator_name,
             -- Рейтинг — денормализованные колонки тура: их пересчитывает
             -- запись отзыва (POST /api/reviews/tour/[tourId]) по видимым
             -- отзывам operator_tour_reviews. Прежний подзапрос к старой
             -- reviews сравнивал uuid с bigint (42883) и ронял ВЕСЬ запрос:
             -- поиск туров у Кузьмича не работал никогда.
             t.rating AS avg_rating,
             t.review_count AS review_count
      FROM operator_tours t
      JOIN partners p ON p.id = t.operator_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.base_price ASC
      LIMIT $${idx}
    `;

    try {
      const result = await pool.query(sql, params);
      if (result.rows.length === 0) {
        return JSON.stringify({ found: 0, message: 'Туров по таким критериям не найдено. Попробуй расширить параметры поиска.' });
      }
      return JSON.stringify({
        found: result.rows.length,
        tours: result.rows.map((r: Record<string, unknown>) => ({
          id: r.id,
          title: r.title,
          price: `${r.base_price} руб.`,
          activity: r.activity_type,
          duration: `${r.duration_days} дн.`,
          difficulty: r.difficulty,
          location: r.location_name,
          group: `${r.min_participants}-${r.max_participants} чел.`,
          // НЕ «свободно»: available_slots — денормализованная вместимость
          // тура, с бронями её никто не сверяет. Занятость даёт только
          // check_availability (расчёт планера). Обещать места отсюда —
          // ровно то, за что находка аудита 08.09 поймала соседний инструмент.
          capacity_hint: r.available_slots ? `вместимость ${r.available_slots}` : 'уточняйте',
          free_places: 'не проверено — спроси check_availability',
          next_date: r.next_available_date ?? 'уточняйте',
          operator: r.operator_name,
          rating: r.avg_rating ? `${r.avg_rating}/5 (${r.review_count} отзывов)` : 'нет отзывов',
        })),
      });
    } catch (err) {
      return JSON.stringify({ error: 'Ошибка поиска туров', detail: String(err) });
    }
  },
};

// ── Get Tour Details ──────────────────────────────────────────────

const getTourDetails: SDKTool = {
  name: 'get_tour_details',
  description: 'Получить полную информацию о туре: описание, включено, не включено, требования, фото.',
  parameters: {
    type: 'object',
    properties: {
      tour_id: { type: 'string', description: 'ID тура' },
    },
    required: ['tour_id'],
  },
  execute: async (args) => {
    try {
      const result = await pool.query(`
        SELECT t.id, t.title, t.description, t.base_price, t.activity_type,
               ${DURATION_EXPR} AS duration_days,
               t.difficulty, t.location_name,
               t.included, t.not_included, t.what_to_bring,
               t.min_participants, t.max_participants,
               t.available_slots, t.next_available_date,
               t.season_start, t.season_end,
               t.tour_image,
               COALESCE(p.company_name, p.name) AS operator_name,
               p.contacts->>'phone' AS operator_phone
        FROM operator_tours t
        JOIN partners p ON p.id = t.operator_id
        WHERE t.id = $1 AND t.is_published = true
      `, [Number(args.tour_id)]);

      if (result.rows.length === 0) {
        return JSON.stringify({ error: 'Тур не найден или снят с публикации' });
      }
      const t = result.rows[0] as Record<string, unknown>;
      return JSON.stringify({
        id: t.id,
        title: t.title,
        description: t.description,
        price: `${t.base_price} руб.`,
        duration: `${t.duration_days} дн.`,
        difficulty: t.difficulty,
        location: t.location_name,
        included: t.included,
        not_included: t.not_included,
        what_to_bring: t.what_to_bring,
        group: `${t.min_participants}-${t.max_participants} чел.`,
        capacity_hint: t.available_slots ? `вместимость ${t.available_slots}` : 'уточните у оператора',
        free_places: 'не проверено — спроси check_availability',
        next_date: t.next_available_date ?? 'уточните у оператора',
        season: t.season_start ? `${t.season_start} — ${t.season_end}` : 'круглый год',
        operator: t.operator_name,
        operator_phone: t.operator_phone,
        image: t.tour_image,
        booking_url: `/routes/${t.id}`,
      });
    } catch {
      return JSON.stringify({ error: 'Ошибка загрузки тура' });
    }
  },
};

// ── Check Availability ────────────────────────────────────────────
// Использует operator_tours напрямую — tour_departures несовместима (UUID vs BIGINT).

const checkAvailability: SDKTool = {
  name: 'check_availability',
  description: 'Проверить доступность тура: свободные места, ближайшая дата, сезон.',
  parameters: {
    type: 'object',
    properties: {
      tour_id: { type: 'string', description: 'ID тура' },
    },
    required: ['tour_id'],
  },
  execute: async (args) => {
    try {
      const result = await pool.query(`
        SELECT t.id, t.title, t.season_start, t.season_end, t.base_price
        FROM operator_tours t
        WHERE t.id = $1 AND t.is_published = true
      `, [Number(args.tour_id)]);

      if (result.rows.length === 0) {
        return JSON.stringify({ available: false, message: 'Тур не найден.' });
      }

      const t = result.rows[0] as Record<string, unknown>;

      // Занятость — ТОЛЬКО общим расчётом планера: тот же, что у гейта брони,
      // share-API плана и инструмента Кузьмича. Своя арифметика здесь и
      // стояла (находка аудита 08.09), и врала в обе стороны сразу.
      const today = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.parse(today) + 29 * 86400000).toISOString().slice(0, 10);
      const slots = await fetchAvailabilityForTour(String(t.id), today, to, createPlannerCache());

      const seasonEnd = t.season_end ? new Date(t.season_end as string) : null;
      const inSeason = !seasonEnd || seasonEnd >= new Date();

      if (slots.length === 0) {
        return JSON.stringify({
          available: false,
          tour_id: t.id,
          title: t.title,
          price: `${t.base_price} руб.`,
          in_season: inSeason,
          window: `${today} — ${to}`,
          message: 'В ближайшие 30 дней свободных дат нет. Это реальная занятость по броням — не обещай места на эти даты.',
        });
      }

      const nearest = slots[0];
      return JSON.stringify({
        available: inSeason,
        tour_id: t.id,
        title: t.title,
        price: `${t.base_price} руб.`,
        in_season: inSeason,
        window: `${today} — ${to}`,
        next_date: nearest.date,
        slots_free_on_next_date: nearest.remaining,
        dates: slots.slice(0, 10).map((sl) => ({ date: sl.date, free: sl.remaining })),
        message: `Ближайшая свободная дата ${nearest.date}: мест ${nearest.remaining}. `
          + 'Число относится к КОНКРЕТНОЙ дате, а не к туру вообще.',
      });
    } catch (err) {
      logSwallowedFailure('tourist-tools', `доступность тура ${String(args.tour_id)}`, err);
      return JSON.stringify({
        available: null,
        status: 'не_смог',
        message: 'Проверить занятость не удалось. Не говори «места есть» и не говори «мест нет» — скажи, что проверить не смог.',
      });
    }
  },
};

// ── Compare Tours ─────────────────────────────────────────────────

const compareTours: SDKTool = {
  name: 'compare_tours',
  description: 'Сравнить 2-3 тура по цене, продолжительности, сложности, рейтингу.',
  parameters: {
    type: 'object',
    properties: {
      tour_ids: { type: 'string', description: 'ID туров через запятую (например "12,34,56")' },
    },
    required: ['tour_ids'],
  },
  execute: async (args) => {
    const ids = String(args.tour_ids).split(',').map(s => Number(s.trim())).filter(n => n > 0).slice(0, 3);
    if (ids.length < 2) return JSON.stringify({ error: 'Нужно минимум 2 ID тура для сравнения' });

    try {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const result = await pool.query(`
        SELECT t.id, t.title, t.base_price,
               ${DURATION_EXPR} AS duration_days,
               t.difficulty, t.activity_type, t.location_name,
               t.included, t.available_slots,
               COALESCE(p.company_name, p.name) AS operator_name,
               -- Та же замена, что в search_tours выше: подзапрос к старой
               -- reviews (uuid против bigint, 42883) ронял всё сравнение.
               t.rating AS avg_rating,
               t.review_count AS review_count
        FROM operator_tours t
        JOIN partners p ON p.id = t.operator_id
        WHERE t.id IN (${placeholders}) AND t.is_published = true
      `, ids);

      return JSON.stringify({
        comparison: result.rows.map((t: Record<string, unknown>) => ({
          id: t.id,
          title: t.title,
          price: `${t.base_price} руб.`,
          duration: `${t.duration_days} дн.`,
          difficulty: t.difficulty,
          activity: t.activity_type,
          location: t.location_name,
          operator: t.operator_name,
          capacity_hint: t.available_slots ?? 'уточните',
          free_places: 'не проверено — спроси check_availability',
          rating: t.avg_rating ? `${t.avg_rating}/5 (${t.review_count})` : 'нет отзывов',
          included: t.included,
        })),
      });
    } catch (err) {
      logSwallowedFailure('tourist-tools', 'сравнение туров', err);
      return JSON.stringify({ error: 'Ошибка сравнения' });
    }
  },
};

// ── Get Weather ───────────────────────────────────────────────────

/**
 * Координаты живой точки по её имени. Ровно тот предикат живости, что у
 * переписей: скрытые и слитые записи не считаются местом.
 */
async function resolvePlaceCoords(
  name: string,
): Promise<{ name: string; lat: number; lng: number } | null> {
  const { rows } = await pool.query<{ name: string; lat: number; lng: number }>(
    `SELECT name, lat::float AS lat, lng::float AS lng
       FROM places
      WHERE name ILIKE $1
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND is_visible = true AND merged_into_id IS NULL
      ORDER BY length(name) ASC
      LIMIT 1`,
    [`%${name}%`],
  );
  return rows[0] ?? null;
}

/**
 * Погода МЕСТА, а не города по умолчанию.
 *
 * Находка аудита 08.09: инструмент объявлял аргумент `location` (и звал в
 * пример «Мутновский»), а `execute` не принимал аргументов вовсе и читал
 * `weather_cache` с жёстким `location = 'petropavlovsk'`. Турист спрашивал
 * про перевал, получал город — и ниоткуда не мог этого узнать: имени места
 * в ответе не было. Между Петропавловском и Мутновским тридцать километров
 * по прямой и километр по высоте; погода там не одна и та же, а решение
 * «идти сегодня» человек принимает по ней.
 *
 * Хуже того, `weather_cache` не заводится ни одной миграцией и не пишется ни
 * одной строкой кода — читать было нечего в принципе. Источник прогноза на
 * платформе один (Open-Meteo через `lib/planner/intelligence`), и второго
 * тут не заводится (§12).
 *
 * Третий исход назван вслух: «не смог» — не «погода хорошая».
 */
const getWeather: SDKTool = {
  name: 'get_weather',
  description: 'Прогноз погоды на ближайшие дни для места на Камчатке. Без указания места — Петропавловск-Камчатский.',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'Место (например "Петропавловск-Камчатский", "Мутновский")' },
    },
  },
  execute: async (args) => {
    const asked = typeof args.location === 'string' ? args.location.trim() : '';
    try {
      let place = { name: 'Петропавловск-Камчатский', lat: 53.02, lng: 158.65 };
      if (asked) {
        const found = await resolvePlaceCoords(asked);
        if (!found) {
          return JSON.stringify({
            location_requested: asked,
            status: 'место_не_найдено',
            message: `Места «${asked}» нет в справочнике платформы — прогноз именно для него дать не могу. Погоду по другому месту не выдавай за его погоду.`,
          });
        }
        place = found;
      }

      const forecast = await fetchWeatherForecast(place.lat, place.lng, 3);
      if (forecast.length === 0) {
        return JSON.stringify({
          location: place.name,
          status: 'не_смог',
          message: 'Прогноз получить не удалось. Не называй погоду по памяти — скажи, что проверить не смог.',
        });
      }

      return JSON.stringify({
        location: place.name,
        coords: [place.lat, place.lng],
        status: 'ок',
        days: forecast.map((d) => ({
          date: d.date,
          temp_max: d.tempMax,
          temp_min: d.tempMin,
          precip_mm: d.precipMm,
          wind_kmh: d.windKmh,
          description: d.description,
        })),
      });
    } catch (err) {
      logSwallowedFailure('tourist-tools', `прогноз погоды (${asked || 'по умолчанию'})`, err);
      return JSON.stringify({
        location_requested: asked || 'Петропавловск-Камчатский',
        status: 'не_смог',
        message: 'Прогноз получить не удалось. Не называй погоду по памяти — скажи, что проверить не смог.',
      });
    }
  },
};

// ── Get User Past Trips ───────────────────────────────────────────

function makeGetUserTrips(userId: string | null): SDKTool {
  return {
    name: 'get_user_trips',
    description: 'Получить историю поездок пользователя для персональных рекомендаций.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      if (!userId) return JSON.stringify({ trips: [], message: 'Пользователь не авторизован' });
      try {
        // operator_bookings не имеет user_id — джойним через users.id
        const result = await pool.query(`
          SELECT ob.id, ot.title, ot.activity_type, ot.location_name,
                 ob.booking_date, ob.participants, ob.final_price,
                 ob.booking_status
          FROM operator_bookings ob
          JOIN operator_tours ot ON ot.id = ob.operator_tour_id
          JOIN users u ON u.id = $1 AND u.email = ob.tourist_email
          ORDER BY ob.booking_date DESC NULLS LAST
          LIMIT 10
        `, [userId]);
        return JSON.stringify({
          trips: result.rows.map((r: Record<string, unknown>) => ({
            tour: r.title,
            activity: r.activity_type,
            location: r.location_name,
            date: r.booking_date,
            guests: r.participants,
            price: r.final_price,
            status: r.booking_status,
          })),
        });
      } catch {
        return JSON.stringify({ trips: [], error: 'Ошибка загрузки истории' });
      }
    },
  };
}

// ── Get Gear Recommendations ──────────────────────────────────────

const getGearRecommendations: SDKTool = {
  name: 'get_gear_recommendations',
  description: 'Рекомендации по снаряжению для конкретного типа тура и сезона.',
  parameters: {
    type: 'object',
    properties: {
      activity_type: { type: 'string', description: 'Тип активности: trekking, fishing, volcano и т.д.' },
      month: { type: 'string', description: 'Месяц поездки (1-12)' },
    },
    required: ['activity_type'],
  },
  execute: async (args) => {
    const activity = String(args.activity_type);
    const month = Number(args.month) || new Date().getMonth() + 1;

    const gear: Record<string, string[]> = {
      trekking:   ['Треккинговые ботинки', 'Рюкзак 40-60л', 'Дождевик', 'Термобельё', 'Солнцезащитный крем', 'Палки треккинговые'],
      fishing:    ['Забродники/вейдерсы', 'Удочка спиннинг', 'Непромокаемая куртка', 'Поляризационные очки', 'Термос'],
      volcano:    ['Треккинговые ботинки с жёсткой подошвой', 'Каска', 'Ветровка', 'Бафф/маска от газов', 'Перчатки', 'Рюкзак 30л'],
      thermal:    ['Купальник', 'Полотенце', 'Сланцы', 'Тёплая одежда для дороги'],
      bears:      ['Бинокль', 'Фотоаппарат с телеобъективом', 'Непромокаемая обувь', 'Дождевик'],
      helicopter: ['Тёплая куртка', 'Солнечные очки', 'Беруши', 'Батончики/перекус'],
      boat_trip:  ['Непромокаемая куртка', 'Перчатки', 'Шапка', 'Средство от укачивания', 'Фотоаппарат в гермопакете'],
      rafting:    ['Гидрокостюм (предоставляется)', 'Сменная одежда', 'Герметичный телефонный чехол'],
      snowmobile: ['Тёплый комбинезон', 'Шлем (предоставляется)', 'Балаклава', 'Тёплые перчатки', 'Защитные очки'],
    };

    const seasonNote = month >= 6 && month <= 8
      ? 'Лето: 10-20°C, возможны дожди.'
      : month >= 9 && month <= 11
        ? 'Осень: 0-10°C, ранний снег в горах. Нужна утеплённая экипировка.'
        : month >= 3 && month <= 5
          ? 'Весна: 0-8°C, снег в горах. Зимняя экипировка для гор.'
          : 'Зима: -10...-25°C. Максимальное утепление.';

    const items = gear[activity] ?? ['Удобная обувь', 'Дождевик', 'Тёплая одежда', 'Солнцезащитный крем'];

    return JSON.stringify({
      activity,
      season: seasonNote,
      essential: items,
      always: ['Паспорт', 'Медицинская страховка', 'Заряженный телефон', 'Наличные деньги', 'Вода 1-2 литра'],
    });
  },
};

// ── Compose Multi-Tour Trip ───────────────────────────────────────

const composeTripTool: SDKTool = {
  name: 'compose_trip',
  description:
    'Составить комплексный маршрут из нескольких туров под параметры туриста: ' +
    'количество дней поездки, общий бюджет, интересы, месяц, размер группы. ' +
    'Возвращает готовый итинерарий день за днём с ценами и ссылками на туры. ' +
    'Используй, когда турист говорит о поездке на несколько дней или хочет объединить несколько активностей.',
  parameters: {
    type: 'object',
    properties: {
      total_days: {
        type: 'string',
        description: 'Общее количество дней поездки (например "10")',
      },
      budget_total: {
        type: 'string',
        description: 'Общий бюджет на всю группу в рублях (например "300000")',
      },
      interests: {
        type: 'string',
        description: 'Интересующие активности через запятую: fishing, trekking, volcano, thermal, bears, helicopter, boat_trip, rafting, snowmobile',
      },
      month: {
        type: 'string',
        description: 'Месяц поездки (1-12)',
      },
      group_size: {
        type: 'string',
        description: 'Количество человек в группе (по умолчанию 2)',
      },
      difficulty: {
        type: 'string',
        description: 'Сложность: easy, medium, hard (необязательно)',
      },
    },
    required: ['total_days', 'budget_total', 'interests', 'month'],
  },
  execute: async (args) => {
    const totalDays  = Math.min(Math.max(Number(args.total_days)  || 7, 2), 30);
    const budget     = Math.max(Number(args.budget_total) || 100_000, 10_000);
    const groupSize  = Math.min(Math.max(Number(args.group_size)  || 2, 1), 20);
    const month      = Math.min(Math.max(Number(args.month)       || new Date().getMonth() + 1, 1), 12);
    const interests  = String(args.interests || 'trekking,thermal')
      .split(',').map(s => s.trim()).filter(Boolean);
    const difficulty = ['easy', 'medium', 'hard'].includes(String(args.difficulty))
      ? (args.difficulty as 'easy' | 'medium' | 'hard')
      : undefined;

    try {
      const trip = await composeTrip({ total_days: totalDays, budget_total: budget, interests, month, group_size: groupSize, difficulty });

      if (!trip) {
        return JSON.stringify({
          success: false,
          message: 'Не удалось подобрать маршрут по заданным критериям. Попробуй увеличить бюджет, количество дней или изменить интересы.',
        });
      }

      return JSON.stringify({
        success: true,
        summary: trip.summary,
        total_days: trip.total_days,
        tour_days: trip.tour_days,
        free_days: trip.free_days,
        total_price: trip.total_price,
        price_per_person: trip.price_per_person,
        group_size: trip.group_size,
        tours: trip.tours.map(t => ({
          id: t.id,
          title: t.title,
          activity: t.activity_type,
          duration: `${t.duration_days} дн.`,
          price_per_person: `${t.base_price.toLocaleString('ru-RU')} руб.`,
          operator: t.operator_name,
          location: t.location,
          booking_url: `vedarai.ru${t.booking_url}`,
        })),
        itinerary: trip.itinerary.map(d => ({
          day: d.day,
          type: d.type,
          note: d.note,
          ...(d.tour ? { tour_id: d.tour.id, tour_title: d.tour.title } : {}),
        })),
      });
    } catch {
      return JSON.stringify({ success: false, message: 'Ошибка составления маршрута' });
    }
  },
};

// ── Export full toolkit ───────────────────────────────────────────

export function getTouristTools(userId: string | null): SDKTool[] {
  return [
    composeTripTool,
    searchTours,
    getTourDetails,
    checkAvailability,
    compareTours,
    getWeather,
    makeGetUserTrips(userId),
    getGearRecommendations,
  ];
}
