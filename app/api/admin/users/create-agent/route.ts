/**
 * POST /api/admin/users/create-agent — администратор заводит агента.
 *
 * ── Что исправлено 26.09 ───────────────────────────────────────────────────
 * - Согласие на обработку ПД больше не выдумывается. Прежде строка писала
 *   pd_consent_at = NOW() и pd_consent_ip = '127.0.0.1' — то есть
 *   записывала согласие, которого человек не давал (152-ФЗ). Теперь оба поля
 *   NULL, пока агент не примет согласие сам.
 * - Временный пароль — crypto.randomBytes, а не Math.random.
 * - Ссылка входа — /auth/login (страницы /auth/signin нет).
 * - Запись партнёра category = 'agent' создаётся сразу (ensurePartnerForRole)
 *   и получает profile_status = 'approved': АДМИНИСТРАТОР, заводящий агента
 *   своей рукой, и есть одобрение (решение владельца 26.09 — агент работает
 *   после одобрения администратором). Без этого такой агент попал бы в
 *   очередь проверки, заведённый тем же, кто её разбирает.
 * - Отказ пишется в лог с SQLSTATE; сообщения по-русски.
 *
 * Пользователь и запись партнёра — одной транзакцией: без записи партнёра
 * кабинет агента пуст, а повтор упёрся бы в «пользователь уже существует».
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { hashPassword } from '@/lib/auth/password';

const CreateAgentSchema = z.object({
  email: z.string().email('Некорректный e-mail'),
  name: z.string().trim().min(1, 'Укажите имя').max(255),
  temporary_password: z.string().min(8, 'Пароль не короче 8 символов').max(255).optional(),
});

/** Временный пароль: 12 байт случайности, base64url без служебных символов. */
function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}

export async function POST(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });
  const parsed = CreateAgentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  const { email, name, temporary_password } = parsed.data;
  const tempPassword = temporary_password ?? generateTemporaryPassword();

  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Пользователь с таким e-mail уже существует' },
        { status: 409 },
      );
    }

    const hashedPassword = await hashPassword(tempPassword);

    await client.query('BEGIN');
    // pd_consent_at / pd_consent_ip — NULL: согласие даёт человек, а не
    // администратор за него.
    const created = await client.query<{ id: string; email: string; name: string; role: string; created_at: string }>(
      `INSERT INTO users (email, password_hash, name, role, preferences, pd_consent_at, pd_consent_ip, created_at, updated_at)
       VALUES ($1, $2, $3, 'agent', $4::jsonb, NULL, NULL, NOW(), NOW())
       RETURNING id, email, name, role, created_at`,
      [email.toLowerCase(), hashedPassword, name, JSON.stringify({ roles: ['agent'] })],
    );
    const user = created.rows[0];

    // Та же форма, что у ensurePartnerForRole (lib/auth/partner-profile.ts),
    // но на клиенте транзакции: пользователь без записи партнёра не
    // фиксируется. Создание администратором — это одобрение: 'approved'.
    const partner = await client.query<{ id: string }>(
      `INSERT INTO partners (user_id, name, category, contact, is_verified, rating, review_count,
                             profile_status, verified_at, verified_by, created_at, updated_at)
       VALUES ($1::uuid, $2, 'agent', $3::jsonb, TRUE, 0, 0, 'approved', NOW(), $4::uuid, NOW(), NOW())
       ON CONFLICT (user_id, category) DO UPDATE
         SET profile_status = 'approved', verified_at = NOW(), verified_by = EXCLUDED.verified_by, updated_at = NOW()
       RETURNING id`,
      [user.id, name, JSON.stringify({ email: user.email }), authOrResponse.userId],
    );
    await client.query('COMMIT');

    return NextResponse.json(
      {
        success: true,
        data: {
          user_id: user.id,
          partner_id: partner.rows[0]?.id ?? null,
          email: user.email,
          name: user.name,
          role: user.role,
          profile_status: 'approved',
          created_at: user.created_at,
          // Пароль отдаётся один раз: передайте его агенту защищённым каналом.
          temporary_password: tempPassword,
          login_url: '/auth/login',
        },
        message: 'Агент создан и одобрен. Передайте временный пароль защищённым каналом; согласие на обработку ПД агент примет сам.',
      },
      { status: 201 },
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const sqlstate = (err as { code?: unknown } | null)?.code;
    console.error('[admin/users/create-agent] агент не создан:',
      `sqlstate=${typeof sqlstate === 'string' ? sqlstate : 'нет'}`,
      err instanceof Error ? err.message : String(err));
    return NextResponse.json({ success: false, error: 'Не удалось создать агента' }, { status: 500 });
  } finally {
    client.release();
  }
}
