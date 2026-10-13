/**
 * GET /api/admin/carrier-reviews — отзывы о перевозчиках и заявки на машину
 * для менеджера (миграция 1235).
 *
 * Две части экрана — две части одной работы: по заявке, поездка которой
 * состоялась, менеджер выдаёт ссылку на отзыв; пришедшие отзывы он же
 * модерирует. Части читаются независимо: отказ одной не прячет другую и не
 * выдаётся за «пусто».
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { listCarrierReviewsForAdmin, listCharterLeadsForAdmin } from '@/lib/transfers/carrier-reviews';
import { inviteIssueVerdict, isoDateOrNull, reviewProofLine } from '@/lib/transfers/carrier-review-rules';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const Query = z.object({ filter: z.enum(['all', 'visible', 'hidden']).default('all') });

function logFailure(what: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `[admin/carrier-reviews] ${what}: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
    logText(err instanceof Error ? err.message : err, 200),
  );
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Некорректные параметры' }, { status: 400 });

  const [reviews, charters] = await Promise.allSettled([
    listCarrierReviewsForAdmin(parsed.data.filter),
    listCharterLeadsForAdmin(),
  ]);
  if (reviews.status === 'rejected') logFailure('отзывы не прочитаны', reviews.reason);
  if (charters.status === 'rejected') logFailure('заявки не прочитаны', charters.reason);

  // Можно ли подтвердить поездку — тем же правилом, что проверит выдача
  // ссылки: экран не обещает кнопку, которую сервер потом отклонит.
  const today = kamchatkaToday();
  return NextResponse.json({
    success: true,
    data: {
      reviews: reviews.status === 'fulfilled'
        ? {
          state: 'ok',
          items: reviews.value.map((r) => ({
            ...r,
            proof_line: reviewProofLine({ proof: r.proof, rideDate: r.ride_date, rideFrom: r.ride_from, rideTo: r.ride_to }),
          })),
        }
        : { state: 'failed' },
      charters: charters.status === 'fulfilled'
        ? {
          state: 'ok',
          items: charters.value.map((l) => ({
            ...l,
            issue: inviteIssueVerdict({ dateFrom: isoDateOrNull(l.date_from), reviewed: l.review_id !== null }, today),
          })),
        }
        : { state: 'failed' },
    },
  });
}
