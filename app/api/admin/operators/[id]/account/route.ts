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
 * Кому: только карточкам ТУРОПЕРАТОРОВ, заведённым платформой (external_source
 * пуст или 'admin'). Два ограничения — не вкус, а две честности (ревью 07.10):
 *  - флаг force_password_change читает только кабинет оператора
 *    (ForcePasswordChangeBanner в app/hub/operator/layout.tsx); гиду или
 *    владельцу жилья кабинет сменить временный пароль не предложит — обещание
 *    «кабинет попросит сменить» было бы без производителя (§10.09);
 *  - карточки, скачанные с чужого сайта (visitkamchatka), несут чужой адрес;
 *    заводить по нему вход, которого человек не просил, нельзя — он
 *    регистрируется сам.
 *
 * Отказы: карточка не найдена — 404; аккаунт уже привязан — 409; не оператор
 * или импорт — 409; пользователь с таким email уже есть — 409 (привязать чужой
 * аккаунт к компании молча — выдать его владельцу кабинет оператора; тот же 409
 * и на гонку по UNIQUE users.email, SQLSTATE 23505); email не задан и на
 * карточке нет корректного — 400.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { hashPassword } from '@/lib/auth/password';
import { generatePassword } from '@/app/api/admin/operators/create/route';
import type { PartnerCategory } from '@/lib/partners/categories';

export const dynamic = 'force-dynamic';

const IdSchema = z.string().uuid();
const EmailSchema = z.string().trim().email('Неверный формат email').max(255, 'Email длиннее 255 символов');
const BodySchema = z.object({
  /** Email для входа; по умолчанию — из карточки (contacts.email → contact.email). */
  email: EmailSchema.optional(),
  /** Имя пользователя; по умолчанию — название карточки. */
  name: z.string().trim().min(2, 'Имя короче 2 символов').max(255, 'Имя длиннее 255 символов').optional(),
});

/** Источники карточек, которым аккаунт заводит платформа. Остальное — импорт. */
const PLATFORM_SOURCES = new Set<string | null>([null, 'admin']);

export const ONLY_OPERATOR_TEXT =
  'Аккаунт из карточки заводится только туроператору: кабинеты других ролей не просят сменить временный пароль. Для них — «Завести партнёра вручную».';
export const IMPORTED_CARD_TEXT =
  'Карточка импортирована со стороннего сайта: вход по чужому адресу не заводится, человек регистрируется сам.';
export const BAD_CARD_EMAIL_TEXT = 'На карточке нет корректного email — укажите адрес для входа';
export const EMAIL_TAKEN_TEXT = 'Пользователь с таким email уже есть. Укажите другой адрес для входа.';

interface PartnerRow {
  id: string;
  name: string;
  category: string;
  user_id: string | null;
  external_source: string | null;
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
      `SELECT id, name, category, user_id, external_source,
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

    if (partner.category !== 'operator') {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: ONLY_OPERATOR_TEXT }, { status: 409 });
    }
    if (!PLATFORM_SOURCES.has(partner.external_source)) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: IMPORTED_CARD_TEXT }, { status: 409 });
    }
    const role: PartnerCategory = 'operator';

    // Адрес с карточки — свободный текст (импорт, старые формы); правило то
    // же, что у адреса из тела, иначе заведётся вход, в который не войти.
    const emailCheck = EmailSchema.safeParse(parsedBody.data.email ?? partner.card_email ?? '');
    if (!emailCheck.success) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: BAD_CARD_EMAIL_TEXT }, { status: 400 });
    }
    const email = emailCheck.data.toLowerCase();

    const { rows: [existing] } = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email],
    );
    if (existing) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: EMAIL_TAKEN_TEXT }, { status: 409 });
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
    if (e?.code === '23505') {
      // Гонка с регистрацией на тот же адрес между SELECT и INSERT: это не
      // отказ базы, а тот же «email занят».
      return NextResponse.json({ success: false, error: EMAIL_TAKEN_TEXT }, { status: 409 });
    }
    console.error('[operator-account] аккаунт не заведён:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 500 });
  } finally {
    client.release();
  }
}
