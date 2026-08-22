/**
 * Подпись вебхука CloudPayments: сборщик и проверяющий сходятся.
 *
 * §7 запрещает трогать приём оплаты без staging — и ровно для staging в
 * репозитории лежал `createTestWebhook`: он собирает подписанное тело, каким
 * его пришлёт платёжный шлюз. Функция не звалась НИ ОТКУДА (перепись
 * 22.08.2026): проверить приёмник, не дёргая CloudPayments, было нечем, хотя
 * инструмент для этого существовал.
 *
 * Сторож `payment-webhook-atomic` проверяет ТЕКСТ роута — что запись идёт в
 * транзакции и под блокировкой. Здесь проверяется другое и не менее важное:
 * что пара «подписать / проверить подпись» действительно сходится, а подделка
 * не проходит. Разойтись они могут молча — обе стороны компилируются.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createTestWebhook, validateCloudPaymentsSignature } from '@/lib/payments/cloudpayments-webhook';

const SECRET = 'staging-secret-for-signature-check';

describe('подпись вебхука', () => {
  let before: string | undefined;

  beforeEach(() => {
    before = process.env.CLOUDPAYMENTS_API_SECRET;
    process.env.CLOUDPAYMENTS_API_SECRET = SECRET;
  });

  afterEach(() => {
    if (before === undefined) delete process.env.CLOUDPAYMENTS_API_SECRET;
    else process.env.CLOUDPAYMENTS_API_SECRET = before;
  });

  it('собранное тело проходит проверку своей же подписью', () => {
    const { body, signature } = createTestWebhook('booking-1', 5000);
    expect(validateCloudPaymentsSignature(body, signature, SECRET)).toBe(true);
  });

  it('чужой секрет подпись не принимает', () => {
    const { body, signature } = createTestWebhook('booking-2', 5000);
    expect(validateCloudPaymentsSignature(body, signature, 'другой-секрет')).toBe(false);
  });

  it('подменённая сумма ломает подпись', () => {
    // Главное, ради чего подпись существует: заплатить рубль и записать пять тысяч.
    const { body, signature } = createTestWebhook('booking-3', 5000);
    const tampered = body.replace('"Amount":5000', '"Amount":1');
    expect(tampered).not.toBe(body);
    expect(validateCloudPaymentsSignature(tampered, signature, SECRET)).toBe(false);
  });

  it('без подписи и без секрета — отказ, а не «сойдёт»', () => {
    const { body } = createTestWebhook('booking-4', 100);
    expect(validateCloudPaymentsSignature(body, null, SECRET)).toBe(false);
    expect(validateCloudPaymentsSignature(body, 'что-угодно', '')).toBe(false);
  });

  it('тело несёт номер брони и статус — по ним приёмник и работает', () => {
    const { body } = createTestWebhook('booking-5', 777, 'Declined');
    const parsed = JSON.parse(body) as { InvoiceId: string; Status: string; Amount: number };
    expect(parsed.InvoiceId).toBe('booking-5');
    expect(parsed.Status).toBe('Declined');
    expect(parsed.Amount).toBe(777);
  });

  it('в проде сборщик тестовых вебхуков отказывается работать', () => {
    // NODE_ENV в vitest только для чтения, поэтому проверяется сам запрет в
    // исходнике: подписать «оплату» боевым секретом из теста нельзя.
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/payments/cloudpayments-webhook.ts'), 'utf8');
    // Срез фиксированной длины, а не «до первой закрывающей скобки»: у этой
    // функции сначала идёт тип возврата, и его скобка закрывается раньше тела.
    const fn = src.slice(src.indexOf('export function createTestWebhook')).slice(0, 900);
    expect(fn).toMatch(/NODE_ENV === 'production'[\s\S]{0,90}throw/);
  });

  it('подпись считается по ВСЕМУ телу, а не по его части', () => {
    const { body, signature } = createTestWebhook('booking-7', 4242);
    const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
    expect(signature).toBe(expected);
  });
});
