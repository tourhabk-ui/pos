/**
 * Воронка в петле эволюции (Эволюция 3.0, п.5, владелец 08.08: «действуй»;
 * контекст — «у нас 2 партнёра с 2 локациями и ни одного пользователя»).
 *
 * До этого петля сторожила только код: прод-500, фантомные колонки, моки.
 * Главный вопрос платформы — доходит ли кто-то до денег — не сторожил никто.
 * Контур: page_views (СВОЯ метрика, PageViewTracker — просмотры без ботов) +
 * маяк /api/funnel (только booking_start: взаимодействие, которого нет в
 * page_views) + leads/operator_bookings (низ) → объектив scanFunnel → ОДНА
 * находка за прогон (самое верхнее сломанное звено) → категория 'funnel'
 * наружу через issue-reporter.
 * Первая версия дублировала просмотры своим маяком («у нас была настроена
 * своя метрика») и читала Яндекс.Метрику через API — убрано по слову
 * владельца 08.08: «YANDEX_METRIKA_TOKEN не нужен, у нас свой».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pickFunnelFinding, type FunnelCounts } from '@/lib/agents/evo/growth-agent';
import { OUTWARD_CATEGORIES } from '@/lib/agents/evo/issue-reporter';

const ROOT = process.cwd();
const GROWTH = readFileSync(join(ROOT, 'lib/agents/evo/growth-agent.ts'), 'utf-8');
const API = readFileSync(join(ROOT, 'app/api/funnel/route.ts'), 'utf-8');
const TOUR = readFileSync(join(ROOT, 'app/marketplace/tours/[id]/_TourDetailClient.tsx'), 'utf-8');
const CATALOG = readFileSync(join(ROOT, 'components/marketplace/MarketplaceClient.tsx'), 'utf-8');
const BOOKING = readFileSync(join(ROOT, 'components/marketplace/BookingFormClient.tsx'), 'utf-8');

const counts = (over: Partial<FunnelCounts>): FunnelCounts => ({
  visits: 0, tour_views: 0, booking_starts: 0, leads: 0, bookings: 0, paid: 0, ...over,
});

describe('pickFunnelFinding: самое верхнее сломанное звено', () => {
  it('пустая воронка → «нет визитов» (привлечение, не продукт)', () => {
    const f = pickFunnelFinding(counts({}));
    expect(f?.title).toBe('Воронка: нет визитов');
    expect(f?.severity).toBe('medium');
    expect(f?.category).toBe('funnel');
  });

  it('визиты есть, туры не открывают → каталог не ведёт к турам', () => {
    expect(pickFunnelFinding(counts({ visits: 12 }))?.title).toBe('Воронка: каталог не ведёт к турам');
  });

  it('туры смотрят, форму не трогают и заявок нет → карточка не конвертит', () => {
    expect(pickFunnelFinding(counts({ visits: 12, tour_views: 9 }))?.title).toBe('Воронка: карточка тура не конвертит');
  });

  it('форму трогают, но ни брони, ни заявки → бросают', () => {
    expect(pickFunnelFinding(counts({ visits: 12, tour_views: 9, booking_starts: 3 }))?.title)
      .toBe('Воронка: бронь начинают и бросают');
  });

  it('брони без оплат → платёжный путь', () => {
    const f = pickFunnelFinding(counts({ visits: 12, tour_views: 9, booking_starts: 3, bookings: 2 }));
    expect(f?.title).toBe('Воронка: брони есть, оплат нет');
    expect(f?.severity).toBe('high');
  });

  it('заявка закрывает звено конверсии — лид тоже поток', () => {
    // Заявок 2, форм брони никто не трогал: карточка КОНВЕРТИТ (в лида) —
    // находки «не конвертит» быть не должно; следующее звено (брони без оплат
    // при 0 броней) тоже не сломано → воронка живая, находка не нужна.
    expect(pickFunnelFinding(counts({ visits: 12, tour_views: 9, leads: 2 }))).toBeNull();
  });

  it('поток до оплаты есть → находки нет', () => {
    expect(pickFunnelFinding(counts({ visits: 12, tour_views: 9, booking_starts: 3, bookings: 2, paid: 1 }))).toBeNull();
  });

  it('находка детерминированная, сразу suggested и с цифрами недели', () => {
    const f = pickFunnelFinding(counts({}));
    expect(f?.model).toBe('deterministic');
    expect(f?.status).toBe('suggested');
    expect(f?.description).toContain('визитов 0');
  });
});

describe('чтение Яндекс.Метрики через API убрано (владелец 08.08: «у нас свой»)', () => {
  it('в репо нет читалки Reporting API и упоминаний её токена', () => {
    expect(existsSync(join(ROOT, 'lib/analytics/metrika-report.ts'))).toBe(false);
    expect(GROWTH).not.toMatch(/fetchMetrikaWeek|YANDEX_METRIKA_TOKEN/);
    const HEALTH = readFileSync(join(ROOT, 'app/api/cron/health/route.ts'), 'utf-8');
    expect(HEALTH).not.toMatch(/metrika_diag|fetchMetrikaWeek/);
  });
});

describe('контур подключён', () => {
  it('объектив в прочёсе и читает все источники', () => {
    expect(GROWTH).toMatch(/scanFunnel\(\)\.catch/);
    expect(GROWTH).toMatch(/FROM page_views/);
    expect(GROWTH).toMatch(/FROM funnel_events/);
    expect(GROWTH).toMatch(/FROM leads WHERE created_at/);
    expect(GROWTH).toMatch(/FROM operator_bookings/);
  });

  it('просмотры — из своей метрики и без краулеров', () => {
    expect(GROWTH).toMatch(/is_bot = FALSE/);
    expect(GROWTH).toMatch(/path LIKE '\/catalog\/tours\/%' OR path LIKE '\/marketplace\/tours\/%'/);
  });

  it('дедуп находок без файла жив: file_path сравнивается через IS NOT DISTINCT FROM', () => {
    expect(GROWTH).toMatch(/file_path IS NOT DISTINCT FROM \$1/);
  });

  it('категория funnel выносится в GitHub Issues', () => {
    expect(OUTWARD_CATEGORIES.has('funnel')).toBe(true);
  });

  it('ретенция журнала маяка — 90 суток', () => {
    expect(GROWTH).toMatch(/DELETE FROM funnel_events WHERE created_at < NOW\(\) - INTERVAL '90 days'/);
  });
});

describe('маяк: API и клиенты', () => {
  it('единственный шаг маяка — booking_start: просмотры уже пишет своя метрика', () => {
    expect(API).toMatch(/z\.enum\(\['booking_start'\]\)/);
  });

  it('API переиспользует общий инструментарий метрики: хэш с солью, бот-детект, лимитер', () => {
    expect(API).toMatch(/from '@\/lib\/analytics\/visitor-hash'/);
    expect(API).toMatch(/isBotUserAgent/);
    expect(API).toMatch(/createRateLimiter/);
  });

  it('дедуп на сервере: час на посетителя+тур', () => {
    expect(API).toMatch(/INTERVAL '60 minutes'/);
    expect(API).toMatch(/entity_id IS NOT DISTINCT FROM \$2/);
  });

  it('форма брони шлёт booking_start; дублирующих маяков просмотров нет', () => {
    expect(BOOKING).toMatch(/funnelBeacon\('booking_start', String\(tourId\)\)/);
    expect(BOOKING).toMatch(/onFocusCapture=\{markFunnelStart\}/);
    expect(TOUR).not.toMatch(/funnelBeacon/);
    expect(CATALOG).not.toMatch(/funnelBeacon/);
  });
});
