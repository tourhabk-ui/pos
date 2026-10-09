/**
 * ПЛАНЕР · Trip Composer — комплексный маршрут из нескольких туров.
 *
 * Часть движка «Планер» (`lib/planner`). Консолидация июль 2026: перемещено из
 * `lib/kuzmich/trip-composer.ts`. Кузьмич зовёт этот композер через
 * `lib/agents/sdk/tourist-tools` — своей логики подбора у Кузьмича нет.
 *
 * Подбирает маршрут под параметры туриста: дни, бюджет, интересы, месяц, группа.
 *
 * Логика:
 * 1. Ищет туры по интересам и фильтрам
 * 2. Жадно компонует непересекающиеся туры (pack by day-count)
 * 3. Добавляет свободные дни между турами для переездов
 * 4. Возвращает готовый итинерарий с ценами и ссылками
 */

import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';
import { tourPath } from '@/lib/tours/tour-url';
import { tourDurationDays } from '@/lib/bookings/duration';
import { tourGroupCost } from '@/lib/planner/estimate';
import { planTourPrice } from '@/lib/planner/tour-price';
import { priceFromUnit } from '@/lib/tours/price-label';



export interface TripTour {
  id: number;
  title: string;
  activity_type: string | null;
  duration_days: number;
  /** Цена оператора за единицу (`price_unit`), как в каталоге. */
  base_price: number;
  price_unit: string | null;
  /**
   * Сколько тур стоит ЭТОЙ группе — правилом брони (ступени группы,
   * единица цены, дни тура; lib/planner/estimate · tourGroupCost).
   */
  group_cost: number;
  operator_name: string;
  location: string | null;
  difficulty_level: string | null;
  tour_image: string | null;
  booking_url: string;
  reasoning?: string; // почему именно этот тур рекомендуется данному туристу
}

export interface TripDay {
  day: number;
  type: 'tour' | 'travel' | 'free';
  tour?: TripTour;
  note: string;
}

export interface ComposedTrip {
  total_days: number;
  tour_days: number;
  free_days: number;
  /** Сумма туров на группу — правилом брони, а не «цена × люди». */
  total_price: number;
  price_per_person: number;
  group_size: number;
  tours: TripTour[];
  itinerary: TripDay[];
  summary: string;
  /** Туры, которым цену для этой группы называет оператор: в подбор не вошли. */
  unpriced: string[];
}

interface TourRow {
  id: number;
  slug: string | null;
  title: string;
  activity_type: string | null;
  base_price: number;
  price_unit: string | null;
  max_participants: number | null;
  multi_day_count: number | null;
  duration_hours: string | number | null;
  operator_name: string;
  location: string | null;
  difficulty: string | null;
  tour_image: string | null;
}

// Сезонная доступность активностей
const SEASONAL_ACTIVITIES: Record<string, number[]> = {
  helicopter: [6, 7, 8, 9],
  skiing:     [1, 2, 3, 4],
  snowmobile: [1, 2, 3, 4, 12],
  bears:      [7, 8, 9],
  fishing:    [5, 6, 7, 8, 9, 10],
  trekking:   [5, 6, 7, 8, 9, 10],
  volcano:    [5, 6, 7, 8, 9, 10],
  thermal:    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  boat_trip:  [6, 7, 8, 9],
  rafting:    [6, 7, 8, 9],
};

function isInSeason(activityType: string | null, month: number): boolean {
  if (!activityType) return true;
  const months = SEASONAL_ACTIVITIES[activityType];
  if (!months) return true;
  return months.includes(month);
}

// Переводы активностей для итинерария
const ACTIVITY_LABELS: Record<string, string> = {
  fishing:    'Рыбалка',
  trekking:   'Треккинг',
  volcano:    'Вулканы',
  thermal:    'Горячие источники',
  bears:      'Медведи',
  helicopter: 'Вертолётный тур',
  boat_trip:  'Морской тур',
  rafting:    'Рафтинг',
  snowmobile: 'Снегоходы',
  skiing:     'Лыжи',
  photo:      'Фototур',
  cultural:   'Культурный тур',
};

export interface ComposeTripParams {
  total_days: number;
  budget_total: number;
  interests: string[];   // activity_type values
  month: number;         // 1-12
  group_size: number;
  difficulty?: 'easy' | 'medium' | 'hard';
}

export async function composeTrip(params: ComposeTripParams): Promise<ComposedTrip | null> {
  const { total_days, budget_total, interests, month, group_size, difficulty } = params;

  // Строим фильтр по интересам (с сезоном)
  const seasonalInterests = interests.filter(i => isInSeason(i, month));
  if (seasonalInterests.length === 0) {
    // Fallback — бери что есть в сезоне
    seasonalInterests.push('trekking', 'thermal');
  }

  const placeholders = seasonalInterests.map((_, i) => `$${i + 1}`).join(',');
  const extraParams: unknown[] = [...seasonalInterests];

  let difficultyClause = '';
  if (difficulty) {
    extraParams.push(difficulty);
    difficultyClause = `AND t.difficulty = $${extraParams.length}`;
  }

  // Цена и длительность — правилом брони, а не в SQL. До 09.10 запрос
  // отсекал туры условием «base_price <= бюджет на человека», а итог считал
  // как base_price × группа: тур «за группу» за 196 000 ₽ стоил группе из
  // четырёх 784 000 ₽ и выпадал из бюджета, тур «за день» стоил как
  // однодневный, а ступени цены по размеру группы не учитывались вовсе
  // (#2304, шаг 1в). Туров на витрине десятки — отбор делается здесь.
  const sql = `
    SELECT t.id, t.slug, t.title, t.activity_type,
           t.base_price, t.price_unit, t.max_participants,
           t.multi_day_count, t.duration_hours,
           COALESCE(p.company_name, p.name) AS operator_name,
           t.location_name AS location, t.difficulty, t.tour_image
    FROM operator_tours t
    JOIN partners p ON p.id = t.operator_id
    WHERE t.is_published = true
      AND t.is_active = true
      AND t.activity_type IN (${placeholders})
      ${difficultyClause}
    ORDER BY t.activity_type, t.base_price ASC
    LIMIT 100
  `;

  let rows: TourRow[];
  try {
    const result = await pool.query<TourRow>(sql, extraParams);
    rows = result.rows;
  } catch (err) {
    // «Не смог подобрать» — не «туров нет»: вызывающий скажет, что сбой (§4.0).
    const e = err as { code?: string; message?: string };
    console.error('[compose] туры не прочитаны', { sqlstate: e?.code ?? null, message: e?.message ?? null });
    return null;
  }

  if (rows.length === 0) return null;

  // Цена каждого тура для ЭТОЙ группы — той же функцией, что у брони
  // (ступени группы; даты нет — правил на дату тоже нет), сумма на группу —
  // той же, что у сметы плана. Цены для группы нет — тур в подбор не идёт и
  // называется: бюджет по неизвестной сумме не проверить.
  const unpriced: string[] = [];
  const priced: Array<{ row: TourRow; days: number; cost: number }> = [];
  for (const row of rows) {
    const durationHours = row.duration_hours === null ? null : Number(row.duration_hours);
    const days = tourDurationDays({ multi_day_count: row.multi_day_count, duration_hours: durationHours });
    if (days > total_days) continue;
    const price = await planTourPrice({
      tourId: String(row.id), basePrice: Number(row.base_price), priceUnit: row.price_unit ?? 'per_person',
      participants: group_size, multiDayCount: row.multi_day_count, durationHours, tourDate: null,
    });
    const cost = price.kind === 'priced'
      ? tourGroupCost({
        unitPrice: price.unitPrice, priceUnit: row.price_unit ?? 'per_person', people: group_size,
        maxParticipants: row.max_participants ?? 0, tourDays: days,
      })
      : null;
    if (!cost) { unpriced.push(row.title); continue; }
    priced.push({ row, days, cost: cost.total });
  }
  // Дешевле для группы — раньше: так жадный отбор кладёт больше туров в бюджет.
  priced.sort((a, b) => a.cost - b.cost);

  // Жадная компоновка: выбираем по одному туру каждого типа активности,
  // не превышая total_days и budget_total
  const usedActivities = new Set<string>();
  const selected: TripTour[] = [];
  let usedDays = 0;
  let usedBudget = 0;

  for (const { row, days: tourDays, cost } of priced) {
    const activity = row.activity_type ?? 'other';
    if (usedActivities.has(activity)) continue;

    const totalNeeded = usedDays + tourDays + (selected.length > 0 ? 1 : 0); // +1 день переезда
    if (totalNeeded > total_days) continue;
    if (usedBudget + cost > budget_total * 1.1) continue; // 10% запас

    selected.push({
      id: row.id,
      title: row.title,
      activity_type: activity,
      duration_days: tourDays,
      base_price: Number(row.base_price),
      price_unit: row.price_unit,
      group_cost: cost,
      operator_name: row.operator_name,
      location: row.location,
      difficulty_level: row.difficulty,
      tour_image: row.tour_image,
      // Тур из operator_tours: адрес /catalog/tours/{адрес}. /routes/{id}
      // ищет маршрут и на числовой id тура отвечал 404 (сверка SEO 29.09).
      booking_url: tourPath(row),
    });
    usedActivities.add(activity);
    usedDays += tourDays + (selected.length > 1 ? 1 : 0);
    usedBudget += cost;
  }

  if (selected.length === 0) return null;

  // Строим итинерарий день за днём
  const itinerary: TripDay[] = [];
  let currentDay = 1;

  for (let i = 0; i < selected.length; i++) {
    const tour = selected[i];

    // День переезда между турами
    if (i > 0) {
      itinerary.push({
        day: currentDay,
        type: 'travel',
        note: `Переезд и подготовка к следующему туру (${ACTIVITY_LABELS[tour.activity_type ?? ''] ?? tour.activity_type}).`,
      });
      currentDay++;
    }

    // Дни тура
    for (let d = 0; d < tour.duration_days; d++) {
      itinerary.push({
        day: currentDay,
        type: 'tour',
        tour,
        note: d === 0
          ? `Начало тура: ${tour.title}. Место: ${tour.location ?? 'Камчатка'}. Оператор: ${tour.operator_name}.`
          : d === tour.duration_days - 1
            ? `Завершение тура "${tour.title}". Возвращение.`
            : `Тур "${tour.title}" — день ${d + 1}.`,
      });
      currentDay++;
    }
  }

  // Свободные дни в конце
  const freeDays = total_days - (currentDay - 1);
  for (let d = 0; d < freeDays; d++) {
    itinerary.push({
      day: currentDay + d,
      type: 'free',
      note: 'Свободное время: горячие источники, рынок, рестораны Петропавловска-Камчатского.',
    });
  }

  const tourDaysTotal = selected.reduce((s, t) => s + t.duration_days, 0);
  const travelDaysTotal = selected.length > 1 ? selected.length - 1 : 0;
  const freeDaysTotal = total_days - tourDaysTotal - travelDaysTotal;
  const totalPrice = selected.reduce((s, t) => s + t.group_cost, 0);

  // Погодного «Плана Б» здесь нет, и это решение, а не недосмотр (25.09).
  // До этого дня функция без вызова в ответе брала прогноз от СЕГОДНЯ для
  // поездки, у которой известен только месяц, раскладывала его по номеру дня,
  // шла в базу после того, как ответ уже ушёл, и писала `planB` в дни,
  // которые никто не читал: инструмент compose_trip это поле не отдаёт.
  // Погода к дням плана — в lib/planner/engine.ts, по дате приезда.

  const activityLabels = selected.map(t => ACTIVITY_LABELS[t.activity_type ?? ''] ?? t.activity_type).join(', ');
  const summary =
    `Маршрут на ${total_days} дней для группы ${group_size} чел. ` +
    `Включает: ${activityLabels}. ` +
    `Итого на группу: ${totalPrice.toLocaleString('ru-RU')} руб. (${Math.round(totalPrice / group_size).toLocaleString('ru-RU')} руб/чел, `
    + 'если делить поровну; туры по своей единице цены). ' +
    `Свободных дней: ${freeDaysTotal}.` +
    (unpriced.length > 0 ? ` Без цены для группы из ${group_size} чел. (цену называет оператор): ${unpriced.slice(0, 3).map((t) => `«${t}»`).join(', ')}.` : '');

  // AI-объяснение для каждого тура: почему именно этот тур подходит туристу
  void generateTourReasoning(selected, { interests, month, group_size, budget_total, difficulty });

  return {
    total_days,
    tour_days: tourDaysTotal,
    free_days: freeDaysTotal,
    total_price: totalPrice,
    price_per_person: Math.round(totalPrice / group_size),
    group_size,
    tours: selected,
    itinerary,
    summary,
    unpriced,
  };
}

const MONTH_NAMES = ['','январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

/**
 * Fire-and-forget AI reasoning для каждого тура в маршруте.
 * Объясняет туристу почему именно этот тур ему подходит.
 */
async function generateTourReasoning(
  tours: TripTour[],
  params: { interests: string[]; month: number; group_size: number; budget_total: number; difficulty?: string },
): Promise<void> {
  if (tours.length === 0) return;

  const context = [
    `Турист едет на ${params.month ? MONTH_NAMES[params.month] ?? 'месяц' : 'Камчатку'}.`,
    `Интересы: ${params.interests.join(', ') || 'разнообразный отдых'}.`,
    `Группа: ${params.group_size} чел.`,
    `Бюджет на всё: ${params.budget_total.toLocaleString('ru-RU')} руб.`,
    params.difficulty ? `Уровень сложности: ${params.difficulty}.` : '',
  ].filter(Boolean).join(' ');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты — эксперт по туризму на Камчатке. Для каждого предложенного тура напиши 1-2 предложения на русском: ПОЧЕМУ именно этот тур подходит данному туристу, учитывая его интересы, бюджет, сезон и группу. Будь конкретным: упомяни уникальную деталь тура, совпадение с интересами, выгоду по цене или сезону. Не используй markdown и emoji.`,
    },
    {
      role: 'user',
      content: `Контекст туриста: ${context}

Туры:
${tours.map((t, i) => `${i + 1}. "${t.title}" — ${t.activity_type}, ${t.duration_days} дн., ${priceFromUnit(t.base_price, t.price_unit) ?? 'цена не указана'} (на эту группу ${t.group_cost.toLocaleString('ru-RU')} руб.), ${t.location ?? 'Камчатка'}, сложность: ${t.difficulty_level ?? '?'}, оператор: ${t.operator_name}`).join('\n')}

Для каждого тура напиши короткое объяснение (1-2 предложения) почему он подходит. Формат ответа:
1: <объяснение>
2: <объяснение>
...`,
    },
  ];

  try {
    const result = await callAIFast(messages);
    if (!result) return;

    // Парсим ответ вида "1: объяснение\n2: объяснение"
    const lines = result.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const match = line.match(/^(\d+)\s*[:.)]\s*(.+)$/);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        const reasoning = match[2].trim();
        if (idx >= 0 && idx < tours.length && reasoning.length > 10) {
          tours[idx].reasoning = reasoning;
        }
      }
    }
  } catch {
    // AI недоступен — туры без reasoning, это не критично
  }
}

