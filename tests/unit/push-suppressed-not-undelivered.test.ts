// @vitest-environment node
/**
 * Сторож: заглушённый дубль push — решение, а не недоставка.
 *
 * ── Что нашлось 29.09 ─────────────────────────────────────────────────────
 *
 * Watchdog прислал КРИТ: «алерт без доставки push > 30 мин (самый ранний: К
 * берегам Камчатки приближается циклон…). Туристы не предупреждены. VAPID ок,
 * подписок 1». Диспетчер (`dispatchPushAlerts`) с 14.09 не шлёт второй звонок
 * об одном типе, пока первый действует, и помечает такую строку
 * `push_suppressed_at` (миграция 957). Из своей выборки он её исключает; а
 * сторож, панель здоровья и `config-check` спрашивали только `push_sent_at IS
 * NULL` — и считали заглушённый дубль недоставленным до самого истечения.
 *
 * Тест 14.09 сам предупреждал, что «недоставка спрячется от сторожа», если
 * решение записать как «отправлено», и потому завёл отдельную колонку. Но
 * читателей колонки не научили: третий исход был записан и никем не читался
 * (§10.09) — КРИТ о людях, которых уже предупредили первым звонком.
 *
 * Обратная сторона держится тоже: незаглушённая и неотправленная строка всё
 * ещё обязана считаться — сторож не должен ослепнуть.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*--.*$/gm, '');

/** Читатели «недоставленного push». Новый читатель вносится сюда. */
const READERS = [
  'lib/agents/watchdog.ts',
  'lib/services/safety/alert-delivery-health.ts',
  'app/api/admin/config-check/route.ts',
];

describe('читатели недоставленного push знают о заглушённых', () => {
  for (const file of READERS) {
    it(`${file}: заглушённая строка не считается недоставленной`, () => {
      const src = code(read(file));
      const at = src.indexOf('push_sent_at IS NULL');
      expect(at, 'запрос о недоставленном push не найден').toBeGreaterThan(-1);
      expect(src.slice(at, at + 200), 'читатель снова считает заглушённый дубль недоставкой')
        .toMatch(/push_suppressed_at IS NULL/);
    });
  }

  it('диспетчер и читатели отбирают одинаково', () => {
    const dispatch = code(read('app/api/cron/safety-ingest/route.ts'));
    expect(dispatch).toMatch(/push_sent_at IS NULL\s+AND push_suppressed_at IS NULL/);
  });

  it('перепись показывает третий исход рядом с «разослан»', () => {
    const census = code(read('app/api/cron/alerts-census/route.ts'));
    expect(census).toMatch(/push_suppressed_at::text AS push_suppressed_at/);
    expect(census).toMatch(/push_suppressed_reason: r\.push_suppressed_reason/);
  });

  it('незаглушённая и неотправленная строка по-прежнему считается', () => {
    // Сторож не должен ослепнуть: условие о недоставке на месте.
    const wd = code(read('lib/agents/watchdog.ts'));
    expect(wd).toMatch(/push_sent_at IS NULL/);
    expect(wd).toMatch(/created_at < NOW\(\) - INTERVAL '30 minutes'/);
  });
});
