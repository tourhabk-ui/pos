/**
 * Профиль оператора ищется с category = 'operator'.
 *
 * У одного user_id бывает несколько записей partners (гид + оператор —
 * обычный случай). `SELECT id FROM partners WHERE user_id = $1 LIMIT 1` без
 * фильтра категории отдаёт произвольную — аналитика, подборки, отчёт по
 * лидам и скоуп владения лидом уходили на гид-профиль, и оператор не видел
 * своего. Эталон — getOperatorPartnerId (lib/auth/operator-helpers.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  'app/api/operator/analytics/route.ts',
  'app/api/hub/selections/route.ts',
  'app/api/hub/operator/leads/report/route.ts',
  'lib/leads/ownership.ts',
];

const LOOKUP = /FROM partners WHERE user_id = \$1[^\n`"]*/g;

describe('поиск профиля оператора по user_id', () => {
  for (const f of FILES) {
    it(`${f}: каждый поиск фильтрует category = 'operator'`, () => {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      const hits = src.match(LOOKUP) ?? [];
      const viaHelper = src.includes('getOperatorPartnerId(');
      expect(hits.length > 0 || viaHelper, 'поиск профиля в файле не найден').toBe(true);
      for (const h of hits) {
        expect(h, `без фильтра категории: ${h}`).toMatch(/category = 'operator'/);
      }
    });
  }

  it('подборку не создаёт не-админ без профиля оператора', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/hub/selections/route.ts'), 'utf8');
    expect(src).toMatch(/auth\.role !== 'admin' && !operatorId\)[\s\S]{0,200}status: 403/);
  });

  it('период аналитики валидируется Zod, а не голым parseInt', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/operator/analytics/route.ts'), 'utf8');
    expect(src).toMatch(/z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(365\)/);
    expect(src).not.toMatch(/parseInt\(searchParams\.get\('period'\)/);
  });
});
