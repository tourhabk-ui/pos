/**
 * Пока платформа платежи не принимает (решение владельца 05.10, «убери то,
 * что мы принимаем оплату — мы пока информационная система», 07.10), ни одна
 * поверхность не обещает приём оплаты, комиссию или выплаты через Ведар.
 *
 * Сторож держит связку: каждый файл, где такая фраза живёт, спрашивает флаг
 * `platformAcceptsPayments()` — иначе при `false` фраза осталась бы враньём.
 * Включат оплату обратно — тексты вернутся тем же флагом, без правок.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLATFORM_ACCEPTS_PAYMENTS } from '@/lib/payments/accepting';
import { HELP_ARTICLES } from '@/lib/help/content';

const GATED = [
  'lib/help/content.ts',
  'app/catalog/tours/[id]/_TourDetailClient.tsx',
  'lib/telegram/booking-notify.ts',
  'app/hub/operator/finance/_FinancePageClient.tsx',
  'app/hub/operator/help/_OperatorHelpClient.tsx',
  'app/hub/operator/_OperatorDashboardClient.tsx',
  'app/hub/operator/reports/_ReportsPageClient.tsx',
  'components/operator/AutoConfirmToggle.tsx',
  'lib/telegram/welcome.ts',
  'app/hub/agent/bookings/_AgentBookingsPageClient.tsx',
  'app/hub/agent/commissions/_AgentCommissionsPageClient.tsx',
  'app/hub/agent/profile/_AgentProfileClient.tsx',
  'app/hub/carrier/_CarrierClient.tsx',
  'app/api/partners/register/route.ts',
  // 07.10, «убери оплаты, мы пока не туроператоры»:
  'app/hub/operator/onboarding/_OnboardingClient.tsx',
  'app/hub/agent/layout.tsx',
  'app/hub/agent/_AgentDashboardClient.tsx',
  'app/hub/guide/layout.tsx',
  'app/hub/guide/_GuideDashboardClient.tsx',
  'components/booking/TourPaymentModal.tsx',
  'lib/pdf/contract-generator.ts',
];

describe('тексты при выключенной оплате', () => {
  it('флаг выключен — сторож проверяет именно этот режим', () => {
    expect(PLATFORM_ACCEPTS_PAYMENTS).toBe(false);
  });

  for (const f of GATED) {
    it(`${f} спрашивает флаг`, () => {
      expect(readFileSync(f, 'utf8')).toMatch(/platformAcceptsPayments\(\)/);
    });
  }

  it('справка не обещает удержание денег, выплаты и комиссию', () => {
    const text = JSON.stringify(HELP_ARTICLES);
    expect(text).not.toMatch(/удерживаются до окончания тура/);
    expect(text).not.toMatch(/Ставку комиссии назначает платформа/);
    expect(text).toMatch(/платежи туристов платформа не принимает/);
    expect(text).not.toMatch(/Ждёт оплаты/);
  });

  it('Кузьмич не называет себя турагентом и не говорит об оплате на платформе', () => {
    expect(readFileSync('lib/ai/prompts.ts', 'utf8')).not.toMatch(/турагент/);
    expect(readFileSync('lib/ai/user-memory.ts', 'utf8')).not.toMatch(/турагент/);
    expect(readFileSync('lib/kuzmich/core.ts', 'utf8')).not.toMatch(/подтверждаются перед оплатой|уточняется перед оплатой/);
  });

  it('метаданные публичных страниц не обещают оплату на платформе', () => {
    expect(readFileSync('app/help/page.tsx', 'utf8')).not.toMatch(/забронировать и оплатить тур/);
    expect(readFileSync('app/transfers/page.tsx', 'utf8')).not.toMatch(/оплата по СБП\./);
    expect(readFileSync('app/help/tourists/page.tsx', 'utf8')).not.toMatch(/оплатить/);
    expect(readFileSync('app/help/operators/page.tsx', 'utf8')).not.toMatch(/выплаты/);
  });

  it('документы оператора не обещают комиссию 12%', () => {
    const onb = readFileSync('docs/OPERATOR_ONBOARDING.md', 'utf8');
    expect(onb).not.toMatch(/Комиссия 12%/);
    expect(onb).not.toMatch(/legal\/operator-agreement/);
    expect(readFileSync('docs/OPERATOR_AGREEMENT_TEMPLATE.md', 'utf8')).toMatch(/^> \*\*НЕ ДЕЙСТВУЕТ\.\*\*/);
  });
});
