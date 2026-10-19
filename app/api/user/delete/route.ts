/**
 * POST /api/user/delete
 *
 * 152-ФЗ: удаление аккаунта и отзыв согласия на обработку ПД — сразу, а не
 * отметкой «через 30 дней» без исполнителя. Что стирается и что
 * обезличивается — lib/account/erase.ts.
 *
 * Тело: { confirm: true, phrase: 'УДАЛИТЬ', mode?: 'delete' | 'revoke_consent', reason? }.
 * Отказ 409 — есть предстоящая заявка или незакрытая регистрация маршрута.
 * Auth: текущий пользователь. Админа так не удалить — роль снимается вручную.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { eraseUser, findEraseBlockers, ERASE_PHRASE } from '@/lib/account/erase';

export const dynamic = 'force-dynamic';

const DELETE_PHRASE = ERASE_PHRASE;

const Schema = z.object({
  confirm: z.literal(true, { message: 'Требуется подтверждение' }),
  phrase: z.string().trim(),
  mode: z.enum(['delete', 'revoke_consent']).optional(),
  reason: z.string().max(500).optional(),
});

const BLOCKER_TEXT: Record<string, string> = {
  upcoming_booking: 'У вас есть предстоящая заявка на тур. Отмените её или дождитесь поездки — оператор ждёт вас по этим контактам.',
  active_route_registration: 'У вас есть незакрытая регистрация маршрута в «Контрольном сроке». Отметьте возвращение или отмените её.',
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.userId;

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parse = Schema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ success: false, error: parse.error.issues[0]?.message ?? 'Ошибка валидации' }, { status: 422 });
  }
  if (parse.data.phrase.toUpperCase() !== DELETE_PHRASE) {
    return NextResponse.json({ success: false, error: `Введите слово ${DELETE_PHRASE} для подтверждения` }, { status: 422 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
    if (!rows[0]) return NextResponse.json({ success: false, error: 'Пользователь не найден' }, { status: 404 });
    if (rows[0].role === 'admin') {
      return NextResponse.json({ success: false, error: 'Аккаунт администратора так не удаляется' }, { status: 403 });
    }

    await client.query('BEGIN');
    // Блокировка строки: две вкладки не сотрут аккаунт дважды, а новая
    // заявка не проскочит между проверкой и стиранием.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const blockers = await findEraseBlockers(client, userId);
    if (blockers.length > 0) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { success: false, error: blockers.map((b) => BLOCKER_TEXT[b]).join(' '), blockers },
        { status: 409 },
      );
    }
    const counts = await eraseUser(client, userId, parse.data.mode === 'revoke_consent' ? 'consent_revoked' : 'account_deleted');
    await client.query('COMMIT');
    console.info('[user/delete] аккаунт обезличен', JSON.stringify(counts));

    const res = NextResponse.json({ success: true, message: 'Аккаунт удалён, персональные данные стёрты.' });
    res.cookies.set('auth_token', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 0, path: '/' });
    return res;
  } catch (error) {
    await client.query('ROLLBACK').catch((err) => logSwallowedFailure('user/delete', 'ROLLBACK', err));
    const e = error as { message?: string; code?: string };
    console.error('[user/delete] не выполнено:', e?.message ?? 'ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Не удалось удалить аккаунт. Попробуйте позже.' }, { status: 500 });
  } finally {
    client.release();
  }
}
