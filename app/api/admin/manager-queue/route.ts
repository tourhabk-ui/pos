/**
 * /api/admin/manager-queue — очередь менеджера (план «после отказа», этап 3б).
 *
 * GET  — три источника очереди; каждый читается сам и отдаёт свой исход:
 *        «есть», «никого нет» или «не прочитался» (§4.0).
 * POST — `{ kind, id, action }`: «взял» (`take`) или «вернуть в очередь»
 *        (`release`). Отметку ставит и снимает администратор со своим
 *        входом; кто именно — из входа, а не из тела запроса.
 *
 * Имя и телефон клиента отдаются только администратору (requireAdmin; префикс
 * /api/admin закрыт и на Edge). В лог ПД не пишутся.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';
import {
  QUEUE_KINDS, isQueueSubjectId, loadManagerQueue, releaseQueueItem, takeQueueItem,
} from '@/lib/manager-queue/queue';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  kind: z.enum(QUEUE_KINDS, { message: 'Род случая не распознан' }),
  id: z.string().min(1).max(64),
  action: z.enum(['take', 'release'], { message: 'Действие — take или release' }),
});

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ success: true, data: await loadManagerQueue() });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const admin = auth as JWTPayload;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверный запрос' }, { status: 400 });
  }
  const { kind, id, action } = parsed.data;
  if (!isQueueSubjectId(kind, id)) {
    return NextResponse.json({ success: false, error: 'Номер случая не распознан' }, { status: 400 });
  }

  // Отметку ставит и снимает человек с аккаунтом: вход по служебному ключу (CRON_SECRET) её не
  // трогает — «взял» без того, кто взял, очереди не помогает, а снятая автоматом отметка
  // вернула бы случай двум людям сразу.
  if (!UUID_RE.test(String(admin.userId ?? ''))) {
    return NextResponse.json({ success: false, error: 'Отметку «взял» ставит и снимает администратор со своим входом' }, { status: 403 });
  }

  if (action === 'release') {
    const released = await releaseQueueItem({ kind, id });
    if (released.kind === 'failed') {
      return NextResponse.json({ success: false, error: 'Не удалось снять отметку — попробуйте ещё раз' }, { status: 503 });
    }
    return NextResponse.json({ success: true, outcome: released.kind });
  }

  const taken = await takeQueueItem({ kind, id, userId: admin.userId, via: 'site' });
  if (taken.kind === 'failed') {
    return NextResponse.json({ success: false, error: 'Не удалось записать отметку — попробуйте ещё раз' }, { status: 503 });
  }
  if (taken.kind === 'not_in_queue') {
    return NextResponse.json(
      { success: false, outcome: 'not_in_queue', error: 'Этого случая в очереди уже нет: сообщение дошло или заявка изменилась. Обновите список.' },
      { status: 409 },
    );
  }
  return NextResponse.json({ success: true, outcome: taken.kind, take: taken });
}
