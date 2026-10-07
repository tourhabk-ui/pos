/**
 * POST /api/auth/forgot-password — «Забыли пароль?».
 *
 * Публичный вход (префикс /api/auth открыт на Edge). Ответ НЕЙТРАЛЬНЫЙ: есть
 * такой email или нет — текст один и тот же, иначе форма превращается в
 * перечисление аккаунтов платформы.
 *
 * Три исхода, не два (§4.0):
 *  - SMTP не настроен — 503 с честным текстом ДО поиска пользователя:
 *    «письмо отправлено, если адрес есть» при выключенной почте — ложь, и это
 *    состояние платформы, а не аккаунта, перечислить по нему ничего нельзя;
 *  - письмо не ушло — 503, в лог причина без адреса;
 *  - адреса нет или письмо ушло — 200 с одним текстом.
 *
 * Лимиты: по IP (перебор адресов) и по адресу (засыпать чужой ящик письмами).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { emailService } from '@/lib/notifications/email-service';
import { passwordResetEmailVedar } from '@/lib/notifications/password-reset-email';
import { issuePasswordResetToken, SELF_SERVICE_TTL_MS } from '@/lib/auth/password-reset';

export const dynamic = 'force-dynamic';

const ipLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 5 });
const emailLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 3 });

const Schema = z.object({
  email: z.string().trim().email('Укажите email').max(255),
});

export const NEUTRAL_TEXT =
  'Если на этот адрес зарегистрирован аккаунт, письмо со ссылкой для сброса уже отправлено. Проверьте почту, в том числе папку «Спам».';

export const MAIL_NOT_CONFIGURED_TEXT =
  'Отправка писем на платформе не настроена. Напишите администратору — он выдаст ссылку для сброса пароля напрямую.';

function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!ipLimiter.check(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много запросов. Попробуйте через 15 минут.' },
      { status: 429 },
    );
  }

  const parsed = Schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const email = parsed.data.email.toLowerCase();

  if (!mailConfigured()) {
    return NextResponse.json({ success: false, error: MAIL_NOT_CONFIGURED_TEXT }, { status: 503 });
  }

  if (!emailLimiter.check(email)) {
    // Тот же нейтральный текст: отказ по адресу не должен выдавать, что адрес
    // известен платформе.
    return NextResponse.json({ success: true, message: NEUTRAL_TEXT });
  }

  let user: { id: string; name: string } | undefined;
  try {
    ({ rows: [user] } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE email = $1 AND is_active IS DISTINCT FROM FALSE LIMIT 1`,
      [email],
    ));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[forgot-password] пользователь не прочитан:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 503 });
  }

  if (!user) {
    return NextResponse.json({ success: true, message: NEUTRAL_TEXT });
  }

  let link: string;
  try {
    ({ link } = await issuePasswordResetToken({ userId: user.id, ttlMs: SELF_SERVICE_TTL_MS }));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[forgot-password] токен не выдан:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 503 });
  }

  const mail = passwordResetEmailVedar({ userName: user.name, resetLink: link, ttlText: 'один час' });
  const sent = await emailService.sendEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  if (!sent.success) {
    // Причина — в лог, адрес — нет (pd-guard §7).
    console.error('[forgot-password] письмо не отправлено:', sent.error ?? 'причина не названа');
    return NextResponse.json(
      { success: false, error: 'Почтовый сервер не ответил. Попробуйте позже или напишите администратору.' },
      { status: 503 },
    );
  }

  return NextResponse.json({ success: true, message: NEUTRAL_TEXT });
}
