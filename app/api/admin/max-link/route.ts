/**
 * /api/admin/max-link — MAX администратора (слово владельца 23.10: «Я админ
 * и чат должен знать что админ подключен со всеми правами»; способ «1а»).
 *
 *   GET    — подключён ли MAX у вошедшего администратора;
 *   POST   — одноразовая ссылка на 10 минут: открыть в MAX и нажать «Старт»;
 *   DELETE — отключить.
 *
 * AUTH: requireAdmin — и до любого запроса к базе. Ссылку выдаёт себе только
 * сам администратор: она назначает, какой человек MAX получит в чате права
 * администратора. Роль проверяется ещё раз в SQL выдачи (`issueAdminMaxLink`):
 * токен, выпущенный до снятия роли, ссылки не даст.
 *
 * Ссылка в ответе — ключ: ответ не кешируется, и в лог ключ не пишется.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { adminMaxStatus, issueAdminMaxLink, unbindAdminMax } from '@/lib/max/admin-link';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function failed(what: string, err: unknown): NextResponse {
  const e = err as { code?: string };
  console.error(`[admin/max-link] ${what}, SQLSTATE`, e?.code ?? 'нет SQLSTATE');
  return NextResponse.json(
    { success: false, error: 'База не ответила, попробуйте позже' },
    { status: 500, headers: NO_STORE },
  );
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const status = await adminMaxStatus(auth.userId);
    return NextResponse.json(
      { success: true, data: { bound: status.bound, bound_at: status.boundAt } },
      { headers: NO_STORE },
    );
  } catch (err) {
    return failed('состояние не прочитано', err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const res = await issueAdminMaxLink(auth.userId);
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: 'У аккаунта больше нет роли администратора' },
        { status: 403, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { success: true, data: { link: res.link, expires_at: res.expiresAt.toISOString() } },
      { headers: NO_STORE },
    );
  } catch (err) {
    return failed('ссылка не выдана', err);
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const was = await unbindAdminMax(auth.userId);
    return NextResponse.json({ success: true, data: { unbound: was } }, { headers: NO_STORE });
  } catch (err) {
    return failed('MAX не отключён', err);
  }
}
