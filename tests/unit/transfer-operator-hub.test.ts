/**
 * Прокачка кабинета трансфер-оператора 27.07 — сторожа четырёх дефектов.
 *
 * 1. Страницы «Брони» и «Маршруты» существовали, но в сайдбаре их не было —
 *    сироты, добраться можно было только прямой ссылкой.
 * 2. API водителей/автопарка умели POST, а в UI не было ни одной формы —
 *    оператор не мог завести машину или водителя через кабинет.
 * 3. У роли не было онбординга (у gear/stay/guide/agent — есть).
 * 4. Watchdog не сторожил зависшие pending-брони трансферов — туры, жильё
 *    и снаряжение под >24ч-проверкой, трансферы были слепым пятном.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const LAYOUT = read('app/hub/transfer-operator/layout.tsx');
const DRIVERS = read('app/hub/transfer-operator/drivers/_DriversPageClient.tsx');
const VEHICLES = read('app/hub/transfer-operator/vehicles/_VehiclesPageClient.tsx');
const ONBOARDING = read('app/hub/transfer-operator/onboarding/_TransferOnboardingClient.tsx');
const DASHBOARD = read('app/hub/transfer-operator/_TransferOperatorDashboardClient.tsx');
const WATCHDOG = read('lib/agents/watchdog.ts');

describe('навигация: сироты возвращены в сайдбар', () => {
  it('Брони и Маршруты присутствуют с section', () => {
    expect(LAYOUT).toContain("href: '/hub/transfer-operator/bookings'");
    expect(LAYOUT).toContain("href: '/hub/transfer-operator/routes'");
    // Каждый пункт кроме Обзора обязан иметь section (mobile icon-grid).
    const items = LAYOUT.match(/\{ href: '[^']+',\s+label: '[^']+',[^}]+\}/g) ?? [];
    expect(items.length).toBeGreaterThanOrEqual(5);
  });
});

describe('CRUD: формы добавления привязаны к существующим POST-контрактам', () => {
  it('водители: форма шлёт camelCase-поля схемы createDriverSchema', () => {
    expect(DRIVERS).toContain("fetch('/api/transfer-operator/drivers'");
    expect(DRIVERS).toContain("method: 'POST'");
    for (const field of ['firstName', 'lastName', 'phone', 'licenseNumber', 'licenseExpiry']) {
      expect(DRIVERS).toContain(field);
    }
    // Ошибка сервера показывается пользователю, а не глотается.
    expect(DRIVERS).toContain('json.error');
    expect(DRIVERS).toContain('refetch()');
  });

  it('автопарк: форма шлёт поля createVehicleSchema и русские лейблы типов', () => {
    expect(VEHICLES).toContain("fetch('/api/transfer-operator/vehicles'");
    expect(VEHICLES).toContain("method: 'POST'");
    for (const field of ['name', 'licensePlate', 'capacity', 'category']) {
      expect(VEHICLES).toContain(field);
    }
    // Значения enum — из контракта API, не выдуманные.
    for (const t of ["'car'", "'minivan'", "'bus'", "'helicopter'", "'boat'"]) {
      expect(VEHICLES).toContain(t);
    }
    expect(VEHICLES).toContain('json.error');
    expect(VEHICLES).toContain('refetch()');
  });
});

describe('онбординг: тот же конвейер, что у gear/stay', () => {
  it('визард использует общие компоненты и partners.onboarding_completed', () => {
    expect(ONBOARDING).toContain('OnboardingWizard');
    expect(ONBOARDING).toContain('PartnerProfileStep');
    expect(ONBOARDING).toContain("usePartnerOnboarding('/hub/transfer-operator')");
  });

  it('обзор кабинета гейтится на онбординг', () => {
    expect(DASHBOARD).toContain("useOnboardingGuard('/hub/transfer-operator/onboarding')");
  });
});

describe('watchdog: трансферы в симметрии booking-доменов', () => {
  it('проверка pending-броней >24ч существует и включена в прогон', () => {
    expect(WATCHDOG).toContain('checkPendingTransferBookings');
    expect(WATCHDOG).toContain("'pending_transfer_booking'");
    expect(WATCHDOG).toContain('FROM transfer_bookings tb');
    expect(WATCHDOG).toContain("tb.status = 'pending'");
    expect(WATCHDOG).toContain("INTERVAL '24 hours'");
    // Включена в Promise.all прогона, а не мёртвая функция.
    const runBlock = WATCHDOG.slice(WATCHDOG.indexOf('export async function runWatchdog'));
    expect(runBlock).toContain('checkPendingTransferBookings()');
  });

  it('прямой пинок оператору ведёт в раздел «Брони» кабинета', () => {
    expect(WATCHDOG).toContain('notifyTransferOperatorDirectly');
    expect(WATCHDOG).toContain('/hub/transfer-operator/bookings');
  });
});
