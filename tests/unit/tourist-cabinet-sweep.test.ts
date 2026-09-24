/**
 * Проход по кабинету туриста 24.09 (просьба владельца «просмотри все
 * страницы под туристом, найди баги»). Каждый сторож держит одну починку —
 * ту, что туристу видна глазами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('брони: каждая — один раз', () => {
  const SRC = read('app/api/bookings/route.ts');

  it('вторая выборка не повторяет брони, у которых хозяин записан в колонке', () => {
    // reserve.ts пишет user_id и в колонку, и в metadata — без этого условия
    // бронь показывалась дважды («<id>» и «op-<id>»).
    expect(SRC).toMatch(/AND \(ob\.user_id IS NULL OR ob\.user_id::text <> \$1\)/);
    expect(SRC).toMatch(/AND ob\.deleted_at IS NULL/);
  });

  it('статус не переводится в несуществующий у клиента pending', () => {
    expect(SRC).not.toMatch(/new: 'pending'/);
    expect(SRC).toMatch(/status: r\.booking_status as/);
  });

  it('клиент просит больше десяти и не выдаёт отказ за «броней нет»', () => {
    const C = read('app/hub/tourist/bookings/_BookingHistoryPageClient.tsx');
    expect(C).toMatch(/'\/api\/bookings\?limit=100'/);
    expect(C).toMatch(/Не удалось загрузить бронирования/);
  });

  it('отмена неоплаченной брони не обещает возврат цены', () => {
    const C = read('app/api/bookings/[id]/cancel/route.ts');
    expect(C).toMatch(/FROM tour_payments WHERE booking_id = \$1 AND status = 'HELD'/g);
    expect(C.match(/status = 'HELD'/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(C).toMatch(/Оплаты по этой брони не было — возвращать нечего/);
  });
});

describe('контрольный срок: экран показывает время тревоги', () => {
  it('срок считает сервер той же функцией, что эскалация', () => {
    const R = read('app/api/tourist/safety-registrations/route.ts');
    expect(R).toMatch(/resolveControlTime\(end, exp\)/);
    expect(R).toMatch(/control_at/);
  });

  it('клиент не склеивает дату сам и не красит «не знаю» зелёным', () => {
    const C = read('app/hub/tourist/safety/_SafetyClient.tsx');
    expect(C).not.toMatch(/T23:59:00/);
    expect(C).toMatch(/Срок не известен/);
    expect(C).toMatch(/Не удалось загрузить регистрации/);
    expect(C).toMatch(/window\.confirm\(/);
  });
});

describe('главная кабинета', () => {
  it('Open-Meteo отдаёт км/ч — ветер не умножается на 3.6', () => {
    const W = read('app/api/weather/route.ts');
    expect(W).not.toMatch(/wind_speed_10m(\[i\])? \* 3\.6/);
    expect(W).not.toMatch(/wind_speed_10m_max\[i\] \* 3\.6/);
    expect(W).not.toMatch(/wind_gusts_10m \* 3\.6/);
  });

  it('умеренная погода — не «Опасно»', () => {
    const D = read('app/hub/tourist/_TouristDashboardClient.tsx');
    expect(D).toMatch(/'moderate' \? 'Умеренно'/);
  });

  it('рекомендация ведёт на существующую карточку тура', () => {
    const R = read('components/tourist/RecommendationCard.tsx');
    expect(R).toMatch(/href=\{`\/marketplace\/tours\/\$\{tour\.id\}`\}/);
    expect(existsSync(join(process.cwd(), 'app/marketplace/tours/[id]/page.tsx'))).toBe(true);
    expect(R).not.toMatch(/\{tour\.duration\} дн\./);
  });
});

describe('профиль, сообщения, поддержка, избранное, корзина', () => {
  it('профиль читает телефон и «о себе» и принимает очистку поля', () => {
    expect(read('lib/auth/tourist-helpers.ts')).toMatch(/full_name, phone, bio/);
    const P = read('app/api/tourist/profile/route.ts');
    expect(P).toMatch(/phone: z\.string\(\)\.max\(40[^)]*\)\.nullable\(\)\.optional\(\)/);
    expect(P).toMatch(/bio: z\.string\(\)\.max\(2000[^)]*\)\.nullable\(\)\.optional\(\)/);
  });

  it('переписка отдаёт ПОСЛЕДНИЕ сообщения, а не первые сто', () => {
    const S = read('lib/services/operators/chat.service.ts');
    expect(S).toMatch(/ORDER BY m\.created_at DESC\s+LIMIT/);
    expect(S).toMatch(/\) last_window\s+ORDER BY created_at ASC/);
  });

  it('статусы заявки поддержки сравниваются строчными', () => {
    const C = read('app/hub/tourist/support/_SupportClient.tsx');
    expect(C).not.toMatch(/\['RESOLVED', 'CLOSED'\]/);
    expect(C).toMatch(/\['resolved', 'closed'\]/);
  });

  it('тур из избранного берёт цену и фото из настоящих колонок', () => {
    const T = read('app/api/tours/[id]/route.ts');
    expect(T).toMatch(/row\.base_price/);
    expect(T).toMatch(/row\.photos/);
  });

  it('корзина спрашивает согласие на ПД и передаёт его', () => {
    const C = read('app/hub/tourist/cart/checkout/_CheckoutClient.tsx');
    expect(C).toMatch(/<PdConsentCheckbox/);
    expect(C).toMatch(/pd_consent: pdConsent/);
  });
});

describe('обещания без исполнения сняты (решение владельца 24.09)', () => {
  it('уровни лояльности не обещают скидок и привилегий', () => {
    const L = read('lib/loyalty/loyalty-system.ts');
    expect(L).not.toMatch(/benefits:/);
    expect(L).not.toMatch(/discount: 0\.\d/);
    const C = read('app/hub/tourist/loyalty/_LoyaltyClient.tsx');
    expect(C).not.toMatch(/на все туры/);
    expect(C).not.toMatch(/Привилегии/);
  });

  it('настроек уведомлений без отправителя нет — ни экрана, ни роута', () => {
    expect(read('app/hub/tourist/notifications/_NotificationsClient.tsx')).not.toMatch(/notification-preferences/);
    expect(existsSync(join(process.cwd(), 'app/api/tourist/notification-preferences/route.ts'))).toBe(false);
  });
});
