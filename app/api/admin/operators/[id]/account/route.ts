/**
 * POST /api/admin/operators/[id]/account — завести аккаунт карточке партнёра.
 *
 * Для карточек, заведённых БЕЗ пользователя (миграция 1174, «Край Вулканов»):
 * операторов, которых платформа заводит сама по решению владельца, а не через
 * самостоятельную регистрацию.
 *
 * Что делается одной транзакцией:
 *  - пользователь с временным паролем (generatePassword из admin/operators/
 *    create — то же правило, что у ручного заведения партнёра) и флагом
 *    force_password_change — кабинет попросит сменить;
 *  - привязка partners.user_id. Именно ОДНОЙ транзакцией: если оператор войдёт
 *    раньше, чем карточка привязана, getOperatorPartnerId заведёт ему
 *    дубль-оператора, и туры лягут не в ту карточку.
 *
 * Пароль отдаётся ОДИН раз тому, кто прошёл requireAdmin: не хранится, не
 * пишется в лог, не уходит письмом (SMTP может быть не настроен — тогда
 * «отправлено» было бы ложью). Согласие на ПД не записывается: его даёт сам
 * человек, администратор за него не может (pd-guard §6).
 *
 * Отказы: карточка не найдена — 404; аккаунт уже привязан — 409; пользователь
 * с таким email уже есть — 409 (привязать чужой аккаунт к компании молча —
 * выдать его владельцу кабинет оператора); email не задан и на карточке его
 * нет — 400.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { hashPassword } from '@/lib/auth/password';
import { generatePassword } from '@/app/api/admin/operators/create/route';
import { PARTNER_CATEGORIES } from '@/lib/partners/categories';
import type { PartnerCategory } from '@/lib/partners/categories';

export const dynamic = 'force-dynamic';

const IdSchema = z.string().uuid();
const BodySchema = z.object({
  /** Email для входа; по умолчанию — из карточки (contacts.email → contact.email). */
  email: z.string().trim().email('Неверный формат email').max(255).optional(),
  /** Имя пользователя; по умолчанию — название карточки. */
  name: z.string().trim().min(2).max(255).optional(),
});

interface PartnerRow {
  id: string;
  name: string;
  category: string;
  user_id: string | null;
  card_email: string | null;
}

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
  const parsedBody = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedBody.success) {
    return NextResponse.json(
      { success: false, error: parsedBody.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const id = parsedId.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [partner] } = await client.query<PartnerRow>(
      `SELECT id, name, category, user_id,
              NULLIF(TRIM(COALESCE(contacts->>'email', contact->>'email', '')), '') AS card_email
         FROM partners
        WHERE id = $1::uuid
        FOR UPDATE`,
      [id],
    );
    if (!partner) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Партнёр не найден' }, { status: 404 });
    }
    if (partner.user_id) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { success: false, error: 'У этой карточки уже есть аккаунт. Для нового пароля выдайте ссылку сброса.' },
        { status: 409 },
      );
    }

    const email = (parsedBody.data.email ?? partner.card_email ?? '').toLowerCase();
    if (!email) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { success: false, error: 'На карточке нет email — укажите адрес для входа' },
        { status: 400 },
      );
    }
    if (!(PARTNER_CATEGORIES as readonly string[]).includes(partner.category)) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { success: false, error: `Категория карточки «${partner.category}» не является ролью пользователя` },
        { status: 409 },
      );
    }
    const role = partner.category as PartnerCategory;

    const { rows: [existing] } = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email],
    );
    if (existing) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { success: false, error: 'Пользователь с таким email уже есть. Укажите другой адрес для входа.' },
        { status: 409 },
      );
    }

    const oneTimePassword = generatePassword();
    const { rows: [user] } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, role, preferences, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
       RETURNING id`,
      [
        email,
        await hashPassword(oneTimePassword),
        parsedBody.data.name ?? partner.name,
        role,
        JSON.stringify({ roles: [role], force_password_change: true }),
      ],
    );

    const linked = await client.query(
      `UPDATE partners SET user_id = $1::uuid, updated_at = NOW()
        WHERE id = $2::uuid AND user_id IS NULL`,
      [user.id, id],
    );
    if (linked.rowCount !== 1) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Карточка не привязана: её уже кто-то привязал' }, { status: 409 });
    }

    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      data: {
        userId: user.id,
        email,
        // Один раз, только администратору. Нигде не хранится.
        oneTimePassword,
        loginUrl: '/auth/login',
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const e = err as { message?: string; code?: string };
    console.error('[operator-account] аккаунт не заведён:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 500 });
  } finally {
    client.release();
  }
}
