/**
 * Принять приглашение в команду оператора (CRM фаза 2г, миграция 1223).
 *
 * GET  — что за приглашение: оператор, подпись, права, срок;
 * POST — принять: человек становится менеджером кабинета. Дальше браузер
 *        переключает роль обычным /api/auth/switch-role.
 *
 * Нужен вход любой ролью (requireAuth): приглашение принимает аккаунт, а
 * ссылку владелец пересылает «любым способом» (решение 11.10). Использованная
 * ссылка неотличима от выдуманной — 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { acceptInvite, previewInvite } from '@/lib/operators/team';

export const dynamic = 'force-dynamic';

const GONE: Record<'invalid' | 'expired' | 'own_cabinet' | 'already_member', { status: number; error: string }> = {
  invalid: { status: 404, error: 'Ссылка недействительна или уже использована — попросите у оператора новую' },
  expired: { status: 410, error: 'Срок ссылки истёк — попросите у оператора новую' },
  own_cabinet: {
    status: 409,
    error: 'У этого аккаунта свой кабинет оператора. Менеджером другого оператора можно стать с другого аккаунта.',
  },
  already_member: {
    status: 409,
    error: 'Вы уже менеджер в команде оператора. Чтобы перейти в другую, попросите прежнего владельца снять вас.',
  },
};

function dbFailure(where: string, err: unknown): NextResponse {
  const code = (err as { code?: string } | null)?.code ?? '?';
  console.error(`[team/join] ${where} (SQLSTATE ${code}):`, err instanceof Error ? err.message : err);
  return NextResponse.json({ success: false, error: 'Приглашение не проверено: база не ответила. Попробуйте позже.' }, { status: 503 });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { token } = await params;
  try {
    const preview = await previewInvite(token);
    if (preview.state !== 'ok') {
      const g = GONE[preview.state];
      return NextResponse.json({ success: false, error: g.error }, { status: g.status });
    }
    return NextResponse.json({
      success: true,
      data: { operator_name: preview.operator_name, label: preview.label, expires_at: preview.expires_at, perms: preview.perms },
    });
  } catch (err) {
    return dbFailure('просмотр', err);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { token } = await params;
  try {
    const res = await acceptInvite(token, auth.userId);
    if (res.outcome !== 'ok') {
      const g = GONE[res.outcome];
      return NextResponse.json({ success: false, error: g.error }, { status: g.status });
    }
    return NextResponse.json({ success: true, data: { operator_name: res.operatorName } });
  } catch (err) {
    return dbFailure('принятие', err);
  }
}
