/**
 * API endpoint для регистрации нового партнера (юридическая форма, 152-ФЗ)
 * POST /api/partners/register
 *
 * Создаёт users-аккаунт (пароль — единый lib/auth/password) и партнёрский
 * профиль с привязкой partners.user_id в одной транзакции; выдаёт JWT-cookie.
 */

import { NextRequest, NextResponse } from 'next/server';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { query } from '@/lib/database';
import { hashPassword } from '@/lib/auth/password';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

// Валидация входных данных
const registerSchema = z.object({
  // Тип бизнеса
  businessType: z.enum(['individual', 'ip', 'ooo', 'other']),

  // Юридические данные
  companyName: z.string().min(2, 'Наименование должно быть минимум 2 символа'),
  tradeName: z.string().optional(),
  inn: z.string().min(10, 'Некорректный ИНН').max(12),
  ogrn: z.string().optional(),
  kpp: z.string().optional(),
  legalAddress: z.string().min(10, 'Введите юридический адрес'),
  actualAddress: z.string().optional(),

  // Контактные данные
  contactPerson: z.string().min(2, 'Введите ФИО контактного лица'),
  contactPosition: z.string().optional(),
  email: z.string().email('Неверный формат email'),
  phone: z.string().min(10, 'Неверный формат телефона'),
  website: z.string().url().optional().or(z.literal('')),

  // Банковские реквизиты
  bankName: z.string().min(2, 'Введите наименование банка'),
  bik: z.string().length(9, 'БИК должен содержать 9 цифр'),
  correspondentAccount: z.string().length(20, 'Корр. счет должен содержать 20 цифр'),
  checkingAccount: z.string().length(20, 'Расчетный счет должен содержать 20 цифр'),

  // Направления деятельности
  roles: z.array(z.enum(['operator', 'transfer', 'stay', 'gear', 'guide'])).min(1, 'Выберите хотя бы одну роль'),
  tourRegistryNumber: z.string().optional(),
  hasFinancialGuarantee: z.boolean().optional(),

  // Дополнительно
  description: z.string().optional(),
  logoUrl: z.string().url().optional().or(z.literal('')),

  // Согласия (обязательные)
  agreePersonalData: z.literal(true, { errorMap: () => ({ message: 'Необходимо согласие на обработку персональных данных' }) }),
  agreeUserAgreement: z.literal(true, { errorMap: () => ({ message: 'Необходимо согласие с пользовательским соглашением' }) }),
  agreeOffer: z.literal(true, { errorMap: () => ({ message: 'Необходимо согласие с офертой' }) }),
  agreeCommission: z.literal(true, { errorMap: () => ({ message: 'Необходимо согласие с условиями комиссии 10%' }) }),
  agreeNotifications: z.boolean().optional(),

  // Пароль
  password: z.string().min(8, 'Пароль должен быть минимум 8 символов'),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Пароли не совпадают',
  path: ['confirmPassword'],
});

export const dynamic = 'force-dynamic';

function getJWTSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return new TextEncoder().encode(secret);
}

// PUBLIC: registration endpoint intentionally public for new partner sign-up
const partnerRegisterLimiter = createRateLimiter({ windowMs: 60_000, max: 3 });

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!partnerRegisterLimiter.check(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много попыток регистрации. Попробуйте позже.' },
      { status: 429 }
    );
  }

  let client;

  try {
    const body = await request.json();

    // Валидация
    const validationResult = registerSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Ошибка валидации',
          details: validationResult.error.issues
        },
        { status: 400 }
      );
    }

    const data = validationResult.data;
    const emailLower = data.email.toLowerCase();
    const primaryRole = data.roles[0];

    client = await pool.connect();

    // Дубли: аккаунт с таким email или партнёр с таким ИНН
    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [emailLower]
    );
    if (existingUser.rows.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Пользователь с таким email уже существует' },
        { status: 409 }
      );
    }

    const existingPartner = await client.query(
      `SELECT id FROM partners
       WHERE contact->>'email' = $1
          OR legal_info->>'inn' = $2`,
      [emailLower, data.inn]
    );
    if (existingPartner.rows.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Партнер с таким email или ИНН уже зарегистрирован' },
        { status: 409 }
      );
    }

    // Пароль — единым методом платформы (bcrypt-совместимый lib/auth/password)
    const passwordHash = await hashPassword(data.password);

    // Формируем данные для сохранения
    const contact = {
      person: data.contactPerson,
      position: data.contactPosition || '',
      email: emailLower,
      phone: data.phone,
      website: data.website || '',
    };

    const legalInfo = {
      businessType: data.businessType,
      companyName: data.companyName,
      tradeName: data.tradeName || data.companyName,
      inn: data.inn,
      ogrn: data.ogrn || '',
      kpp: data.kpp || '',
      legalAddress: data.legalAddress,
      actualAddress: data.actualAddress || data.legalAddress,
    };

    const bankDetails = {
      bankName: data.bankName,
      bik: data.bik,
      correspondentAccount: data.correspondentAccount,
      checkingAccount: data.checkingAccount,
    };

    const now = new Date().toISOString();
    const consents = {
      personalData: { agreed: true, timestamp: now, ip },
      userAgreement: { agreed: true, timestamp: now },
      offer: { agreed: true, timestamp: now },
      commission: { agreed: true, rate: 10, timestamp: now },
      notifications: { agreed: data.agreeNotifications || false, timestamp: now },
    };

    const operatorInfo = data.roles.includes('operator') ? {
      tourRegistryNumber: data.tourRegistryNumber || '',
      hasFinancialGuarantee: data.hasFinancialGuarantee || false,
    } : null;

    await client.query('BEGIN');

    // Аккаунт: главная роль — первая из выбранных, весь список — в preferences
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, name, role, preferences, pd_consent_at, pd_consent_ip, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), $6, NOW(), NOW())
       RETURNING id, email, name, role`,
      [emailLower, passwordHash, data.contactPerson, primaryRole, JSON.stringify({ roles: data.roles }), ip]
    );
    const user = userResult.rows[0];

    // Партнёрский профиль, привязанный к аккаунту
    const partnerResult = await client.query(
      `INSERT INTO partners (
        user_id,
        name,
        category,
        description,
        contact,
        legal_info,
        bank_details,
        consents,
        operator_info,
        roles,
        is_verified,
        is_public,
        profile_status,
        applied_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, false, false, 'pending', NOW(), NOW(), NOW())
      RETURNING id`,
      [
        user.id,
        data.tradeName || data.companyName,
        primaryRole,
        data.description || '',
        JSON.stringify(contact),
        JSON.stringify(legalInfo),
        JSON.stringify(bankDetails),
        JSON.stringify(consents),
        operatorInfo ? JSON.stringify(operatorInfo) : null,
        JSON.stringify(data.roles),
      ]
    );
    const partnerId = partnerResult.rows[0].id;

    await client.query('COMMIT');

    // Логируем регистрацию для аудита (152-ФЗ); сбой аудита не блокирует ответ
    await query(
      `INSERT INTO audit_log (entity_type, entity_id, action, data, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        'partner',
        partnerId,
        'register',
        JSON.stringify({ email: emailLower, inn: data.inn, roles: data.roles, consents }),
        ip,
      ]
    ).catch(() => {});

    // JWT cookie — партнёр сразу залогинен в свой кабинет
    const token = await new SignJWT({ userId: user.id, email: user.email, role: primaryRole, roles: data.roles })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(getJWTSecret());

    const response = NextResponse.json({
      success: true,
      message: 'Заявка на регистрацию партнера принята. Ожидайте подтверждения администратора.',
      data: {
        partnerId,
        userId: user.id,
        roles: data.roles,
        status: 'pending',
      },
    }, { status: 201 });

    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    return response;

  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json(
      { success: false, error: 'Ошибка при регистрации партнера' },
      { status: 500 }
    );
  } finally {
    client?.release();
  }
}
