/**
 * POST /api/field-check/report — приём полевой проверки записи.
 *
 * Проверка НИЧЕГО не меняет в данных: она ложится в очередь
 * route_field_checks со статусом pending (миграция 898). Правит владелец —
 * тот же закон, что у переписей: судья предлагает, решает человек. Иначе
 * первый же ошибочный тап переписал бы координату маршрута.
 *
 * Третье состояние соблюдается на входе: координаты и точность фикса
 * НЕОБЯЗАТЕЛЬНЫ. Проверка «по памяти, не с места» — законное состояние, и
 * тому, кто будет решать, важно видеть разницу, а не получить выдуманный
 * ноль.
 *
 * Публичный: логина в поле нет. Защита — форма Zod, ограничение длины,
 * и то, что запись попадает в очередь, а не в витрину.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BodySchema = z.object({
  /**
   * `new` — находка: здесь есть то, чего у нас нет вовсе (владелец 22.08,
   * стоя на Диких озерках: «а если места нет и в выборе тоже?»). У находки
   * НЕТ target_id, и это не пропуск, а её природа: связывать не с чем,
   * потому что записи ещё не существует.
   */
  target_kind: z.enum(['route', 'place', 'new']),
  target_id: z.string().min(1).max(64).nullable().optional(),
  /** Как человек назвал находку. Только у `new`. */
  proposed_name: z.string().min(2).max(120).nullable().optional(),
  verdict: z.enum([
    'confirmed', 'coords_wrong', 'not_found',
    'line_wrong', 'description_wrong', 'access_changed', 'other',
    'new_place',
  ]),
  // Координата проверяющего: либо есть целиком, либо её нет вовсе.
  reported_lat: z.number().min(-90).max(90).nullable().optional(),
  reported_lng: z.number().min(-180).max(180).nullable().optional(),
  accuracy_m: z.number().int().min(0).max(100_000).nullable().optional(),
  note: z.string().max(600).nullable().optional(),
  trip_tag: z.string().max(60).nullable().optional(),
  // Правильная координата ОБЪЕКТА — не то же, что координата проверяющего:
  // на скалу можно смотреть с берега, а источник увидеть в стороне от
  // записи. Происхождение обязательно, когда координата дана: фикс на
  // объекте и цифры из чужого навигатора — улики разного веса.
  object_lat: z.number().min(-90).max(90).nullable().optional(),
  object_lng: z.number().min(-180).max(180).nullable().optional(),
  object_source: z.enum(['my_fix', 'manual']).nullable().optional(),
});

/**
 * Род цели и наличие id должны сходиться. Находка без id законна; проверка
 * нашей записи без id — потерянная связь, и принять её значило бы завести
 * в очереди сироту, о которой потом никто не скажет, к чему она относилась.
 */
function targetMismatch(d: { target_kind: string; target_id?: string | null }): string | null {
  const isNew = d.target_kind === 'new';
  const hasId = typeof d.target_id === 'string' && d.target_id.length > 0;
  if (isNew && hasId) return 'У находки не бывает id записи — её ещё нет';
  if (!isNew && !hasId) return 'Не указано, какую запись проверяли';
  return null;
}

export async function POST(request: NextRequest) {
  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? err.issues[0]?.message ?? 'Некорректные данные'
      : 'Некорректные данные';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  // Половина координаты — не координата: либо пара, либо ничего.
  const hasLat = typeof data.reported_lat === 'number';
  const hasLng = typeof data.reported_lng === 'number';
  const mismatch = targetMismatch(data);
  if (mismatch !== null) {
    return NextResponse.json({ success: false, error: mismatch }, { status: 400 });
  }

  // Находка без имени бесполезна: «здесь что-то есть» нельзя ни завести,
  // ни найти. Спрашиваем прямо, а не подставляем координату вместо имени.
  if (data.target_kind === 'new' && !data.proposed_name?.trim()) {
    return NextResponse.json(
      { success: false, error: 'Назовите находку — хотя бы «стоянка» или «брод»' },
      { status: 400 },
    );
  }

  if (hasLat !== hasLng) {
    return NextResponse.json(
      { success: false, error: 'Координата принимается парой: широта и долгота' },
      { status: 400 },
    );
  }

  const hasObjLat = typeof data.object_lat === 'number';
  const hasObjLng = typeof data.object_lng === 'number';
  if (hasObjLat !== hasObjLng) {
    return NextResponse.json(
      { success: false, error: 'Координата объекта принимается парой' },
      { status: 400 },
    );
  }
  // Координата без происхождения — цифры без веса: неизвестно, стоял ли
  // человек на объекте или переписал их откуда-то.
  if (hasObjLat && !data.object_source) {
    return NextResponse.json(
      { success: false, error: 'У координаты объекта должно быть происхождение' },
      { status: 400 },
    );
  }

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO route_field_checks
         (target_kind, target_id, proposed_name, verdict, reported_lat, reported_lng,
          accuracy_m, note, trip_tag, object_lat, object_lng, object_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id::text AS id`,
      [
        data.target_kind,
        data.target_kind === 'new' ? null : data.target_id,
        data.target_kind === 'new' ? data.proposed_name!.trim() : null,
        data.verdict,
        hasLat ? data.reported_lat : null,
        hasLng ? data.reported_lng : null,
        data.accuracy_m ?? null,
        data.note?.trim() ? data.note.trim() : null,
        data.trip_tag?.trim() ? data.trip_tag.trim() : null,
        hasObjLat ? data.object_lat : null,
        hasObjLng ? data.object_lng : null,
        hasObjLat ? data.object_source ?? null : null,
      ],
    );
    return NextResponse.json({ success: true, id: rows[0]?.id ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка записи проверки';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
