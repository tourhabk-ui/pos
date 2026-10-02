/**
 * API endpoint объекта размещения
 * GET /api/accommodations/[id] — публичная карточка
 * PATCH /api/accommodations/[id] — редактирование владельцем (или admin)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { verifyAccommodationOwnership, StayCheckUnavailableError, stayCheckUnavailableResponse } from '@/lib/auth/stay-helpers';
import { logStayFailure } from '@/lib/stay/db-failure';
import { ZONE_IDS } from '@/lib/planner/constants';
import { loadAccommodationDetail } from '@/lib/stay/accommodation-detail';

export const dynamic = 'force-dynamic';

// GET /api/accommodations/[id] - Public by design: accommodation detail for discovery.
// Загрузчик общий со страницей /accommodations/[id] — lib/stay/accommodation-detail
// (там же витринное условие publicAccommodationSql и правила рейтинга/имён).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const data = await loadAccommodationDetail(id);
    if (!data) {
      return NextResponse.json(
        { success: false, error: 'Объект размещения не найден' },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    // Отказ не глушится (§4.0): причина — в лог, наружу — нейтральный текст.
    const err = error as { code?: string; message?: string };
    console.error('[api/accommodations/[id]] карточка не прочитана:', id, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(error));
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении информации об объекте' },
      { status: 500 }
    );
  }
}

const paramsSchema = z.object({ id: z.string().uuid('Некорректный ID объекта') });

const UpdateAccommodationSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  shortDescription: z.string().max(500).optional(),
  amenities: z.array(z.string()).optional(),
  pricePerNightFrom: z.number().positive('Цена должна быть положительной').optional(),
  pricePerNightTo: z.number().positive().nullable().optional(),
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/, 'Формат времени — ЧЧ:ММ').optional(),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/, 'Формат времени — ЧЧ:ММ').optional(),
  isActive: z.boolean().optional(),
  // Зона планера (миграция 1031). Снять разметку (null) владелец не может —
  // только поменять; «не размечено» остаётся у старых объектов до решения.
  plannerZone: z.enum(ZONE_IDS, { message: 'Выберите зону для планера поездок' }).optional(),
  // Ссылка на бронь на сайте объекта: только https, пустая строка — снять.
  externalBookingUrl: z.union([
    z.string().trim().max(500).regex(/^https:\/\/\S+$/, 'Ссылка на бронь должна начинаться с https://'),
    z.literal('').transform(() => null),
    z.null(),
  ]).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'Нет полей для обновления' });

// PATCH /api/accommodations/[id] — владелец редактирует свой объект, admin — любой
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;
    const isAdmin = authResult.role === 'admin';

    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { success: false, error: 'Некорректный ID объекта' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const accommodationId = parsedParams.data.id;

    if (!isAdmin) {
      const owns = await verifyAccommodationOwnership(userId, accommodationId);
      if (!owns) {
        return NextResponse.json(
          { success: false, error: 'Объект размещения не найден' } as ApiResponse<null>,
          { status: 404 }
        );
      }
    }

    const body = await request.json();
    const parsed = UpdateAccommodationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // camelCase поля запроса → snake_case колонки; amenities — JSONB.
    const columnMap: Record<string, { column: string; transform?: (v: unknown) => unknown }> = {
      name: { column: 'name' },
      description: { column: 'description' },
      shortDescription: { column: 'short_description' },
      amenities: { column: 'amenities', transform: v => JSON.stringify(v) },
      pricePerNightFrom: { column: 'price_per_night_from' },
      pricePerNightTo: { column: 'price_per_night_to' },
      checkInTime: { column: 'check_in_time' },
      checkOutTime: { column: 'check_out_time' },
      isActive: { column: 'is_active' },
      plannerZone: { column: 'planner_zone' },
      externalBookingUrl: { column: 'external_booking_url' },
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    // Индекс параметра со ссылкой на бронь: по нему ниже сравнивается «было —
    // стало», чтобы правка ссылки владельцем отправляла объект на модерацию.
    let externalUrlIdx: number | null = null;

    for (const [key, value] of Object.entries(parsed.data)) {
      const mapping = columnMap[key];
      if (!mapping) continue;
      setClauses.push(`${mapping.column} = $${idx}`);
      if (key === 'externalBookingUrl') externalUrlIdx = idx;
      values.push(mapping.transform ? mapping.transform(value) : value);
      idx++;
    }

    // Модерация после правки ВЛАДЕЛЬЦА (администратор решает через
    // /api/admin/accommodations/[id]):
    //   - отклонённый объект, исправленный по существу, снова уходит на
    //     проверку — экран отказа обещает «после правки — снова на проверку»;
    //   - СМЕНА ссылки на бронь у одобренного объекта тоже: ссылка уходит
    //     туристу кнопкой «Забронировать на сайте отеля» и, будучи подменённой,
    //     вела бы на чужой сайт под одобренной карточкой без чьей-либо
    //     проверки (обзор 29.09). Одобренная ссылка не меняется молча; такая
    //     же ссылка, как была, ничего не сбрасывает.
    // Условие одно и в одном присваивании: два `moderation_status = …` в
    // одном UPDATE база отвергает.
    const contentEdited = Object.keys(parsed.data).some(k => k !== 'isActive');
    if (!isAdmin && contentEdited) {
      // В UPDATE правая часть читает СТАРУЮ строку, поэтому сравнение колонки с
      // новым значением видит именно «было — стало».
      const conds = [`moderation_status = 'rejected'`];
      if (externalUrlIdx !== null) {
        // Снятие ссылки (NULL) риска подмены не несёт и объект с витрины не
        // убирает; на модерацию уходит только замена ссылки на другую.
        conds.push(`(moderation_status = 'approved' AND $${externalUrlIdx}::text IS NOT NULL AND external_booking_url IS DISTINCT FROM $${externalUrlIdx}::text)`);
      }
      setClauses.push(`moderation_status = CASE WHEN ${conds.join(' OR ')} THEN 'pending' ELSE moderation_status END`);
    }

    setClauses.push('updated_at = NOW()');
    values.push(accommodationId);

    const result = await query(
      `UPDATE accommodations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Объект размещения не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: result.rows[0],
      message: 'Объект размещения обновлён'
    } as ApiResponse<unknown>);

  } catch (error) {
    if (error instanceof StayCheckUnavailableError) return stayCheckUnavailableResponse();
    logStayFailure('PATCH /api/accommodations/[id]', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении объекта размещения' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}



