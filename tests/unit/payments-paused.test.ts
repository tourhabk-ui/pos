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
import { readFileSync } from 'node:fs';
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
  ])('%s говорит о платеже по выключателю, а не безусловно', (f) => {
    expect(read(f)).toMatch(/platformAcceptsPayments\(\)/);
  });

  it.each([
    'app/legal/terms/page.tsx',
    'app/legal/offer/page.tsx',
    'app/legal/privacy/page.tsx',
    'app/legal/agent-agreement/page.tsx',
    'app/legal/commission/page.tsx',
    'components/homepage/AgentModelSection.tsx',
    'app/for-operators/page.tsx',
  ])('%s не обещает приём оплаты платформой', (f) => {
    const code = strip(read(f));
    for (const claim of [
      /CloudPayments/, /Точка Банк/, /PCI DSS/, /агентом Партнёров по приёму оплаты/,
      /действующего в качестве агента/, /за вычетом 10%/, /Комиссия 10%/,
    ]) {
      expect(code, `${f}: ${claim}`).not.toMatch(claim);
    }
  });

  it('недействующие документы закрыты от индекса и убраны из навигации и sitemap', () => {
    for (const f of ['app/legal/agent-agreement/page.tsx', 'app/legal/commission/page.tsx']) {
      const code = read(f);
      expect(code).toMatch(/robots: \{ index: false/);
      expect(code).toMatch(/Документ не действует с 5 октября 2026 г\./);
    }
    for (const f of ['lib/navigation/platform-links.ts', 'lib/seo/sitemap-entries.ts']) {
      expect(read(f)).not.toMatch(/legal\/(agent-agreement|commission)/);
    }
  });
});
