/**
 * POST /api/admin/operators/create — админ заводит партнёра сам.
 *
 * Зачем отдельный путь, когда есть самостоятельная регистрация:
 *
 * 1. `/api/partners/register` требует ИНН, юридический адрес, БИК и расчётный
 *    счёт. Физлицо, которое возит экскурсии и трансфер само, этого не заполнит —
 *    у него нет расчётного счёта. Регистрация для него закрыта.
 * 2. `/api/auth/register-operator` требует, чтобы партнёр сам пришёл на сайт и
 *    придумал пароль. Партнёра, который живёт в телеграме, туда не затащить.
 *
 * Что создаётся: пользователь + партнёрская запись на КАЖДУЮ выбранную
 * категорию. Один человек с экскурсиями и трансфером — две записи под одним
 * user_id, ровно как это устроено в `ensurePartnerForRole`.
 *
 * Пароль генерируется здесь и показывается администратору РОВНО ОДИН РАЗ.
 * Мы его не храним и не отправляем письмом: SMTP может быть не настроен, и
 * тогда «приглашение отправлено» было бы враньём. Партнёр меняет пароль сам
 * через /api/auth/change-password, а после привязки телеграма может входить
 * по magic-ссылке из бота.
 *
 * Записи создаются НЕПОДТВЕРЖДЁННЫМИ (`is_verified = false`, `is_public =
 * false`): администратор завёл контакт, а не выдал допуск к витрине. Публикация —
 * отдельное осознанное действие через существующий verify.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { hashPassword } from '@/lib/auth/password';
import { slugify } from '@/lib/text/slugify';
import { PARTNER_CATEGORIES, PARTNER_CATEGORY_LABELS } from '@/lib/partners/categories';
import type { PartnerCategory } from '@/lib/partners/categories';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  /** Имя партнёра: для физлица — ФИО, для компании — название. */
  name:        z.string().min(2, 'Укажите имя или название').max(255),
  categories:  z.array(z.enum(PARTNER_CATEGORIES as unknown as [PartnerCategory, ...PartnerCategory[]]))
                 .min(1, 'Выберите хотя бы одну категорию'),
  contactName: z.string().min(2, 'Укажите контактное лицо').max(255),
  phone:       z.string().min(10, 'Укажите телефон').max(32),
  email:       z.string().email('Неверный формат email'),
  description: z.string().max(2000).optional().default(''),
  /** Физлицо / ИП / ООО — влияет только на то, что видит администратор. */
  businessType: z.enum(['individual', 'ip', 'ooo', 'other']).default('individual'),
});

/**
 * Пароль для первого входа. Без похожих символов (0/O, 1/l/I): его диктуют
 * голосом по телефону, и «единица или эль» — реальная потеря времени.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(14);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export async function POST(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const parsed = Schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  const { name, categories, contactName, phone, email, description, businessType } = parsed.data;
  const emailLower = email.toLowerCase().trim();
  const uniqueCategories = [...new Set(categories)];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Пользователь может уже существовать — тогда доводим его до партнёра, а не
    // отказываем: администратор заводит УСЛУГУ, а не второй аккаунт человеку.
    const found = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [emailLower],
    );

    let userId: string;
    let password: string | null = null;

    if (found.rows.length > 0) {
      userId = found.rows[0].id;
    } else {
      password = generatePassword();
      const created = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, role, preferences, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
         RETURNING id`,
        [
          emailLower,
          await hashPassword(password),
          contactName,
          uniqueCategories[0],
          JSON.stringify({ roles: uniqueCategories }),
        ],
      );
      userId = created.rows[0].id;
    }

    const contact = { name: contactName, phone, email: emailLower };
    const createdPartners: Array<{ id: string; category: string; label: string }> = [];
    const skipped: string[] = [];

    for (const category of uniqueCategories) {
      const exists = await client.query<{ id: string }>(
        'SELECT id FROM partners WHERE user_id = $1 AND category = $2 LIMIT 1',
        [userId, category],
      );
      if (exists.rows.length > 0) {
        // Не молчим и не переписываем чужие данные: администратор должен
        // увидеть, что такая услуга у этого человека уже заведена.
        skipped.push(PARTNER_CATEGORY_LABELS[category]);
        continue;
      }

      const row = await client.query<{ id: string }>(
        `INSERT INTO partners (
           user_id, name, company_name, category, description, contact, contacts,
           legal_info, slug, is_verified, is_public, profile_status,
           external_source, created_at, updated_at
         )
         VALUES ($1, $2, $2, $3, $4, $5::jsonb, $5::jsonb,
                 $6::jsonb, $7, false, false, 'pending',
                 'admin', NOW(), NOW())
         RETURNING id`,
        [
          userId,
          name,
          category,
          description || name,
          JSON.stringify(contact),
          JSON.stringify({ businessType }),
          `${slugify(name)}-${category}`,
        ],
      );
      createdPartners.push({
        id: row.rows[0].id,
        category,
        label: PARTNER_CATEGORY_LABELS[category],
      });
    }

    if (createdPartners.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { success: false, error: `Партнёр с такими услугами уже заведён: ${skipped.join(', ')}` },
        { status: 409 },
      );
    }

    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      data: {
        userId,
        partners: createdPartners,
        skipped,
        // Пароль отдаётся ОДИН раз и только тому, кто уже прошёл requireAdmin.
        // null означает, что пользователь существовал раньше и пароль у него свой.
        oneTimePassword: password,
        email: emailLower,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    const msg = e instanceof Error ? e.message : 'Ошибка создания партнёра';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
