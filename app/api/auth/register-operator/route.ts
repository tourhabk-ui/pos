import { NextRequest, NextResponse } from 'next/server';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { hashPassword, passwordSchema } from '@/lib/auth/password';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { emailService } from '@/lib/notifications/email-service';
import {
  PARTNER_CATEGORIES,
  LEGACY_CATEGORY_ALIASES,
  normalizePartnerCategory,
  initialPartnerRating,
} from '@/lib/partners/categories';
import { escapeHtml } from '@/lib/text/escape-html';
import { ROLE_HUB } from '@/lib/auth/role-routes';

/** Кто зарегистрировался — словом для писем. */
const PARTNER_KIND_WORDS: Record<string, string> = {
  operator: 'туроператор', guide: 'гид', transfer: 'перевозчик', agent: 'турагент', stay: 'владелец жилья', gear: 'прокат снаряжения',
};

async function notifyAdminTelegram(companyName: string, contactName: string, phone: string, email: string, partnerId: string) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !token) return;
  const text = `Новая заявка оператора\n\nКомпания: ${companyName}\nКонтакт: ${contactName}\nТел: ${phone}\nEmail: ${email}\n\nhttps://vedarai.ru/hub/admin/operators`;
  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
  void partnerId;
}

// Категории — из общего справочника. Раньше здесь стоял свой список с
// `hotel`, `rent` и `fishing`: таких значений нет ни в PARTNER_ROLES, ни в
// карте кабинетов, ни в CHECK колонки `partners.category`. Три варианта из
// шести отдавали отказ базы при отправке формы. Старые значения принимаем и
// переводим в канонические, чтобы открытая вкладка не превратилась в ошибку.
const ACCEPTED_CATEGORIES = [
  ...PARTNER_CATEGORIES,
  ...Object.keys(LEGACY_CATEGORY_ALIASES),
] as [string, ...string[]];

const Schema = z.object({
  companyName:  z.string().min(2, 'Название компании обязательно'),
  category:     z.enum(ACCEPTED_CATEGORIES),
  description:  z.string().max(500).optional().default(''),
  contactName:  z.string().min(2, 'Имя контактного лица обязательно'),
  phone:        z.string().min(10, 'Укажите телефон'),
  email:        z.string().email('Неверный формат email'),
  password:     passwordSchema,
  pd_consent:   z.literal(true, { message: 'Необходимо согласие на обработку ПД' }),
});

function getJWTSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return new TextEncoder().encode(secret);
}

const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!limiter.check(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много попыток. Попробуйте позже.' },
      { status: 429 }
    );
  }

  let client;
  try {
    const body = await request.json();
    const parsed = Schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' },
        { status: 400 }
      );
    }

    const { companyName, category: categoryRaw, description, contactName, phone, email, password } = parsed.data;

    const category = normalizePartnerCategory(categoryRaw);
    if (!category) {
      return NextResponse.json(
        { success: false, error: 'Неизвестная категория партнёра' },
        { status: 400 }
      );
    }

    client = await pool.connect();

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Пользователь с таким email уже существует' },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);

    await client.query('BEGIN');

    // Роль — из выбранной категории, а не всегда 'operator'. Прежде гид,
    // трансферник и владелец жилья получали роль оператора и, соответственно,
    // чужой кабинет: партнёрская запись заводилась правильной категории, а
    // пользователь попадал не туда, где его данные.
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, name, role, preferences, pd_consent_at, pd_consent_ip, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), $6, NOW(), NOW())
       RETURNING id, email, name, role`,
      [email.toLowerCase(), passwordHash, contactName, category, JSON.stringify({ roles: [category] }), ip]
    );
    const user = userResult.rows[0];

    const contact = JSON.stringify({ name: contactName, phone, email });
    const partnerResult = await client.query(
      `INSERT INTO partners (
         user_id, name, company_name, category, description, short_description,
         contact, contacts, is_public, is_verified, rating,
         profile_status, applied_at,
         created_at, updated_at
       )
       VALUES ($1,$2,$2,$3,$4,$4,$5::jsonb,$5::jsonb,false,false,$6::numeric,'pending',NOW(),NOW(),NOW())
       RETURNING id, slug`,
      [user.id, companyName, category, description || companyName, contact, initialPartnerRating(category)]
    );
    const partner = partnerResult.rows[0];

    // Audit trail
    await client.query(
      `INSERT INTO operator_applications
         (partner_id, user_id, company_name, contact_phone, contact_email, description)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [partner.id, user.id, companyName, phone, email, description || '']
    );

    await client.query('COMMIT');

    // JWT cookie
    // Роль в токене — та же, что записана (05.11): прежде гид, зарегистрированный
    // здесь, получал в токене и ответе «operator», а в базе — «guide».
    const token = await new SignJWT({ userId: user.id, email: user.email, role: user.role, roles: [user.role] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(getJWTSecret());

    // Уведомления админу (fire-and-forget)
    notifyAdminTelegram(companyName, contactName, phone, email, partner.id).catch(() => {});
    const adminEmail = process.env.SMTP_USER;
    const kind = PARTNER_KIND_WORDS[category] ?? 'партнёр';
    if (adminEmail) {
      emailService.sendEmail({
        to: adminEmail,
        subject: `Новый ${kind}: ${companyName}`,
        html: `<p>Зарегистрировался новый ${escapeHtml(kind)}.</p>
               <p><b>Название:</b> ${escapeHtml(companyName)}<br>
               <b>Категория:</b> ${escapeHtml(category)}<br>
               <b>Контакт:</b> ${escapeHtml(contactName)}, ${escapeHtml(phone)}<br>
               <b>Email:</b> ${escapeHtml(email)}</p>
               <p><a href="https://vedarai.ru/hub/admin/operators">Очередь заявок →</a></p>`,
      }).catch((err: unknown) => console.error('[register-operator] письмо админу не ушло:', err instanceof Error ? err.message.slice(0, 120) : String(err)));
    }

    // Приветственное письмо — по роли (05.11). Прежнее звало каждого в кабинет
    // оператора и обещало «комиссию 15%» и «выплаты по пятницам»: ставку
    // назначает владелец (10%), а приём оплаты выключен с 05.10.
    const hub = ROLE_HUB[category] ?? '/hub/operator';
    const firstStep = category === 'guide'
      ? 'В разделе «Свои туры» нажмите «Новый тур» — или напишите боту в MAX «новый тур: …»'
      : 'Добавьте первый тур или услугу в кабинете';
    emailService.sendEmail({
      to: email,
      subject: `Добро пожаловать на Ведар, ${companyName}!`,
      html: `
        <h2>Ваш кабинет на Ведаре открыт</h2>
        <p>Здравствуйте, ${escapeHtml(contactName)}!</p>
        <p>${escapeHtml(companyName)} — ${escapeHtml(kind)} на Ведаре, туристической платформе Камчатки.</p>
        <h3>Следующие шаги:</h3>
        <ol>
          <li><a href="https://vedarai.ru${hub}">Войдите в личный кабинет</a></li>
          <li>${escapeHtml(firstStep)}</li>
          <li>Откройте даты, когда тур идёт</li>
          <li>Опубликуйте — и туристы увидят его в каталоге</li>
        </ol>
        <p>Вопросы? Пишите: <a href="mailto:${adminEmail ?? 'info@vedarai.ru'}">${adminEmail ?? 'info@vedarai.ru'}</a></p>
        <hr>
        <p style="color:#888;font-size:12px">Ведар — vedarai.ru</p>
      `,
    }).catch((err: unknown) => console.error('[register-operator] приветственное письмо не ушло:', err instanceof Error ? err.message.slice(0, 120) : String(err)));

    const response = NextResponse.json({
      success: true,
      message: 'Регистрация успешна. Ваш кабинет активирован.',
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    }, { status: 201 });

    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    return response;

  } catch {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json(
      { success: false, error: 'Ошибка регистрации. Попробуйте позже.' },
      { status: 500 }
    );
  } finally {
    client?.release();
  }
}
