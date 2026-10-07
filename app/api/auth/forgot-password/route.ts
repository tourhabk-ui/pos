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
 *  - письмо не ушло — 503, в лог причина без адреса. И ПЯТЬ МИНУТ после этого
 *    503 получают все, ещё до поиска пользователя: иначе при лежащей почте
 *    «существующий адрес — 503, чужой — 200» перечисляет аккаунты (ревью 07.10);
 *  - адреса нет или письмо ушло — 200 с одним и тем же телом.
 *
 * Лимиты: по IP (перебор адресов) и по адресу (засыпать чужой ящик письмами).
 * IP — доверенный (x-real-ip от прокси, потом cf-connecting-ip, XFF последним):
 * первый элемент X-Forwarded-For пишет сам клиент, и лимит по нему обходится
 * сменой заголовка (разбор 29.09, lib/rate-limit.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { emailService } from '@/lib/notifications/email-service';
import { passwordResetEmailVedar } from '@/lib/notifications/password-reset-email';
import { issuePasswordResetToken, SELF_SERVICE_TTL_MS, SELF_SERVICE_TTL_TEXT } from '@/lib/auth/password-reset';
import { redactPII } from '@/lib/security/pii-redact';

export const dynamic = 'force-dynamic';

const ipLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 5 });
const emailLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 3 });

const Schema = z.object({
  email: z.string().trim().email('Укажите email').max(255, 'Email длиннее 255 символов'),
});

/** Пауза после отказа почты: 503 всем, чтобы отказ не стал оракулом адресов. */
export const MAIL_DOWN_COOLDOWN_MS = 5 * 60_000;
/** Состояние почты — объектом, чтобы тест мог его сбросить. */
export const mailHealth = { downUntil: 0 };

export const NEUTRAL_TEXT =
  'Если на этот адрес зарегистрирован аккаунт, письмо со ссылкой для сброса уже отправлено. Проверьте почту, в том числе папку «Спам».';

export const MAIL_NOT_CONFIGURED_TEXT =
  'Отправка писем на платформе не настроена. Напишите администратору — он выдаст ссылку для сброса пароля напрямую.';

export const MAIL_DOWN_TEXT =
  'Почтовый сервер не ответил. Попробуйте позже или напишите администратору — он выдаст ссылку для сброса пароля напрямую.';

function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** Одно тело на все нейтральные исходы: неизвестный адрес, отправлено, лимит по адресу. */
function neutral() {
  return NextResponse.json({ success: true, message: NEUTRAL_TEXT });
}

export async function POST(request: NextRequest) {
  const ip = getTrustedClientIp(request.headers);
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
  if (Date.now() < mailHealth.downUntil) {
    return NextResponse.json({ success: false, error: MAIL_DOWN_TEXT }, { status: 503 });
  }

  if (!emailLimiter.check(email)) {
    // То же тело: отказ по адресу не должен выдавать, что адрес известен.
    return neutral();
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
    return neutral();
  }

  let link: string;
  try {
    ({ link } = await issuePasswordResetToken({ userId: user.id, ttlMs: SELF_SERVICE_TTL_MS }));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[forgot-password] токен не выдан:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'База не ответила, попробуйте позже' }, { status: 503 });
  }

  const mail = passwordResetEmailVedar({ userName: user.name, resetLink: link, ttlText: SELF_SERVICE_TTL_TEXT });
  const sent = await emailService.sendEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  if (!sent.success) {
    // Причина — в лог, адрес — нет (pd-guard §7): SMTP-сервер в тексте отказа
    // сам повторяет адрес получателя («550 ... <user@...>»), поэтому через redactPII.
    console.error('[forgot-password] письмо не отправлено:', redactPII(sent.error ?? 'причина не названа'));
    mailHealth.downUntil = Date.now() + MAIL_DOWN_COOLDOWN_MS;
    return NextResponse.json({ success: false, error: MAIL_DOWN_TEXT }, { status: 503 });
  }

  return neutral();
}
