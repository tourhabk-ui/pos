/**
 * Сторож: повторное уведомление о лиде уходит только ОПЕРАТОРУ (09.10).
 *
 * `leads-followup` шлёт имя и телефон туриста следующему оператору, если
 * первый не ответил. Запасной запрос («нет интересов или не нашли по ним»)
 * не знал категории и мог выбрать любого публичного партнёра с каналом —
 * владельца жилья, прокат, гида, агента: им уходили ПД туриста с кнопкой в
 * кабинет оператора. Держится: каждый запрос к partners в кроне — с
 * `p.category = 'operator'`, а адрес — по правилу достижимости (reachFrom),
 * не по зеркалу contacts JSONB.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/leads-followup/route.ts'), 'utf8');

describe('leads-followup: ПД туриста — только оператору', () => {
  it('каждый запрос к partners ограничен категорией operator', () => {
    const sqls = [...SRC.matchAll(/`([^`]*\bFROM partners\b[^`]*)`/g)].map((m) => m[1]);
    expect(sqls.length, 'запросы к partners не найдены — сломан поиск').toBeGreaterThanOrEqual(3);
    for (const q of sqls) expect(q, q.slice(0, 120)).toMatch(/p\.category = 'operator'/);
  });

  it('адрес — по правилу достижимости, а не по зеркалу contacts JSONB', () => {
    expect(SRC).not.toMatch(/contacts->>'telegram_chat_id'/);
    expect(SRC).toMatch(/import \{ reachFrom, type PartnerReachRow \} from '@\/lib\/partners\/reach'/);
    expect(SRC).toMatch(/const reach = reachFrom\(nextOperator\);/);
    expect(SRC).toMatch(/to: \{ maxChatId: reach\.maxChatId, telegramChatId: reach\.telegramChatId \}/);
  });
});
