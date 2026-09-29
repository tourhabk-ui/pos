/**
 * POST /api/admin/operators/[id]/channel-link
 *
 * Выдать оператору ссылки «получать заявки» в Telegram и MAX (решение
 * владельца 29.09). Администратор пересылает их оператору любым способом —
 * хоть в WhatsApp; оператор жмёт «Старт», и чат записывается в карточку
 * партнёра (lib/partners/bind-channel).
 *
 * AUTH: requireAdmin. Ссылка назначает, КУДА уйдут имена и телефоны туристов,
 * — выдавать её может только администратор.
 *
 * Ответ несёт и нынешнее состояние каналов — из тех же колонок, что читает
 * доставка (partners.telegram_chat_id, partners.max_chat_id), а не из
 * contacts JSONB: иначе карточка показывала бы «подключён» там, где заявка не
 * дойдёт.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { buildPartnerChannelLinks } from '@/lib/partners/channel-link';

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
    return NextResponse.json({ success: false, error: 'Неверный идентификатор оператора' }, { status: 400 });
  }
  const id = parsedId.data;

  let row: { name: string; has_telegram: boolean; has_max: boolean } | undefined;
  try {
    ({ rows: [row] } = await pool.query<{ name: string; has_telegram: boolean; has_max: boolean }>(
      `SELECT p.name,
              (p.telegram_chat_id IS NOT NULL OR u.telegram_id IS NOT NULL) AS has_telegram,
              p.max_chat_id IS NOT NULL AS has_max
         FROM partners p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.id = $1::uuid`,
      [id],
    ));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[channel-link] оператор не прочитан:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 500 });
  }
  if (!row) return NextResponse.json({ success: false, error: 'Оператор не найден' }, { status: 404 });

  const links = buildPartnerChannelLinks(id);
  if (!links.ok) {
    console.error(`[channel-link] ссылка не выдана: ${links.reason}`);
    return NextResponse.json({
      success: false,
      error: links.reason === 'no_secret'
        ? 'На платформе не задан секрет подписи ссылок (CONNECT_TOKEN_SECRET или JWT_SECRET)'
        : 'Неверный идентификатор оператора',
    }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: {
      operator: row.name,
      bound: { telegram: row.has_telegram, max: row.has_max },
      links: { telegram: links.telegram, max: links.max },
      expires_at: links.expiresAt.toISOString(),
      // Готовый текст для пересылки оператору — без ПД, только ссылки.
      message: [
        `Здравствуйте! Чтобы заявки туристов с Ведара приходили вам в мессенджер, откройте ссылку и нажмите «Старт»:`,
        `MAX (заявки с именем и телефоном туриста): ${links.max}`,
        `Telegram (номер заявки и ссылка в кабинет): ${links.telegram}`,
        `Ссылки действуют 72 часа.`,
      ].join('\n'),
    },
  });
}
