/**
 * GET   /api/hub/operator/tours/[id] — Get single tour
 * PATCH /api/hub/operator/tours/[id] — Update tour
 * DELETE /api/hub/operator/tours/[id] — Soft-delete tour
 *
 * С 08.11 правка несёт и программу дня, правила безопасности, клипы и
 * подпись снимков — те же поля и пределы, что у формы гида
 * (lib/guides/own-tour-edit); подпись уходит в карту авторов владельца тура
 * (lib/tours/editor-media). GET отдаёт форме клипы с адресами превью,
 * подписи снимков и «видит ли тур турист» (шлюз каталога).
 *
 * С 23.11 (план готовности, этап 4) содержание тура идёт на витрину через
 * проверку: PATCH владельца кладёт его черновиком (lib/tours/tour-change),
 * а GET отдаёт форме «витрину плюс правку на проверке» — иначе следующее
 * сохранение формы стёрло бы черновик значениями витрины.
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
import { PHOTO_ADDRESS_TEXT, photoAddressesOf, rejectedPhotoAddresses } from '@/lib/tours/photo-address';
import { saveTourChange } from '@/lib/tours/tour-change';
import { loadOwnTourEdits } from '@/lib/tours/moderation-store';
import { tourModerationState } from '@/lib/tours/moderation';
import { editorClips, photoCreditsOf, writePhotoCredits } from '@/lib/tours/editor-media';
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

    // Правка на проверке: форма показывает то, что владелец ввёл, а не то,
    // что стоит на витрине. Не прочитали — форму не отдаём вовсе: сохранение
    // формы со значениями витрины стёрло бы черновик (§4.0).
    const edits = await loadOwnTourEdits([String(tourId)], new Map([[String(tourId), tour as Record<string, unknown>]]));
    if (edits === null) {
      return NextResponse.json({ error: 'Не удалось прочитать правку на проверке, попробуйте позже' }, { status: 503 });
    }
    const edit = edits.get(String(tourId)) ?? { pending: null, rejected: null };
    // Администратор правит саму витрину: чужой черновик в его форму не
    // подмешивается, иначе «Сохранить» записало бы правку владельца в живую
    // строку в обход очереди и без решения по ней.
    const shown = (isAdmin ? tour : { ...tour, ...(edit.pending?.patch ?? {}) }) as typeof tour;

    // Клипы — с адресами для превью в форме, подписи — только строки (08.11,
    // те же правила, что у формы гида: lib/tours/editor-media).
    return NextResponse.json({
      success: true,
      data: {
        ...shown,
        video_clips: editorClips(shown.video_clips),
        photo_credits: photoCreditsOf(tour.photo_credits),
        moderation: {
          state: tourModerationState({
            published: tour.is_published === true, pending: edit.pending !== null, rejected: edit.rejected !== null,
          }),
          published: tour.is_published === true,
          // Администратор публикует и снимает сам, владелец — через проверку.
          direct: isAdmin,
          pending: edit.pending
            ? { changes: edit.pending.changes, wantsPublish: edit.pending.wantsPublish, since: edit.pending.since }
            : null,
          rejected: edit.rejected,
        },
      },
    });
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
    // Подпись снимков — не колонка тура: она уходит в карту авторов
    // владельца тура (partners.gallery_credits), как у формы гида.
    const { photo_credit: photoCredit, ...input } = UpdateTourSchema.parse(body);

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
    // Цена сверяется с тем, что форма показала: с витриной плюс правкой на
    // проверке. Иначе менеджер без права цены не смог бы сохранить форму,
    // пока чужая правка цены ждёт администратора.
    let waitingPatch: Record<string, unknown> = {};
    if (!isAdmin) {
      const edits = await loadOwnTourEdits([String(tourId)], new Map());
      if (edits === null) {
        return NextResponse.json({ error: 'Не удалось прочитать правку на проверке, попробуйте позже' }, { status: 503 });
      }
      waitingPatch = (edits.get(String(tourId))?.pending?.patch ?? {}) as Record<string, unknown>;
      const shown = { ...(tour as Record<string, unknown>), ...waitingPatch };
      if (changesTourPrice(input, shown)) {
        const denied = await requireTeamPermission(authOrResponse.userId, 'can_edit_prices');
        if (denied) return denied;
      }
    }

    // Новый адрес снимка обязан быть снимком: путь раздачи картинок сайта или
    // https:// (lib/tours/photo-address, перепроверка 23.11). Путь вроде
    // `/api/admin/…` браузер проверяющего запросил бы сам, со своей кукой.
    // Адреса, которые уже стоят у тура или в правке на проверке, форма
    // присылает обратно при каждом сохранении — их оставляем как есть, иначе
    // тур со старым снимком нельзя было бы сохранить вовсе.
    const knownPhotos = new Set([...photoAddressesOf(tour), ...photoAddressesOf(waitingPatch)]);
    if (rejectedPhotoAddresses(photoAddressesOf(input), knownPhotos).length > 0) {
      return NextResponse.json({ error: PHOTO_ADDRESS_TEXT }, { status: 400 });
    }

    // Запись — единая дверь владельца (lib/tours/tour-change): содержание
    // идёт на проверку, остальное — сразу; администратор пишет напрямую.
    // Тем же путём тур гида правится из его кабинета и из чата. Владение
    // проверено выше и ещё раз — в самой записи. Теги — в той же транзакции.
    const saved = await transaction(async (client) => {
      const w = await saveTourChange(client, {
        tourId,
        ownerId: isAdmin ? null : operator_id,
        userId: authOrResponse.userId,
        input,
        current: tour as Record<string, unknown>,
      });
      // «Фото: <автор>» снимкам тура без подписи — в карту владельца тура
      // (у администратора тоже: снимки принадлежат партнёру, не правящему).
      // Подпись пишется и когда снимки ушли на проверку: она про снимок, а не про витрину.
      if ((w.outcome === 'written' || w.outcome === 'pending') && photoCredit && input.photos?.length && typeof tour.operator_id === 'string') {
        await writePhotoCredits(client, tour.operator_id, photoCredit, input.photos);
      }
      return w;
    });
    if (saved.outcome === 'empty') {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    if (saved.outcome === 'not_found') {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 });
    }

    // Сохранили форму без единой правки — успех, а не ошибка.
    if (saved.outcome === 'unchanged') {
      return NextResponse.json({ success: true, data: { id: String(tourId) }, pending: null, unchanged: true });
    }

    // Поисковикам сообщаем только о том, что изменилось на витрине.
    if (saved.row) pingTourChanged(tourId);

    return NextResponse.json({
      success: true,
      data: saved.row ?? { id: String(tourId) },
      pending: saved.pending
        ? { fields: saved.pending.fields, wantsPublish: saved.pending.wantsPublish, notice: saved.pending.notice }
        : null,
    });
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
