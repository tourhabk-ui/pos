/**
 * API Endpoint: Планирование поездки на Камчатку
 *
 * Функциональность:
 * - Анализ запроса пользователя (AI)
 * - Подбор туров из БД
 * - Подбор размещения из БД
 * - Подбор трансферов из БД
 * - Генерация детального маршрута с логистикой
 * - Расчет общей стоимости
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { config } from '@/lib/config';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 секунд для сложных запросов

const tripPlanLimiter = createRateLimiter({ windowMs: 60_000, max: 5 }); // 5/мин — тяжёлый AI запрос

// Типы
interface UserIntent {
  interests: string[];
  difficulty: string;
  traveler_type: string;
  priorities: string[];
  must_see: string[];
  avoid: string[];
}

interface TripRequest {
  query: string; // Запрос пользователя
  days: number; // Количество дней
  budget?: number; // Бюджет (опционально)
  interests?: string[]; // Интересы: ['hiking', 'wildlife', 'culture', 'adventure', 'relaxation']
  groupSize?: number; // Размер группы
  startDate?: string; // Дата начала (YYYY-MM-DD)
}

const TripPlanSchema = z.object({
  query: z.string().min(5, 'Опишите вашу поездку минимум 5 символами'),
  days: z.number().int('Количество дней должно быть целым числом').min(1, 'Минимум 1 день').max(30, 'Максимум 30 дней'),
  budget: z.number().min(0, 'Бюджет не может быть отрицательным').optional(),
  interests: z.array(z.string()).optional(),
  groupSize: z.number().int('Размер группы должен быть целым числом').min(1, 'Минимум 1 человек').max(100, 'Максимум 100 человек').optional(),
  startDate: z.string().datetime().optional(),
});

interface TourCard {
  id: string;
  name: string;
  description: string;
  duration: number; // часы
  price: number;
  difficulty: string;
  operator_id: string;
  rating: number;
  coordinates: [number, number][];
}

interface AccommodationCard {
  id: string;
  name: string;
  type: string;
  address: string;
  price_per_night: number;
  rating: number;
  amenities: string[];
  coordinates: { lat: number; lng: number };
}

interface TransferCard {
  id: string;
  route_name: string;
  from_location: string;
  to_location: string;
  /**
   * Расстояние, длительность и цена места — `null`, когда их НЕТ в данных.
   *
   * Прежний код подставлял `0` и `60` по умолчанию, и эти числа уходили прямо
   * в промпт планировщика: «(60мин, 0₽)». Модель повторяла их туристу как
   * факт о поездке. Схема 926 длительность и расстояние не хранит вовсе —
   * перевозчик их не сообщает, — а цена места законно отсутствует, когда
   * поездка ушла под одну группу. Пустое поле честнее придуманного (§4.0).
   */
  distance_km: number | null;
  duration_minutes: number | null;
  price_per_person: number | null;
  vehicle_type: string;
  /** Дата выезда и остаток мест: без них предложение — обещание без покрытия. */
  trip_date: string;
  seats_free: number;
}

interface DayPlan {
  day: number;
  date?: string;
  activities: {
    time: string;
    type: 'tour' | 'transfer' | 'accommodation' | 'free_time' | 'meal';
    card_id?: string;
    title: string;
    description: string;
    duration?: number;
    price?: number;
    logistics?: {
      transport: 'walk' | 'car' | 'bus' | 'taxi' | 'transfer';
      duration_minutes: number;
      distance_km?: number;
      notes?: string;
    };
  }[];
  accommodation?: AccommodationCard;
  total_cost: number;
}

interface TripPlan {
  summary: {
    total_days: number;
    total_cost: number;
    highlights: string[];
    difficulty_level: 'easy' | 'medium' | 'hard' | 'mixed';
  };
  days: DayPlan[];
  tours: TourCard[];
  accommodations: AccommodationCard[];
  transfers: TransferCard[];
  recommendations: string[];
  important_notes: string[];
}

/**
 * POST /api/trip/plan
 * Планирование поездки на Камчатку
 *
 * AUTH: Public — trip planning for visitors before booking
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!tripPlanLimiter.check(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много запросов. Попробуйте через минуту.' },
      { status: 429 }
    );
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({
        success: false,
        error: 'Неверный формат запроса',
      }, { status: 400 });
    }

    const validationResult = TripPlanSchema.safeParse(body);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.issues[0]?.message || 'Ошибка валидации';
      return NextResponse.json({
        success: false,
        error: errorMessage,
      }, { status: 400 });
    }

    const tripRequest = validationResult.data as TripRequest;

    // Шаг 1: Анализ запроса через AI
    const userIntent = await analyzeUserIntent(tripRequest.query, tripRequest);

    // Шаг 2: Подбор туров из БД
    const tours = await selectTours(userIntent, tripRequest.days, tripRequest.budget);

    // Шаг 3: Подбор размещения из БД
    const accommodations = await selectAccommodations(tripRequest.days, tripRequest.budget, tripRequest.groupSize);

    // Шаг 4: Подбор трансферов из БД
    const transfers = await selectTransfers(tours, accommodations);

    // Шаг 5: Генерация детального маршрута через AI
    const tripPlan = await generateTripPlan(
      tripRequest,
      userIntent,
      tours,
      accommodations,
      transfers
    );

    return NextResponse.json({
      success: true,
      data: tripPlan,
    });

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to plan trip',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

/**
 * Анализ намерений пользователя через AI
 */
async function analyzeUserIntent(query: string, request: TripRequest): Promise<UserIntent> {
  const systemPrompt = `Ты - эксперт по туризму на Камчатке. Проанализируй запрос пользователя и извлеки:
1. Основные интересы (вулканы, медведи, рыбалка, термальные источники, культура, активный отдых)
2. Уровень физической подготовки (легкий, средний, сложный)
3. Тип путешественника (одиночка, пара, семья, группа)
4. Приоритеты (приключения, комфорт, бюджет, экология, фотография)

Верни JSON:
{
  "interests": ["hiking", "wildlife", "photography"],
  "difficulty": "medium",
  "traveler_type": "couple",
  "priorities": ["adventure", "nature"],
  "must_see": ["Ключевская сопка", "Долина гейзеров"],
  "avoid": ["crowds"]
}`;

  const aiResponse = await callAI(systemPrompt, `Запрос: ${query}\nДней: ${request.days}`);
  
  try {
    return JSON.parse(aiResponse);
  } catch {
    // Fallback если AI вернул не JSON
    return {
      interests: request.interests || ['nature', 'adventure'],
      difficulty: 'medium',
      traveler_type: 'group',
      priorities: ['adventure'],
      must_see: [],
      avoid: []
    };
  }
}

/**
 * Подбор туров из БД
 */
async function selectTours(
  userIntent: UserIntent,
  days: number,
  budget?: number
): Promise<TourCard[]> {
  try {
    // Определяем сложность туров
    const difficultyMap: Record<string, string[]> = {
      'easy': ['easy'],
      'medium': ['easy', 'medium'],
      'hard': ['easy', 'medium', 'hard']
    };
    
    const allowedDifficulty = difficultyMap[userIntent.difficulty] || ['easy', 'medium'];
    
    // Максимальное количество часов на туры (80% времени)
    const totalHoursAvailable = days * 24 * 0.8;
    
    const sql = `
      SELECT
        id,
        title AS name,
        short_description as description,
        duration_hours AS duration,
        base_price AS price,
        difficulty,
        operator_id,
        rating,
        coordinates,
        season
      FROM operator_tours
      WHERE
        is_active = true
        AND deleted_at IS NULL
        AND difficulty = ANY($1)
        ${budget ? 'AND base_price <= $2' : ''}
        AND rating >= 3.5
      ORDER BY
        rating DESC,
        reviews_count DESC
      LIMIT 15
    `;
    
    const params = budget ? [allowedDifficulty, budget * 0.3] : [allowedDifficulty];
    const result = await query<{
      id: string; name: string; description: string | null; duration: number;
      price: string; difficulty: string; operator_id: string; rating: string;
      coordinates: unknown;
    }>(sql, params);
    
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      duration: row.duration,
      price: parseFloat(row.price),
      difficulty: row.difficulty,
      operator_id: row.operator_id,
      rating: parseFloat(row.rating),
      coordinates: (row.coordinates as TourCard['coordinates']) || []
    }));
    
  } catch (error) {
    return [];
  }
}

/**
 * Подбор размещения из БД
 */
async function selectAccommodations(
  days: number,
  budget?: number,
  groupSize: number = 2
): Promise<AccommodationCard[]> {
  try {
    const sql = `
      SELECT 
        a.id,
        a.name,
        a.type,
        a.address,
        a.price_per_night_from as price_per_night,
        a.rating,
        a.amenities,
        a.coordinates
      FROM accommodations a
      WHERE 
        a.is_active = true
        ${budget ? 'AND a.price_per_night_from <= $1' : ''}
        AND a.rating >= 3.5
      ORDER BY 
        a.rating DESC,
        a.price_per_night_from ASC
      LIMIT 10
    `;
    
    const params = budget ? [budget / days] : [];
    const result = await query<{
      id: string; name: string; type: string; address: string;
      price_per_night: string; rating: string; amenities: unknown; coordinates: unknown;
    }>(sql, params);
    
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      address: row.address,
      price_per_night: parseFloat(row.price_per_night),
      rating: parseFloat(row.rating),
      amenities: (row.amenities as string[]) || [],
      coordinates: (row.coordinates as AccommodationCard['coordinates']) || { lat: 53.0, lng: 158.6 }
    }));
    
  } catch (error) {
    return [];
  }
}

/**
 * Подбор трансферов из БД
 */
async function selectTransfers(
  tours: TourCard[],
  accommodations: AccommodationCard[]
): Promise<TransferCard[]> {
  try {
    // ── Перенацелено 01.09 на схему 926 ────────────────────────────────────
    //
    // Прежний запрос шёл в transfer_routes / transfer_schedules /
    // transfer_vehicles. Двух последних на проде НЕТ (перепись реестра схемы,
    // прогон 2, канарейка видна), поэтому он падал с 42P01 — и падал ВНУТРЬ
    // catch, который возвращал пустой массив. Планировщик получал «трансферов
    // нет» и говорил это туристу: поломка выдавалась за факт о мире (§4.0).
    //
    // Теперь берём опубликованные поездки со СВОБОДНЫМИ местами: предлагать
    // полную машину значит обещать то, чего нет.
    const sql = `
      SELECT t.id,
             t.to_text AS route_name,
             t.from_text AS from_location,
             t.to_text AS to_location,
             t.price_per_seat::text AS price_per_seat,
             v.kind AS vehicle_kind,
             to_char(t.trip_date, 'YYYY-MM-DD') AS trip_date,
             (t.seats_total - COALESCE(b.taken, 0))::int AS seats_free
        FROM transfer_trips t
        JOIN transfer_fleet_vehicles v ON v.id = t.vehicle_id
        LEFT JOIN LATERAL (
          SELECT SUM(sb.seats) AS taken
            FROM transfer_seat_bookings sb
           WHERE sb.trip_id = t.id AND sb.status = 'confirmed'
        ) b ON true
       WHERE t.is_published
         AND t.status IN ('planned', 'confirmed')
         AND t.trip_date >= CURRENT_DATE
         AND (t.seats_total - COALESCE(b.taken, 0)) > 0
       ORDER BY t.trip_date
       LIMIT 20
    `;

    const result = await query<{
      id: string; route_name: string; from_location: string; to_location: string;
      price_per_seat: string | null; vehicle_kind: string; trip_date: string; seats_free: number;
    }>(sql, []);

    return result.rows.map(row => ({
      id: row.id,
      route_name: row.route_name,
      from_location: row.from_location,
      to_location: row.to_location,
      // Расстояния и длительности схема не хранит: перевозчик их не сообщает.
      // null, а не ноль и не «60 минут» — иначе выдумка уйдёт в промпт.
      distance_km: null,
      duration_minutes: null,
      price_per_person: row.price_per_seat === null ? null : parseFloat(row.price_per_seat),
      vehicle_type: row.vehicle_kind,
      trip_date: row.trip_date,
      seats_free: row.seats_free,
    }));

  } catch (error) {
    // Пустой catch и был механизмом, которым 42P01 превращался в «трансферов
    // нет». Ловить можно, молчать нельзя: имя проверки и SQLSTATE — в лог
    // (§4.0). Планировщик по-прежнему отдаёт пустой список, потому что уронить
    // весь план из-за одного блока хуже, — но теперь отказ оставляет след.
    const e = error as { message?: string; code?: string };
    console.error(
      '[trip/plan] selectTransfers:',
      `${e.code ? `[${e.code}] ` : ''}${e.message ?? String(error)}`,
    );
    return [];
  }
}

/**
 * Генерация детального плана поездки через AI
 */
async function generateTripPlan(
  request: TripRequest,
  userIntent: UserIntent,
  tours: TourCard[],
  accommodations: AccommodationCard[],
  transfers: TransferCard[]
): Promise<TripPlan> {
  
  const systemPrompt = `Ты - эксперт планировщик поездок на Камчатку. 

У тебя есть:
- ${tours.length} доступных туров
- ${accommodations.length} вариантов размещения
- ${transfers.length} трансферов

Создай ДЕТАЛЬНЫЙ план на ${request.days} дней. Для КАЖДОГО дня включи:
1. Утро (9:00-12:00): активности, туры
2. День (12:00-17:00): основные активности
3. Вечер (17:00-21:00): отдых, ужин
4. Логистику между точками (пешком/транспорт/такси, время, расстояние)
5. Размещение на ночь

ОБЯЗАТЕЛЬНО:
- Укажи ID тура из списка: ${tours.map(t => `${t.id}:${t.name}`).join(', ')}
- Укажи ID размещения: ${accommodations.map(a => `${a.id}:${a.name}`).join(', ')}
- Рассчитай логистику между точками
- Дай время на отдых и переезды
- Учитывай погоду Камчатки

Верни строго JSON:
{
  "summary": {
    "total_days": ${request.days},
    "total_cost": 0,
    "highlights": ["топ-3 момента путешествия"],
    "difficulty_level": "medium"
  },
  "days": [
    {
      "day": 1,
      "activities": [
        {
          "time": "09:00",
          "type": "transfer",
          "card_id": "transfer-id",
          "title": "Трансфер из аэропорта",
          "description": "...",
          "duration": 60,
          "price": 1500,
          "logistics": {
            "transport": "car",
            "duration_minutes": 60,
            "distance_km": 30,
            "notes": "Встреча с водителем"
          }
        },
        {
          "time": "14:00",
          "type": "tour",
          "card_id": "tour-id-from-list",
          "title": "Название тура из БД",
          "description": "...",
          "duration": 180,
          "price": 5000
        }
      ],
      "accommodation": {"id": "acc-id-from-list"},
      "total_cost": 8500
    }
  ],
  "recommendations": ["практические советы"],
  "important_notes": ["важная информация о безопасности"]
}`;

  const userPrompt = `
Запрос пользователя: ${request.query}
Дни: ${request.days}
Бюджет: ${request.budget || 'не указан'}
Интересы: ${JSON.stringify(userIntent.interests)}

ДОСТУПНЫЕ ТУРЫ:
${tours.map(t => `- ${t.id}: ${t.name} (${t.duration}ч, ${t.price}₽, ${t.difficulty})`).join('\n')}

ДОСТУПНОЕ РАЗМЕЩЕНИЕ:
${accommodations.map(a => `- ${a.id}: ${a.name} (${a.price_per_night}₽/ночь, ${a.type})`).join('\n')}

ДОСТУПНЫЕ ТРАНСФЕРЫ:
${transfers.slice(0, 5).map(t => {
  // В промпт уходит только известное. Прежняя строка печатала «60мин, 0₽» из
  // подставленных умолчаний, и модель повторяла эти числа туристу как факт о
  // поездке. Чего нет в данных — того нет и в строке (§4.0: промпт не требует
  // того, чего в данных нет).
  const facts = [
    `${t.trip_date}`,
    t.duration_minutes === null ? null : `${t.duration_minutes}мин`,
    t.price_per_person === null ? 'цена по запросу' : `${t.price_per_person}₽/место`,
    `свободно ${t.seats_free}`,
  ].filter(Boolean);
  return `- ${t.from_location} → ${t.to_location} (${facts.join(', ')})`;
}).join('\n')}
`;

  const aiResponse = await callAI(systemPrompt, userPrompt);
  
  try {
    const plan = JSON.parse(aiResponse);
    
    // Обогащаем план полными данными карточек
    plan.tours = tours.filter(t => 
      plan.days.some((d: DayPlan) => 
        d.activities.some(a => a.card_id === t.id)
      )
    );
    
    plan.accommodations = accommodations.filter(a =>
      plan.days.some((d: DayPlan) => d.accommodation?.id === a.id)
    );
    
    plan.transfers = transfers.filter(t =>
      plan.days.some((d: DayPlan) =>
        d.activities.some(a => a.card_id === t.id)
      )
    );
    
    return plan;
    
  } catch (error) {
    
    // Fallback: создаем базовый план
    return createFallbackPlan(request, tours, accommodations);
  }
}

/**
 * Fallback план если AI не смог сгенерировать
 */
function createFallbackPlan(
  request: TripRequest,
  tours: TourCard[],
  accommodations: AccommodationCard[]
): TripPlan {
  
  const days: DayPlan[] = [];
  let totalCost = 0;
  
  for (let day = 1; day <= request.days; day++) {
    const dayTours = tours.slice(0, 1); // Берем 1 тур в день
    const accommodation = accommodations[0];
    
    const activities = dayTours.map((tour, idx) => ({
      time: idx === 0 ? '10:00' : '14:00',
      type: 'tour' as const,
      card_id: tour.id,
      title: tour.name,
      description: tour.description,
      duration: tour.duration,
      price: tour.price,
      logistics: {
        transport: 'car' as const,
        duration_minutes: 30,
        distance_km: 15,
        notes: 'Трансфер к месту начала тура'
      }
    }));
    
    const dayCost = dayTours.reduce((sum, t) => sum + t.price, 0) + 
                    (accommodation?.price_per_night || 0);
    
    totalCost += dayCost;
    
    days.push({
      day,
      activities,
      accommodation,
      total_cost: dayCost
    });
  }
  
  return {
    summary: {
      total_days: request.days,
      total_cost: totalCost,
      highlights: [
        'Знакомство с вулканами Камчатки',
        'Посещение природных достопримечательностей',
        'Комфортное размещение'
      ],
      difficulty_level: 'medium'
    },
    days,
    tours,
    accommodations: accommodations.slice(0, 1),
    transfers: [],
    recommendations: [
      'Возьмите теплую одежду - погода изменчива',
      'Носите удобную обувь для походов',
      'Не забудьте фотоаппарат!'
    ],
    important_notes: [
      'Соблюдайте правила безопасности в медвежьих зонах',
      'Предупреждайте гида о проблемах со здоровьем',
      'Оформите страховку для активного отдыха'
    ]
  };
}

/**
 * Вызов AI (DeepSeek как основной провайдер)
 */
async function callAI(systemPrompt: string, userPrompt: string): Promise<string> {
  // Пробуем DeepSeek
  if (config.ai.deepseek.apiKey) {
    try {
      const response = await fetch(`${config.ai.deepseek.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ai.deepseek.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.ai.deepseek.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: config.ai.deepseek.maxTokens,
          temperature: 0.7,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
      }
    } catch (error) {
    }
  }

  throw new Error('All AI providers unavailable');
}
