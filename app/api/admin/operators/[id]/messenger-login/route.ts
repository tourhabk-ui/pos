/**
 * POST /api/admin/operators/[id]/messenger-login — вход на сайт через MAX или
 * Telegram владельцу карточки партнёра (владелец 26.10, прокат «Лагуны»).
 *
 * Владелец — тот, кто открыл ссылку подключения op_ в личном чате с ботом
 * (миграция 1336); правило и отказы — lib/partners/messenger-login.ts. Пароль
 * не выдаётся и не хранится: человек входит кнопкой «Войти через MAX»
 * (или Telegram) на странице входа.
 *
 * Отказы: не администратор — 401/403; карточка не найдена — 404; ссылку ещё
 * никто не открыл, аккаунт уже есть, роль не та — 409; база — 503.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { linkMessengerLogin, MESSENGER_LOGIN_REFUSAL } from '@/lib/partners/messenger-login';

export const dynamic = 'force-dynamic';

const IdSchema = z.string().uuid();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const parsedId = IdSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return NextResponse.json({ success: false, error: 'Неверный идентификатор партнёра' }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await linkMessengerLogin(client, parsedId.data);
    if (result.outcome !== 'linked') {
      await client.query('ROLLBACK');
      const status = result.outcome === 'not_found' ? 404 : 409;
      return NextResponse.json({ success: false, outcome: result.outcome, error: MESSENGER_LOGIN_REFUSAL[result.outcome] }, { status });
    }
    await client.query('COMMIT');
    const channel = result.via === 'max' ? 'MAX' : 'Telegram';
    return NextResponse.json({
      success: true,
      via: result.via,
      created: result.created,
      message: `Готово: владелец входит на сайт кнопкой «Войти через ${channel}» на странице входа — пароль не нужен.`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = err as { code?: string };
    console.error('[admin/messenger-login] вход не заведён, SQLSTATE', e?.code ?? 'нет SQLSTATE');
    return NextResponse.json(
      { success: false, error: 'База не ответила — вход не заведён. Попробуйте ещё раз.' },
      { status: 503 },
    );
  } finally {
    client.release();
  }
}
