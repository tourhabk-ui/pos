/**
 * Таблица, к которой обращается код, объявлена в репозитории.
 *
 * ── Откуда правило ─────────────────────────────────────────────────────────
 *
 * За один день трижды нашлась одна и та же беда: обращение к колонке, которой
 * нет. `operator_bookings.tour_id` в панели тревог, в сервисе туров и в
 * аналитике оператора; `reviews.tour_id` не того типа; `route_waypoints`
 * объявлена с двумя UUID, а на проде place_id — text.
 *
 * Причина не в невнимательности. Схема-источник НЕПОЛНА: тридцать таблиц не
 * создаются ни миграцией, ни baseline. Разработчик (и я) выводит схему из
 * миграций — и выводит неверно, потому что там её нет. Проверить нечем, и
 * ошибка доживает до прода, где падает в проглоченном catch.
 *
 * Среди неучтённых — не мелочь: весь модуль трансферов (шесть таблиц),
 * `operators`, `payments`, `payouts`, `vouchers`, профили и документы туриста.
 * И `routes` — при том что CLAUDE.md прямо запрещает к ней обращаться.
 *
 * ── Почему список заморожен, а не «почините всё» ───────────────────────────
 *
 * Тридцать таблиц не описать за один заход, и требовать этого от следующей
 * правки — способ выключить сторож в первую же неделю. Список ЗАМОРОЖЕН: он
 * может только сокращаться. Новое имя вне списка валит тест, пока таблицу не
 * объявят миграцией или не внесут сюда осознанно.
 *
 * Тот же приём, что у замороженного реестра LLM-провайдеров (§8, D2), и по
 * той же причине: запретить рост беды дешевле, чем разом убрать накопленное.
 */
import { describe, it, expect } from 'vitest';
import { undeclaredTables, declaredTables } from '@/lib/db/schema-coverage';

/**
 * Таблицы, к которым код обращается, а репозиторий их не объявляет.
 *
 * Замер 19.08.2026. Список может только сокращаться — добавлять сюда новое
 * значит соглашаться, что схему снова нельзя будет проверить.
 */
const KNOWN_UNDECLARED = new Set([
  // Модуль трансферов целиком: описан в lib/database/transfer_schema.sql,
  // который НЕ применяется ничем — это не миграция, а файл рядом.
  'transfer_bookings', 'transfer_schedules', 'transfer_vehicles',
  'transfer_drivers', 'transfer_notifications', 'transfer_payments',
  // seat_holds ушла 22.08.2026 вместе с кодом удержания мест: таблицы не
  // существовало ни в миграциях, ни в схеме, а гонку закрывает FOR UPDATE
  // NOWAIT в createBookingWithLock.
  'transfer_options', 'operator_booking_transfers',
  // Оператор трансферов; описан в lib/database/operators_schema.sql, тоже
  // вне реестра. На нём стоят и запросы трансферов, и админские ручки.
  'operators',
  // Деньги: не описаны нигде в репозитории вовсе.
  'payments', 'payouts', 'vouchers',
  // Турист: профиль, документы, поездки, достижения, списки.
  // tourist_documents объявлена миграцией 903 (22.08.2026): форма собрана по
  // живому коду, который с ней работает.
  'tourist_profiles', 'tourist_trips', 'trip_bookings',
  'tourist_achievements', 'tourist_reviews', 'tourist_wishlist',
  'tourist_checklists', 'tourist_notification_preferences',
  // Согласия и аудит согласий (152-ФЗ) — тем более странно не иметь схемы.
  'user_agreements', 'agreement_audit_log', 'content_consents',
  // Прочее.
  'agents', 'operator_reviews', 'tour_images', 'weather_cache',
  // `routes` — обращение к ней CLAUDE.md прямо запрещает: только
  // v_kamchatka_routes_api или kamchatka_routes. Держится здесь как
  // напоминание, а не как разрешение.
  'routes',
]);

describe('схема репозитория покрывает то, что спрашивает код', () => {
  it('объявленных таблиц найдено достаточно — разбор работает', () => {
    const declared = declaredTables();
    expect(declared.size).toBeGreaterThan(200);
    expect(declared.has('kamchatka_routes')).toBe(true);
    expect(declared.has('operator_tours')).toBe(true);
    expect(declared.has('route_waypoints')).toBe(true);
  });

  it('новых необъявленных таблиц не появилось', () => {
    const fresh = undeclaredTables()
      .map((t) => t.table)
      .filter((t) => !KNOWN_UNDECLARED.has(t));
    expect(
      fresh,
      'таблица без CREATE TABLE в миграциях: схему нельзя проверить, и ошибка в колонке дойдёт до прода',
    ).toEqual([]);
  });

  it('список только сокращается — исчезнувшие имена удаляются из него', () => {
    // Иначе список тихо превратится в свалку, и «заморожен» перестанет
    // что-либо значить.
    const still = new Set(undeclaredTables().map((t) => t.table));
    const stale = [...KNOWN_UNDECLARED].filter((t) => !still.has(t));
    expect(stale, 'таблица объявлена — уберите её из KNOWN_UNDECLARED').toEqual([]);
  });
});
