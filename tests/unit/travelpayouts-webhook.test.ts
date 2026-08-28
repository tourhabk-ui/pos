/**
 * TravelPayouts webhook — идемпотентность повторной доставки (P2, аудит 28.08).
 *
 * Роут писал каждое поступившее событие без единой защиты от дубля —
 * повторная доставка того же события задваивала бы строку и деньги партнёра.
 * TravelPayouts не гарантирует click_id в payload и не даёт отдельный
 * event-id, поэтому дедуп по (tp_click_id, status) возможен только когда
 * click_id есть — это ограничение источника, названное в коде явно (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/webhooks/travelpayouts/route.ts'),
  'utf-8',
);

describe('travelpayouts webhook: дедуп повторной доставки', () => {
  it('INSERT идёт через ON CONFLICT DO NOTHING, не голым INSERT', () => {
    expect(SRC).toMatch(/ON CONFLICT \(tp_click_id, status\) WHERE tp_click_id IS NOT NULL DO NOTHING/);
  });

  it('ответ честно называет, записалось ли новое событие или это дубль', () => {
    expect(SRC).toMatch(/stored: \(rowCount \?\? 0\) > 0/);
  });

  it('токен по-прежнему проверяется до записи', () => {
    const authAt = SRC.indexOf('X-Access-Token');
    const insertAt = SRC.indexOf('INSERT INTO affiliate_payouts');
    expect(authAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(insertAt);
  });
});
