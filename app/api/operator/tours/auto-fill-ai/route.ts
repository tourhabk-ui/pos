/**
 * POST /api/operator/tours/auto-fill-ai
 * AI agent to auto-fill missing tour fields based on existing data
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { saveTourChange } from '@/lib/tours/tour-change';
import { loadOwnTourEdits } from '@/lib/tours/moderation-store';
import type { TourPatchInput } from '@/lib/tours/tour-write';
import { requireOperator } from '@/lib/auth/middleware';
import { accessFailure, operatorAccess } from '@/lib/operators/team-access';
import { callAIWaterfall } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

/** Реальный enum сложности приложения (lib/api/operator-tours.ts, _EditTourClient.tsx) — не "moderate". */
const VALID_DIFFICULTY = new Set(['easy', 'medium', 'hard', 'expert']);

interface TourData {
  id: string;
  title: string;
  description: string;
  activity_type: string;
  location_type: string;
  // Текущие значения — нужны, чтобы промпт не выдумывал то, что уже
  // заполнено вручную оператором, и чтобы UPDATE ниже мог безопасно
  // отфильтровать поля, которые заполнять не требовалось (аудит кабинета
  // оператора: авто-заполнение гарантированно затирало верные ручные данные,
  // включая координаты, потому что не читало текущее состояние вовсе).
  difficulty: string | null;
  duration_hours: string | null;
  duration_type: string | null;
  location_name: string | null;
  latitude: string | null;
  longitude: string | null;
  /** Колонки могут быть jsonb или text[] (см. getColumnTypes) — судим по пустоте. */
  included: unknown;
  not_included: unknown;
  what_to_bring: unknown;
  notes: string | null;
  short_description: string | null;
}

interface AIFillResult {
  short_description?: string;
  difficulty?: string;
  included?: string[];
  not_included?: string[];
  what_to_bring?: string[];
  duration_hours?: number;
  duration_type?: string;
  location_name?: string;
  latitude?: number;
  longitude?: number;
  notes?: string;
}

async function generateTourFills(tour: TourData): Promise<AIFillResult> {
  const kamchatkaLocations = `
Known Kamchatka fishing spots:
- Kurilskoye Lake (56.0333°N, 157.4667°E) — salmon, brown bears
- Ozernaya River (56.5000°N, 157.7500°E) — trout, scenic canyons
- Avacha River (53.0000°N, 158.6667°E) — salmon, thermal springs nearby
- Khalzhina River (56.8000°N, 160.5000°E) — spawning runs
- Avachinsky Volcano base (53.2533°N, 158.8361°E) — trekking with thermal springs
- Petropavlovsk-Kamchatsky harbor (53.0281°N, 158.6523°E) — boat trips, wildlife
- Three Volcanoes: Koryaksky (53.5081°N, 158.8722°E), Avachinsky, Kozelsky (53.2281°N, 158.8611°E)
- Geysers of Kamchatka (54.0°N, 160.0°E) — geothermal fields, hiking
- Nalychevo Valley (53.8000°N, 159.0000°E) — hot springs, salmon fishing`;

  // Поля, УЖЕ заполненные вручную, промпту не отдаются как «пусто» — модель
  // не должна ни подтверждать их, ни заменять: заполняет только дыры.
  const already: string[] = [];
  if (tour.difficulty) already.push(`difficulty: ${tour.difficulty}`);
  if (tour.duration_hours) already.push(`duration_hours: ${tour.duration_hours}`);
  if (tour.duration_type) already.push(`duration_type: ${tour.duration_type}`);
  if (tour.location_name) already.push(`location_name: ${tour.location_name}`);
  if (tour.latitude && tour.longitude) already.push(`coordinates: ${tour.latitude}, ${tour.longitude}`);
  if (tour.short_description) already.push(`short_description: ${tour.short_description}`);

  const prompt = `You are an expert travel guide assistant for Kamchatka tours. Analyze this tour and generate realistic field values in JSON format.

Tour Information:
- Title: ${tour.title}
- Description: ${tour.description}
- Activity Type: ${tour.activity_type}
- Location Type: ${tour.location_type}

${kamchatkaLocations}

${already.length > 0
  ? `Already filled by the operator (do NOT invent a replacement for these — the caller will discard any value you return for them, so leave them null/omitted):\n${already.map((s) => `- ${s}`).join('\n')}\n`
  : ''}
Generate the following JSON object with realistic values (respond ONLY with valid JSON, no markdown):
{
  "short_description": "One sentence summary (max 100 chars)",
  "difficulty": "easy|medium|hard|expert",
  "included": ["item1", "item2", "item3"],
  "not_included": ["item1", "item2"],
  "what_to_bring": ["item1", "item2", "item3", "item4"],
  "duration_hours": 4.5,
  "duration_type": "day|multi_day",
  "location_name": "Name of the specific place/lake/river/volcano",
  "notes": "Interesting fact or local knowledge about this tour"
}

Rules:
- difficulty: must be exactly one of easy, medium, hard, expert
- duration_type: day (up to one day), multi_day (several days)
- Generate realistic, specific items not generic ones
- Focus on what would be needed for this type of activity
- Keep arrays to 3-5 items max
- For fishing: include rod, license, waders, bait, etc
- For trekking: include water, sunscreen, proper shoes, etc
- location_name: choose a specific place from Kamchatka (lake, river, volcano, geysers)
- notes: include useful local knowledge about the location or activity season`;

  // Раньше — прямой api.anthropic.com (opus), недоступный из РФ (прод — Timeweb):
  // оператор не мог авто-заполнить тур (вызов бросал ошибку). Уводим на
  // устойчивый водопад (Qwen/DeepSeek/… доступны из РФ), fallback встроен.
  const raw = await callAIWaterfall([{ role: 'user' as const, content: prompt }]);

  // Модель может обернуть JSON в ```json ... ``` — снимаем ограждение.
  const responseText = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  // Parse JSON response
  const parsed = JSON.parse(responseText || '{}');

  // difficulty не из реального enum приложения (easy|medium|hard|expert) —
  // «не знаю» лучше значения, которое молча ломает <select> редактора.
  const difficulty = typeof parsed.difficulty === 'string' && VALID_DIFFICULTY.has(parsed.difficulty)
    ? parsed.difficulty
    : undefined;

  return {
    short_description: parsed.short_description || undefined,
    difficulty,
    included: parsed.included || undefined,
    not_included: parsed.not_included || undefined,
    what_to_bring: parsed.what_to_bring || undefined,
    duration_hours: parsed.duration_hours || undefined,
    duration_type: parsed.duration_type || undefined,
    location_name: parsed.location_name || undefined,
    latitude: parsed.latitude || undefined,
    longitude: parsed.longitude || undefined,
    notes: parsed.notes || undefined,
  };
}

export interface AutoFillOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Логика без HTTP — вызывается и самим роутом, и OperatorAgency
 * (lib/agents/agencies/operator-agency.ts, команда «заполни тур N»)
 * напрямую, в процессе. Раньше агентство дёргало этот роут внутренним
 * fetch без cookie/JWT — requireOperator неизбежно отвечал 401, и команда
 * «AI заполнить тур» не работала НИКОГДА (аудит кабинета оператора).
 * Владение туром здесь уже проверено вызывающим (operatorId — партнёр,
 * прошедший свою проверку), поэтому лишний HTTP-прыжок был чистым риском,
 * а не защитой.
 */
export async function runAutoFillAI(operatorId: string, tourId: string | number): Promise<AutoFillOutcome> {
  // Get tour data — включая уже заполненные поля, чтобы не затирать их.
  const { rows: tours } = await pool.query<TourData>(
    `SELECT id, title, description, activity_type, location_type,
            difficulty, duration_hours::text, duration_type,
            location_name, latitude::text, longitude::text, short_description,
            included, not_included, what_to_bring, notes
     FROM operator_tours
     WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL`,
    [tourId, operatorId]
  );

  if (tours.length === 0) {
    return { status: 404, body: { error: 'Tour not found' } };
  }

  // Пустоту поля судим по тому, что оператор видит в редакторе: витрина плюс
  // правка на проверке. Иначе модель «заполнила» бы поле, которое оператор
  // уже вписал и отправил на проверку, — и затёрла бы его текст в черновике.
  const edits = await loadOwnTourEdits([String(tours[0].id)], new Map());
  if (edits === null) {
    return { status: 503, body: { error: 'Не удалось прочитать правку на проверке, попробуйте позже' } };
  }
  const tour = { ...tours[0], ...(edits.get(String(tours[0].id))?.pending?.patch ?? {}) } as TourData;

  // Validate required fields exist
  if (!tour.title || !tour.description) {
    return { status: 400, body: { error: 'Tour must have title and description before AI fill' } };
  }

  // Generate fills with AI
  const fills = await generateTourFills(tour);

  // Update tour with AI-generated data — ТОЛЬКО поля, которые были пусты
  // ДО вызова. AI мог проигнорировать инструкцию не трогать заполненное
  // (модели это делают) — второй барьер здесь, а не только в промпте.
  const updates: Record<string, unknown> = {};

  if (fills.short_description && !tour.short_description) updates.short_description = fills.short_description;
  if (fills.difficulty && !tour.difficulty) updates.difficulty = fills.difficulty;
  // Состав, снаряжение и заметки — только в пустое (как остальные поля): до
  // 25.09 модель перезаписывала то, что оператор вписал руками, в уже
  // опубликованном туре.
  const isEmptyList = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0);
  if (fills.included && isEmptyList(tour.included)) updates.included = fills.included;
  if (fills.not_included && isEmptyList(tour.not_included)) updates.not_included = fills.not_included;
  if (fills.what_to_bring && isEmptyList(tour.what_to_bring)) updates.what_to_bring = fills.what_to_bring;
  if (fills.duration_hours && !tour.duration_hours) updates.duration_hours = fills.duration_hours;
  // Схема тура знает только day/multi_day; «half_day» ломал каждое следующее
  // сохранение в редакторе (400).
  if (fills.duration_type && !tour.duration_type && (fills.duration_type === 'day' || fills.duration_type === 'multi_day')) {
    updates.duration_type = fills.duration_type;
  }
  if (fills.location_name && !tour.location_name) updates.location_name = fills.location_name;
  // Координаты модель не пишет вовсе (§4.0): «реалистичные координаты
  // Камчатки» из промпта — это выдуманная точка, по которой пойдёт человек.
  // Заметки — служебное поле, на витрину не выходит: пишется отдельно.
  const notes = fills.notes && !tour.notes ? fills.notes : null;

  const filled = Object.keys(updates).length + (notes === null ? 0 : 1);
  if (filled === 0) {
    return { status: 200, body: { success: true, data: { filled: 0, fills: {} } } };
  }

  // Запись — единая дверь владельца (lib/tours/tour-change, план готовности
  // 23.11, этап 4): текст модели в опубликованном туре выходит на витрину
  // только после проверки администратором; сложность, длительность и место —
  // сразу, как у формы. Прежде модель писала прямо в живую строку.
  const saved = await transaction(async (client) => {
    const w = Object.keys(updates).length > 0
      ? await saveTourChange(client, {
        tourId: String(tourId), ownerId: operatorId, userId: null,
        input: updates as TourPatchInput, current: {},
      })
      : null;
    if (w?.outcome === 'not_found') return w;
    if (notes !== null) {
      await client.query(
        `UPDATE operator_tours SET notes = $1, updated_at = NOW()
          WHERE id = $2 AND operator_id = $3 AND deleted_at IS NULL`,
        [notes, tourId, operatorId],
      );
    }
    return w;
  });
  if (saved?.outcome === 'not_found') {
    return { status: 404, body: { error: 'Tour not found' } };
  }
  const pending = saved?.outcome === 'pending' ? saved.pending.notice : null;

  return {
    status: 200,
    body: {
      success: true,
      data: {
        filled,
        // Тексты ушли на проверку: что сказать оператору. null — записано сразу.
        pending,
        fills: {
          short_description: fills.short_description,
          difficulty: fills.difficulty,
          included: fills.included,
          not_included: fills.not_included,
          what_to_bring: fills.what_to_bring,
          duration_hours: fills.duration_hours,
          duration_type: fills.duration_type,
          location_name: fills.location_name,
          latitude: fills.latitude,
          longitude: fills.longitude,
          notes: fills.notes,
        },
      },
    },
  };
}

export async function POST(request: NextRequest) {
  const userOrResponse = await requireOperator(request);
  if (userOrResponse instanceof NextResponse) {
    return userOrResponse;
  }

  // Кабинет — свой у владельца или командный у менеджера (CRM 2г). Цен
  // автозаполнение не трогает (только описание, состав, сложность,
  // длительность, место), поэтому права can_edit_prices не нужно. Прежний
  // свой поиск по partners.user_id закрывал роут менеджеру, хотя экран
  // «Чего не хватает» ему открыт. «Не смогли проверить» — 503, а не «нет».
  const access = await operatorAccess(userOrResponse.userId);
  if (access.kind !== 'owner' && access.kind !== 'manager') return accessFailure(access);
  const operatorId = access.partnerId;

  try {
    const body = await request.json();
    const { tourId } = body;

    if (!tourId) {
      return NextResponse.json({ error: 'Missing tourId' }, { status: 400 });
    }

    const outcome = await runAutoFillAI(operatorId, tourId);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'AI generated invalid response, please try again' },
        { status: 500 }
      );
    }
    const e = error as { code?: string; message?: string };
    console.error('[auto-fill-ai] отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json(
      { error: 'Failed to auto-fill tour' },
      { status: 500 }
    );
  }
}
