/**
 * Сторож: проверка готовности СБП не ходит в банк.
 *
 * 30.08.2026 владелец добавил TOCHKA_* в Timeweb и спросил, дошло ли.
 * Ответить нормальным вызовом `createSBPQR()` значило бы выпустить
 * НАСТОЯЩИЙ QR на стороне Точки — даже в песочнице это живой объект у
 * банка, а не наш локальный факт. Проверка формы переменных чисто
 * локальна и не должна разрастись в звонок наружу.
 *
 * Три исхода, не два (§4.0): не заданы / заданы не той формы / готовы.
 * «Готовы» — про форму, не про то, что банк примет запрос: это разные
 * утверждения, и смешивать их нельзя.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tochkaReadiness } from '@/lib/payments/tochka';

const ENV_KEYS = ['TOCHKA_JWT_TOKEN', 'TOCHKA_MERCHANT_ID', 'TOCHKA_ACCOUNT_ID', 'TOCHKA_BASE_URL'] as const;

describe('tochkaReadiness: локальная проверка, банк не звонит', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('ничего не задано — missing_env называет все три', () => {
    const r = tochkaReadiness();
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'missing_env') {
      expect(r.missing).toEqual(['TOCHKA_JWT_TOKEN', 'TOCHKA_MERCHANT_ID', 'TOCHKA_ACCOUNT_ID']);
    } else {
      throw new Error('ожидался missing_env');
    }
  });

  it('заданы, но кривой формы — bad_shape, а не тихий провал', () => {
    process.env.TOCHKA_JWT_TOKEN = 'x';
    process.env.TOCHKA_MERCHANT_ID = 'ok-merchant';
    process.env.TOCHKA_ACCOUNT_ID = 'без-слэша-и-бик'; // не совпадает с SAFE_ACCOUNT
    const r = tochkaReadiness();
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'bad_shape') {
      expect(r.bad).toContain('TOCHKA_ACCOUNT_ID');
    } else {
      throw new Error('ожидался bad_shape');
    }
  });

  it('официальные тестовые значения песочницы проходят форму и опознаются как песочница', () => {
    // Значения из документации Точки, приведённые в шапке tochka.ts как справка.
    process.env.TOCHKA_JWT_TOKEN = 'sandbox.jwt.token';
    process.env.TOCHKA_MERCHANT_ID = '200000000001097';
    process.env.TOCHKA_ACCOUNT_ID = '12345123451234512345/044525104';
    process.env.TOCHKA_BASE_URL = 'https://enter.tochka.com/sandbox/v2';
    const r = tochkaReadiness();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sandbox).toBe(true);
  });

  it('без TOCHKA_BASE_URL готовность считается боевым контуром', () => {
    process.env.TOCHKA_JWT_TOKEN = 'x';
    process.env.TOCHKA_MERCHANT_ID = 'ok-merchant';
    process.env.TOCHKA_ACCOUNT_ID = '12345/1234567890';
    const r = tochkaReadiness();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sandbox).toBe(false);
  });
});

describe('роут диагностики не зовёт банк', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/cron/tochka-check/route.ts'), 'utf-8');

  it('не импортирует createSBPQR/getSBPPaymentStatus', () => {
    // Комментарий вправе объяснять, ПОЧЕМУ их нет — запрещён только импорт.
    expect(SRC, 'диагностика начала выпускать настоящие QR')
      .not.toMatch(/import\s*\{[^}]*(createSBPQR|getSBPPaymentStatus)/);
  });

  it('не делает fetch наружу', () => {
    expect(SRC).not.toMatch(/\bfetch\(/);
  });

  it('требует CRON_SECRET', () => {
    expect(SRC).toMatch(/timingSafeCompare/);
  });
});
