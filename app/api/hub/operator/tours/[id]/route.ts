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
  kindChangeRejected,
  softDeleteTour,
} from '@/lib/api/operator-tours';
import { MainPlaceRejected } from '@/lib/tours/main-place';
import { writeTourPatch } from '@/lib/tours/tour-write';
import { transaction } from '@/lib/database';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { requireTeamPermission } from '@/lib/operators/team-access';
import { changesTourPrice } from '@/lib/operators/team-money';
import { zodErrorMessage } from '@/lib/api/zod-errors';

export const dynamic = 'force-dynamic';

/** BigInt(id) на нечисловом id кидает SyntaxError — тот же тип
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
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tourId = parseTourId(id);
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
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tourId = parseTourId(id);
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

    // Вид места и активности: сохранённое у тура проходит как было (туры из
    // миграций несут jeep_safari, snowmobile, sightseeing…), новое — только из
    // списка формы. Прежде схема отвергала сохранённое, и тур из миграции
    // нельзя было сохранить вовсе — вместе с выбором главного места.
    const kindRejected = kindChangeRejected(input, tour as Record<string, unknown>);
    if (kindRejected) return NextResponse.json({ error: kindRejected }, { status: 400 });

    // Цена тура — право, которое даёт владелец кабинета (CRM 2г): менеджер
    // без него правит программу, описание и даты, но не цену. Редактор шлёт
    // форму целиком, поэтому судим по изменению против строки из базы, а не
    // по тому, что поле прислано.
    if (!isAdmin && changesTourPrice(input, tour as Record<string, unknown>)) {
      const denied = await requireTeamPermission(authOrResponse.userId, 'can_edit_prices');
      if (denied) return denied;
    }

    // Запись — общая функция (lib/tours/tour-write): тем же путём тур гида
    // правится из чата кабинета. Владение уже проверено выше; функция
    // проверяет его ещё раз в самом UPDATE. Теги — в той же транзакции.
    const written = await transaction((client) => writeTourPatch(client, {
      tourId,
      ownerId: isAdmin ? null : operator_id,
      input,
      current: tour as Record<string, unknown>,
    }));
    if (written.outcome === 'empty') {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    if (written.outcome === 'not_found') {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 });
    }
    const updatedRow = written.row;

    pingTourChanged(tourId);

    return NextResponse.json({ success: true, data: updatedRow });
  } catch (error) {
    if (error instanceof MainPlaceRejected) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Не удалось прочитать запрос: тело не является корректным JSON' }, { status: 400 });
    }
    // ZodError раньше не разбирался отдельно — любая ошибка валидации
    // (пустая строка в title, отрицательная цена, non-nullable base_price
    // при очистке поля) падала в generic 500 "Failed to update tour" без
    // объяснения причины (аудит кабинета оператора).
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: zodErrorMessage(error) }, { status: 400 });
    }
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/tours/[id]] PATCH отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to update tour' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tourId = parseTourId(id);
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
