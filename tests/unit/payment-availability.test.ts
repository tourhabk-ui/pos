// @vitest-environment node
/**
 * Турист должен иметь чем заплатить — или узнать, что нечем (04.09).
 *
 * Воронка за неделю: 88 визитов, 22 просмотра тура, 1 заявка, 0 оплат.
 * Причина нашлась не в спросе:
 *
 *  - `app/api/hub/bookings/[id]/route.ts` читал `CLOUDPAYMENTS_PUBLIC_ID`;
 *  - `components/booking/TourPaymentModal.tsx` — `NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID`;
 *  - `.env.example` документировал только второе имя.
 *
 * Какое бы имя ни было заведено, одна из поверхностей оставалась без ключа. А
 * страница брони при пустом ключе прятала ВЕСЬ платёжный блок — вместе с
 * вкладкой СБП, которая от CloudPayments не зависит вовсе, — и продолжала
 * обещать «переходите к оплате».
 *
 * Сторож держит четыре вещи:
 *  1) имя ключа спрашивают в одном месте и принимают оба;
 *  2) СБП не заперта за ключом карты;
 *  3) «нечем платить» — видимое состояние, а не спрятанный блок (§4.0);
 *  4) проба не отдаёт значения ключей, только имена.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cloudPaymentsPublicId, sbpConfigured, paymentAvailability, paymentConfigNames,
} from '@/lib/payments/availability';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PAGE = read('app/booking-success/[id]/_BookingSuccessClient.tsx');
const API = read('app/api/hub/bookings/[id]/route.ts');
const PROBE = read('app/api/cron/payment-config/route.ts');
const ENV_EXAMPLE = read('.env.example');

const KEYS = [
  'CLOUDPAYMENTS_PUBLIC_ID', 'NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID', 'CLOUDPAYMENTS_API_SECRET',
  'TOCHKA_JWT_TOKEN', 'TOCHKA_MERCHANT_ID', 'TOCHKA_ACCOUNT_ID',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('имя ключа карты: принимаются оба', () => {
  it('без префикса', () => {
    process.env.CLOUDPAYMENTS_PUBLIC_ID = 'pk_test';
    expect(cloudPaymentsPublicId()).toBe('pk_test');
    expect(paymentConfigNames().card.via).toBe('CLOUDPAYMENTS_PUBLIC_ID');
  });

  it('с префиксом NEXT_PUBLIC_ — тем самым, что документирован в .env.example', () => {
    process.env.NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID = 'pk_test';
    expect(cloudPaymentsPublicId()).toBe('pk_test');
    expect(paymentConfigNames().card.via).toBe('NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID');
  });

  it('пустая строка и пробелы — это «не настроен», а не ключ', () => {
    process.env.CLOUDPAYMENTS_PUBLIC_ID = '   ';
    expect(cloudPaymentsPublicId()).toBeNull();
    expect(paymentConfigNames().card.configured).toBe(false);
  });

  it('имя, которое читает код, документировано', () => {
    expect(ENV_EXAMPLE).toMatch(/NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID/);
    expect(ENV_EXAMPLE).toMatch(/CLOUDPAYMENTS_PUBLIC_ID/);
  });
});

describe('СБП — свои три переменные, частичная настройка не считается', () => {
  it('все три — готово', () => {
    process.env.TOCHKA_JWT_TOKEN = 'jwt';
    process.env.TOCHKA_MERCHANT_ID = 'm';
    process.env.TOCHKA_ACCOUNT_ID = 'a';
    expect(sbpConfigured()).toBe(true);
    expect(paymentConfigNames().sbp.missing).toEqual([]);
  });

  it('двух из трёх мало — кнопка бы пообещала, а QR не выпустился', () => {
    process.env.TOCHKA_JWT_TOKEN = 'jwt';
    process.env.TOCHKA_MERCHANT_ID = 'm';
    expect(sbpConfigured()).toBe(false);
    expect(paymentConfigNames().sbp.missing).toEqual(['TOCHKA_ACCOUNT_ID']);
  });

  it('СБП не зависит от ключа карты', () => {
    process.env.TOCHKA_JWT_TOKEN = 'jwt';
    process.env.TOCHKA_MERCHANT_ID = 'm';
    process.env.TOCHKA_ACCOUNT_ID = 'a';
    const pay = paymentAvailability();
    expect(pay.cardPublicId).toBeNull();
    expect(pay.sbp).toBe(true);
    expect(pay.none).toBe(false);
  });
});

describe('ни одного способа — это состояние, а не тишина', () => {
  it('none поднимается, когда не настроено ничего', () => {
    expect(paymentAvailability().none).toBe(true);
  });

  it('роут брони отдаёт оба признака и кричит в лог при пустоте', () => {
    expect(API).toMatch(/paymentAvailability\(\)/);
    expect(API).toMatch(/sbp_available/);
    expect(API).toMatch(/console\.error\('\[bookings\/get\]/);
    // Имена переменных больше не собираются в месте применения.
    expect(API).not.toMatch(/process\.env\.CLOUDPAYMENTS_PUBLIC_ID/);
  });

  it('страница считает способы порознь и показывает «недоступна» вместо пустоты', () => {
    expect(PAGE).toMatch(/const canPayCard/);
    expect(PAGE).toMatch(/const canPaySbp/);
    expect(PAGE).toMatch(/const noPayWay/);
    expect(PAGE).toMatch(/Онлайн-оплата недоступна/);
    // Вкладка СБП больше не заперта внутри проверки ключа карты.
    expect(PAGE).not.toMatch(/needsPayment && booking\.cp_public_id && \(/);
  });
});

describe('приём подтверждения — отдельный вопрос от выставления счёта', () => {
  it('секрет вебхука считается своей переменной', () => {
    expect(paymentConfigNames().webhook.configured).toBe(false);
    process.env.CLOUDPAYMENTS_API_SECRET = 's';
    expect(paymentConfigNames().webhook.configured).toBe(true);
    expect(paymentConfigNames().webhook.name).toBe('CLOUDPAYMENTS_API_SECRET');
  });

  it('проба называет худшее состояние: платят, а подтвердить нечем', () => {
    // Без секрета processCloudPaymentsWebhook отвергает КАЖДОЕ уведомление
    // об оплате: деньги у банка приняты, бронь оплаченной не станет. Это
    // хуже ненастроенной карты — там турист хотя бы видит, что платить негде.
    expect(PROBE).toMatch(/card_pays_but_unconfirmed/);
  });
});

describe('проба конфигурации не становится утечкой', () => {
  it('отдаёт имена и признаки, но не значения', () => {
    expect(PROBE).toMatch(/paymentConfigNames/);
    expect(PROBE).toMatch(/accepted_names/);
    // Ни одного места, где значение ключа попадало бы в ответ. Единственное
    // разрешённое чтение окружения — CRON_SECRET для сверки доступа.
    expect(PROBE).not.toMatch(/cloudPaymentsPublicId\(\)/);
    const envReads = [...PROBE.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(envReads.length).toBeGreaterThan(0);
    expect([...new Set(envReads)]).toEqual(['CRON_SECRET']);
  });

  it('говорит «настроено», а не «работает»', () => {
    // Наличие ключа не доказывает прошедший платёж — обещать этого нельзя.
    expect(PROBE).toMatch(/verdict/);
    expect(PROBE).toMatch(/не доказательство прошедшего платежа/);
  });
});
