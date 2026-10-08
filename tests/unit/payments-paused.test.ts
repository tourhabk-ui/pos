/**
 * Сторож решения владельца 05.10: «пока уберём оплату».
 *
 * Выключатель один — `PLATFORM_ACCEPTS_PAYMENTS` (lib/payments/accepting).
 * Сторож держит связку: пока он `false`, ни одна дверь не выпускает платёж
 * (ключ карты, QR СБП, счёт CloudPayments), а тексты туристу, партнёру и
 * юридические страницы не обещают приём оплаты платформой. Включили оплату —
 * раздел «пока выключено» перестаёт действовать, и тексты должны вернуться
 * вместе с ним (этот сторож тогда краснеет на юридических страницах).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLATFORM_ACCEPTS_PAYMENTS } from '@/lib/payments/accepting';
import { paymentAvailability } from '@/lib/payments/availability';
import { isTochkaConfigured } from '@/lib/payments/tochka';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ENV_KEYS = [
  'CLOUDPAYMENTS_PUBLIC_ID', 'NEXT_PUBLIC_CLOUDPAYMENTS_PUBLIC_ID',
  'TOCHKA_JWT_TOKEN', 'TOCHKA_MERCHANT_ID', 'TOCHKA_ACCOUNT_ID',
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe.runIf(!PLATFORM_ACCEPTS_PAYMENTS)('оплата выключена владельцем (05.10)', () => {
  it('настроенные ключи не открывают ни карту, ни СБП', () => {
    for (const k of ENV_KEYS) process.env[k] = 'set';
    const pay = paymentAvailability();
    expect(pay).toEqual({ cardPublicId: null, sbp: false, none: true, paused: true });
    // Приёмник QR в app/api/payments (§7) спрашивает именно эту функцию.
    expect(isTochkaConfigured()).toBe(false);
  });

  it('приёмник QR не правлен, а закрыт через isTochkaConfigured', () => {
    expect(read('app/api/payments/tochka/qr/route.ts')).toMatch(/if \(!isTochkaConfigured\(\)\)/);
  });

  it('старая дверь брони не выставляет счёт CloudPayments', () => {
    const src = strip(read('app/api/tours/[id]/book/route.ts'));
    expect(src).toMatch(/if \(platformAcceptsPayments\(\)\) \{\s*try \{[\s\S]*?\/api\/payments\/create/);
  });

  it('страница брони отличает «выключено» от «не настроено» и не грузит виджет банка зря', () => {
    expect(read('app/api/hub/bookings/[id]/route.ts')).toMatch(/payments_paused: pay\.paused/);
    const page = read('app/booking-success/[id]/_BookingSuccessClient.tsx');
    expect(page).toMatch(/\{booking\?\.cp_public_id && \(\s*<Script/);
    expect(page).toMatch(/Оплата — напрямую оператору/);
  });

  it.each([
    'lib/kuzmich/core.ts',
    'components/kuzmich/KuzmichWidget.tsx',
    'lib/kuzmich/transfer-search.ts',
    'lib/seat-requests/core.ts',
    'app/api/hub/bookings/create/route.ts',
    'lib/telegram/booking-notify.ts',
    'app/transfers/_TransfersClient.tsx',
    'app/catalog/tours/[id]/_TourDetailClient.tsx',
    // Влились из автоподтверждения 04.10 вместе с этой правкой.
    'components/marketplace/BookingFormClient.tsx',
    'components/planner/SeatRequestForm.tsx',
    'lib/bookings/guest-contact.ts',
    'app/seat-request/_SeatRequestStatusClient.tsx',
    'app/seat-request/answer/[id]/_OperatorAnswerClient.tsx',
    'app/api/hub/operator/bookings/[id]/route.ts',
    'app/p/[code]/_SelectionClient.tsx',
    'lib/seat-requests/service.ts',
  ])('%s говорит о платеже по выключателю, а не безусловно', (f) => {
    expect(read(f)).toMatch(/platformAcceptsPayments\(\)/);
  });

  it('MCP-роут берёт фразу об оплате у seat-requests и в lib/payments не ходит', () => {
    // Сторожа mcp-booking и mcp-seat-request запрещают роуту импорт из
    // lib/payments; 05.10 прямой импорт выключателя сделал main красным.
    const route = read('app/api/mcp/route.ts');
    expect(route).toMatch(/seatRequestPaymentNote\(\)/);
    expect(route).not.toMatch(/from '@\/lib\/payments/);
  });

  it.each([
    'app/legal/terms/page.tsx',
    'app/legal/offer/page.tsx',
    'app/legal/privacy/page.tsx',
    'components/homepage/AgentModelSection.tsx',
    'app/for-operators/page.tsx',
  ])('%s не обещает приём оплаты платформой', (f) => {
    const code = strip(read(f));
    for (const claim of [
      /CloudPayments/, /Точка Банк/, /PCI DSS/, /агентом Партнёров по приёму оплаты/, /Проведение расчётов с партнёрами/,
      /действующего в качестве агента/, /за вычетом 10%/, /Комиссия 10%/,
    ]) {
      expect(code, `${f}: ${claim}`).not.toMatch(claim);
    }
  });

  it('футер и условия называют статус: информационная система, оплату не принимает', () => {
    const footer = strip(read('components/layout/Footer.tsx'));
    expect(footer).toMatch(/информационная система/);
    expect(footer).toMatch(/не принимает оплату/);
    const terms = strip(read('app/legal/terms/page.tsx'));
    expect(terms).toMatch(/не является туроператором, турагентом или\s+агрегатором/);
    // Раздел 6: ответственность не мерится «суммой, уплаченной через Платформу».
    expect(terms).not.toMatch(/уплаченн\S* Пользователем через Платформу/);
  });

  it('политика не утверждает подачу уведомления и не ссылается на несуществующую статью', () => {
    const privacy = strip(read('app/legal/privacy/page.tsx'));
    expect(privacy).not.toMatch(/Оператор подал уведомление/);
    expect(privacy).not.toMatch(/ст\. 18\.1 Федерального закона № 242-ФЗ/);
    expect(privacy).not.toMatch(/анонимизируются/);
    expect(privacy).not.toMatch(/30 дней с момента получения запроса/);
    expect(privacy).toMatch(/не подтверждает включение Оператора в реестр/);
    expect(privacy).toMatch(/ч\. 5 ст\. 18 Федерального закона № 152-ФЗ/);
    expect(privacy).toMatch(/10 рабочих дней/);
  });

  it('агентского договора и условий комиссии нет вовсе (404) — ни страниц, ни ссылок', () => {
    // Владелец 05.10: «/legal/agent-agreement → 404». Страница «не действует»
    // по-прежнему читалась как документ платформы.
    for (const f of ['app/legal/agent-agreement/page.tsx', 'app/legal/commission/page.tsx']) {
      expect(existsSync(join(process.cwd(), f)), f).toBe(false);
    }
    for (const f of ['lib/navigation/platform-links.ts', 'lib/seo/sitemap-entries.ts']) {
      expect(read(f)).not.toMatch(/legal\/(agent-agreement|commission)/);
    }
  });
});
