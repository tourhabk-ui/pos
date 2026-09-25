/**
 * Watchdog «лид без ответа > 2 ч» обязан видеть лиды, разобранные ИИ.
 *
 * Сторож считал только `status = 'new'`, а конвейер (lead-processor) переводит
 * лид в `ai_qualified` за секунды после создания. Итог: лид, которого не
 * открыл ни один человек, для сторожа был «обработан», и тревога не
 * срабатывала почти никогда. Разбор ИИ — не ответ человеку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD_STATUSES, UNATTENDED_LEAD_STATUSES } from '@/lib/types/statuses';

const WATCHDOG = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf8');

function checkBody(): string {
  const start = WATCHDOG.indexOf('async function checkUnprocessedLeads');
  expect(start).toBeGreaterThan(-1);
  const end = WATCHDOG.indexOf('\n}\n', start);
  return WATCHDOG.slice(start, end);
}

describe('набор «человек ещё не взял»', () => {
  it('включает new, ai_processing и ai_qualified', () => {
    expect([...UNATTENDED_LEAD_STATUSES].sort()).toEqual(['ai_processing', 'ai_qualified', 'new']);
  });

  it('не включает статусы, которые ставит действие человека', () => {
    for (const s of ['proposal_sent', 'awaiting_confirm', 'contacted', 'qualified', 'converted', 'lost']) {
      expect(UNATTENDED_LEAD_STATUSES).not.toContain(s);
    }
  });

  it('каждый статус набора существует в LEAD_STATUSES', () => {
    for (const s of UNATTENDED_LEAD_STATUSES) expect(LEAD_STATUSES).toContain(s);
  });
});

describe('checkUnprocessedLeads', () => {
  it('фильтрует по набору, а не по одному new', () => {
    const body = checkBody();
    expect(body).toContain('UNATTENDED_LEAD_STATUSES');
    expect(body).toMatch(/status\s*=\s*ANY\(\$1::text\[\]\)/);
    expect(body).not.toMatch(/status\s*=\s*'new'/);
  });

  it('отказ запроса не глушится — checkFailure с именем проверки', () => {
    expect(checkBody()).toContain("checkFailure('checkUnprocessedLeads'");
  });
});
