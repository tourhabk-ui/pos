/**
 * Watchdog стережёт запросы мест в трансфере, а не пустоту.
 *
 * ── История ────────────────────────────────────────────────────────────────
 *
 * Проверка заведена 27.07 как симметрия booking-доменов: туры, жильё и
 * снаряжение уже были под >24ч-надзором, трансферы оставались слепым пятном.
 * Жила она в `transfer-operator-hub.test.ts` вместе со сторожами кабинета
 * перевозчика — сайдбара, форм, онбординга.
 *
 * 01.09 кабинет удалён: перепись реестра схемы (прогоны 2 и 3, канарейка
 * видна) показала, что на проде нет ни одной таблицы прежнего модуля, и все
 * его экраны падали с 42P01 по построению. Сторожа кабинета ушли вместе с
 * предметом — стеречь нечего.
 *
 * А эта проверка осталась: забота настоящая, просто перенацелена на схему 926.
 * Поэтому она переехала в отдельный файл, а не исчезла заодно с соседями.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WATCHDOG = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');

describe('watchdog: запросы мест в трансфере под надзором', () => {
  it('проверка существует и включена в прогон', () => {
    expect(WATCHDOG).toContain('checkPendingTransferBookings');
    expect(WATCHDOG).toContain("'pending_transfer_booking'");
    expect(WATCHDOG).toContain('FROM transfer_seat_bookings sb');
    expect(WATCHDOG).toContain("sb.status = 'requested'");
    expect(WATCHDOG).toContain("INTERVAL '24 hours'");
    // Мёртвых имён в живом стороже быть не должно: иначе он снова начнёт
    // краснеть «НЕ ПРОВЕРЕНО» вместо того, чтобы проверять.
    expect(WATCHDOG).not.toContain('FROM transfer_bookings');
    expect(WATCHDOG).not.toContain('JOIN operators');
    // Включена в прогон, а не мёртвая функция.
    const checks = /const CHECKS\b[^[]*?=\s*\[([\s\S]*?)\n\s*\];/.exec(WATCHDOG)?.[1] ?? '';
    expect(checks).toMatch(/\bcheckPendingTransferBookings\b/);
  });

  it('пинок перевозчику не ведёт на удалённую страницу', () => {
    // Кабинет перевозчика на схеме 926 ещё не построен, а прежний путь удалён.
    // Ссылка в несуществующий адрес обещала бы экран, которого нет.
    //
    // Комментарии снимаются: шапка самой проверки в watchdog.ts ОБЪЯСНЯЕТ, куда
    // ссылки больше нет, и потому называет удалённый путь. Объяснение запрета —
    // не нарушение, и различать их обязан извлекатель, а не удача.
    const code = WATCHDOG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('notifyTransferOperatorDirectly');
    expect(code).not.toContain('/hub/transfer-operator');
  });
});
