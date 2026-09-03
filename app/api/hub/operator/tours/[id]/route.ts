/**
 * GET   /api/hub/operator/tours/[id] — Get single tour
 * PATCH /api/hub/operator/tours/[id] — Update tour
 * DELETE /api/hub/operator/tours/[id] — Soft-delete tour
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator } from '@/lib/auth/middleware';
import {
  UpdateTourSchema,
  getTourById,
  softDeleteTour,
} from '@/lib/api/operator-tours';
import { transaction } from '@/lib/database';
import { getColumnTypes, valueForColumn } from '@/lib/db/column-types';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';

export const dynamic = 'force-dynamic';

/** BigInt(params.id) на нечисловом id кидает SyntaxError — тот же тип
 * исключения, что и у request.json() на битом теле. Раньше обе ошибки
 * ловились одним catch и путались: DELETE /tours/not-a-number отвечал
 * общим 500 "Failed to delete tour" вместо честного 400 на клиентскую
 * ошибку ввода (аудит кабинета оператора). */
function parseTourId(raw: string): bigint | null {
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const tourId = parseTourId(params.id);
  if (tourId === null) {
    return NextResponse.json({ error: 'Некорректный id тура' }, { status: 400 });
  }

  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const isAdmin = authOrResponse.role === 'admin';

    const operator_id = isAdmin ? null : await getOperatorPartnerId(authOrResponse.userId);
    if (!isAdmin && !operator_id) {
      return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
    }

    const tour = await getTourById(tourId);
    if (!tour || (!isAdmin && tour.operator_id !== operator_id)) {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: tour });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/tours/[id]] GET отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to fetch tour' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const tourId = parseTourId(params.id);
  if (tourId === null) {
    return NextResponse.json({ error: 'Некорректный id тура' }, { status: 400 });
  }

  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const isAdmin = authOrResponse.role === 'admin';

    const operator_id = isAdmin ? null : await getOperatorPartnerId(authOrResponse.userId);
    if (!isAdmin && !operator_id) {
      return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
    }

    const tour = await getTourById(tourId);
    if (!tour || (!isAdmin && tour.operator_id !== operator_id)) {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 });
    }

    const body = await request.json();
    const input = UpdateTourSchema.parse(body);

    // Build SET clause dynamically from provided fields
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const allowed = [
      'title', 'short_description', 'description',
      'location_type', 'activity_type', 'location_name',
      'latitude', 'longitude',
      'base_price', 'price_old', 'price_unit',
      'max_participants', 'min_participants',
      'duration_hours', 'duration_type', 'multi_day_count',
      'season_start', 'season_end', 'seasonal_only',
      'difficulty', 'weather_dependent',
      'min_visibility_m', 'max_wind_kmh', 'max_precipitation_mm',
      'is_active', 'is_published',
      'included', 'not_included', 'what_to_bring',
      'cancellation_policy',
      'photos', 'tour_image',
      'available_slots', 'next_available_date',
    ] as const;

    // Тип колонки берём из схемы, а не из предположения: состав тура на проде
    // год был jsonb там, где репозиторий объявлял TEXT[], и сохранение падало.
    const columnTypes = await getColumnTypes('operator_tours');

    for (const key of allowed) {
      const rec = input as Record<string, unknown>;
      if (key in rec && rec[key] !== undefined) {
        fields.push(`${key} = $${idx++}`);
        values.push(valueForColumn(rec[key], key, columnTypes));
      }
    }

    if (fields.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    values.push(tourId);

    // UPDATE и перезапись тегов — в ОДНОЙ транзакции. Раньше это были два
    // независимых запроса: обрыв соединения между DELETE и циклом INSERT
    // оставлял теги частично потерянными, а клиенту уходил 500 — оператор
    // считал, что не сохранилось НИЧЕГО, хотя цена/название уже применились
    // (аудит кабинета оператора).
    const updatedRow = await transaction(async (client) => {
      const result = await client.query(
        `UPDATE operator_tours SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} AND deleted_at IS NULL
         RETURNING id, title, updated_at`,
        values
      );

      if (input.tags !== undefined) {
        await client.query(`DELETE FROM operator_tour_tags WHERE tour_id = $1`, [tourId]);
        for (const tag of input.tags) {
          await client.query(
            `INSERT INTO operator_tour_tags (tour_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [tourId, tag.trim().toLowerCase()]
          );
        }
      }

      return result.rows[0];
    });

    pingTourChanged(tourId);

    return NextResponse.json({ success: true, data: updatedRow });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    // ZodError раньше не разбирался отдельно — любая ошибка валидации
    // (пустая строка в title, отрицательная цена, non-nullable base_price
    // при очистке поля) падала в generic 500 "Failed to update tour" без
    // объяснения причины (аудит кабинета оператора).
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? 'Некорректные данные' }, { status: 400 });
    }
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/tours/[id]] PATCH отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to update tour' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const tourId = parseTourId(params.id);
  if (tourId === null) {
    return NextResponse.json({ error: 'Некорректный id тура' }, { status: 400 });
  }

  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const isAdmin = authOrResponse.role === 'admin';

    const operator_id = isAdmin ? null : await getOperatorPartnerId(authOrResponse.userId);
    if (!isAdmin && !operator_id) {
      return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
    }

    const deleted = await softDeleteTour(tourId, isAdmin ? undefined : operator_id);
    if (!deleted) {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: 'Tour deleted' });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/tours/[id]] DELETE отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to delete tour' }, { status: 500 });
  }
}
