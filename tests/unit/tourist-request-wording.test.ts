/**
 * Ведар — информационная система, а не туроператор и не турагент (решение
 * владельца 08.10): платформа передаёт запрос туриста и его контакты оператору.
 * Значит, турист не «бронирует» тур у нас — он отправляет оператору заявку.
 *
 * Сторож держит главные поверхности, где турист видит слово: кнопки, страницу
 * заявки, кабинет, письма и сообщения. Комментарии и идентификаторы не судятся
 * (вырезаются до проверки); слова-триггеры ввода Кузьмича живут вне списка.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SURFACES = [
  'app/catalog/tours/[id]/_TourDetailClient.tsx',
  'app/booking-success/[id]/_BookingSuccessClient.tsx',
  'components/marketplace/BookingFormClient.tsx',
  'components/marketplace/MarketplaceClient.tsx',
  'app/routes/[id]/_RouteDetailClient.tsx',
  'app/calendar/_CalendarClient.tsx',
  'app/operators/[slug]/page.tsx',
  'components/kuzmich/KuzmichWidget.tsx',
  'app/hub/tourist/layout.tsx',
  'app/hub/tourist/_TouristDashboardClient.tsx',
  'app/hub/tourist/bookings/page.tsx',
  'app/hub/tourist/bookings/_BookingHistoryPageClient.tsx',
  'lib/bookings/success-view.ts',
  'lib/telegram/booking-notify.ts',
  'lib/notifications/booking-notifications.ts',
  'lib/notifications/email-service.ts',
  'lib/help/content.ts',
];

// Видимые туристу формы «брони» тура. Операторские тексты в этих файлах их
// не содержат; если понадобятся — это повод разделить файл, а не ослабить список.
const FORBIDDEN = [
  /Забронировать/,
  /Мои бронирования/,
  /Бронирование принято/,
  /Оператор подтвердил бронирование/,
  /Бронь подтверждена/,
  /Номер брони/,
  /Детали бронирования/,
  /Бронирование не найдено/,
];

const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('турист отправляет заявку оператору, а не бронирует у платформы', () => {
  for (const f of SURFACES) {
    it(f, () => {
      const code = strip(readFileSync(f, 'utf8'));
      for (const re of FORBIDDEN) expect(code, `${f}: ${re}`).not.toMatch(re);
    });
  }

  it('кнопка каталога и карточки маршрута — «Отправить заявку»', () => {
    expect(readFileSync('components/marketplace/MarketplaceClient.tsx', 'utf8')).toMatch(/Отправить заявку/);
    expect(readFileSync('app/routes/[id]/_RouteDetailClient.tsx', 'utf8')).toMatch(/Отправить заявку/);
  });
});
