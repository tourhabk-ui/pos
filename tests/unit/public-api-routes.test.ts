/**
 * Реестр публичных API-маршрутов — Edge-рубеж платформы.
 *
 * Аудит бизнес-процессов 25.07 нашёл в нём две молчаливые поломки:
 *  1. Запись '/api/places/*​/safety-report' сравнивалась буквально и не
 *     совпадала ни с чем — анонимный POST наблюдения о месте, объявленный
 *     публичным, получал 401 ещё до обработчика.
 *  2. СБП-вебхука Точки в реестре не было вовсе: '/api/payments/webhook' не
 *     префикс для '/api/payments/tochka/webhook'. Банк не мог подтвердить
 *     оплату — бронь оставалась pending_payment и позже отменялась кроном
 *     abandoned-bookings, хотя деньги у туриста уже списались.
 *
 * Оба случая — про молчание: правило объявлено, но не работает. Тесты
 * фиксируют работу сверки, а не список записей.
 */
import { describe, it, expect } from 'vitest';
import { isPathMatch, isPublicApiPath, PUBLIC_API_ROUTES } from '@/lib/auth/public-api-routes';

describe('isPathMatch — префиксы и сегментный *', () => {
  it('точное совпадение и вложенный путь', () => {
    expect(isPathMatch('/api/tours', '/api/tours')).toBe(true);
    expect(isPathMatch('/api/tours/42', '/api/tours')).toBe(true);
  });

  it('однокоренной сосед НЕ считается вложенным', () => {
    expect(isPathMatch('/api/tourslist', '/api/tours')).toBe(false);
  });

  it('* подставляет ровно один сегмент', () => {
    expect(isPathMatch('/api/places/abc-123/safety-report', '/api/places/*/safety-report')).toBe(true);
    expect(isPathMatch('/api/places/safety-report', '/api/places/*/safety-report')).toBe(false);
  });
});

describe('isPublicApiPath — кого Edge пускает без токена', () => {
  it('анонимный POST наблюдения о месте — публичен (был 401)', () => {
    expect(isPublicApiPath('/api/places/abc-123/safety-report', 'POST')).toBe(true);
  });

  it('СБП-вебхук Точки — публичен (банк не мог достучаться)', () => {
    expect(isPublicApiPath('/api/payments/tochka/webhook', 'POST')).toBe(true);
  });

  it('метод вне списка не проходит: карточка места только на чтение', () => {
    expect(isPublicApiPath('/api/places/abc-123', 'GET')).toBe(true);
    expect(isPublicApiPath('/api/places/abc-123', 'DELETE')).toBe(false);
  });

  it('кабинеты закрыты: жильё, снаряжение, брони туриста', () => {
    expect(isPublicApiPath('/api/stay/accommodations', 'POST')).toBe(false);
    expect(isPublicApiPath('/api/gear/items', 'POST')).toBe(false);
    expect(isPublicApiPath('/api/tourist/trips', 'POST')).toBe(false);
  });

  it('не-API путь публичным не считается', () => {
    expect(isPublicApiPath('/hub/admin', 'GET')).toBe(false);
  });
});

describe('реестр не содержит записей-пустышек', () => {
  it('каждый ключ начинается с /api и не оканчивается слешем', () => {
    for (const route of Object.keys(PUBLIC_API_ROUTES)) {
      expect(route.startsWith('/api')).toBe(true);
      expect(route.endsWith('/')).toBe(false);
    }
  });

  it('каждая запись реально совпадает хотя бы с одним конкретным путём', () => {
    // Молчаливая поломка №1 была именно такой: правило есть, совпадений нет.
    for (const [route, methods] of Object.entries(PUBLIC_API_ROUTES)) {
      const sample = route.replace(/\*/g, 'sample-id');
      const method = methods === 'ALL' ? 'GET' : methods[0];
      expect(isPublicApiPath(sample, method)).toBe(true);
    }
  });
});
