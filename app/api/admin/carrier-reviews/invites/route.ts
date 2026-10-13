/**
 * POST /api/admin/carrier-reviews/invites — менеджер подтверждает, что
 * поездка по заявке на машину состоялась, и получает ссылку на отзыв для
 * заказчика (миграция 1235).
 *
 * Заявка — не поездка: машина ею не закрепляется, и состоялась ли поездка,
 * система не знает. Знает посредник по заявке — менеджер Ведара («подтверждает
 * менеджер с перевозчиком»). Его подтверждение и есть доказательство, которое
 * отзыв потом называет вслух.
 *
 * Правила (lib/transfers/carrier-review-rules, inviteIssueVerdict): дата
 * выезда наступила — подтвердить поездку, которая впереди, значит пообещать;
 * отзыва по заявке ещё нет. Ключ показывается один раз — в базе только хэш;
 * повторная выдача заменяет ключ, и прежняя ссылка перестаёт работать.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { getPublicBaseUrl } from '@/lib/config';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { issueCharterInvite } from '@/lib/transfers/carrier-reviews';
import { carrierReviewInviteUrl } from '@/lib/transfers/carrier-review-rules';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const Body = z.object({ lead_id: z.string().uuid('Некорректная заявка') });

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' }, { status: 400 });
  }

  try {
    const r = await issueCharterInvite({ leadId: parsed.data.lead_id, confirmedBy: admin.userId, today: kamchatkaToday() });
    if (!r.ok) {
      const [status, error] = {
        not_found: [404, 'Заявка на машину не найдена'],
        no_date: [409, 'В заявке нет даты выезда — подтверждать нечего'],
        not_yet: [409, 'Поездка ещё впереди: подтвердить её можно с даты выезда'],
        already_reviewed: [409, 'По этой заявке отзыв уже оставлен'],
      }[r.reason] as [number, string];
      return NextResponse.json({ success: false, error }, { status });
    }
    return NextResponse.json({
      success: true,
      data: { url: carrierReviewInviteUrl(getPublicBaseUrl(), r.slug, r.key), expires_at: r.expiresAt },
      message: 'Поездка подтверждена. Ссылка показана один раз — отправьте её заказчику.',
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[admin/carrier-reviews/invites] ссылка не выдана: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return NextResponse.json({ success: false, error: 'Не удалось выдать ссылку — сбой на нашей стороне' }, { status: 500 });
  }
}
