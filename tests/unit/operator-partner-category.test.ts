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
      // operatorAccess (CRM 2г) ищет кабинет с category = 'operator' — сторож
      // operator-team-access держит это в самом резолвере; гарды
      // requireOperatorOwner/requireOperatorTeam зовут его же.
      const viaHelper = ['getOperatorPartnerId(', 'operatorAccess(', 'requireOperatorOwner(', 'requireOperatorTeam(']
        .some((h) => src.includes(h));
      expect(hits.length > 0 || viaHelper, 'поиск профиля в файле не найден').toBe(true);
      for (const h of hits) {
        expect(h, `без фильтра категории: ${h}`).toMatch(/category = 'operator'/);
      }
    });
  }

  it('подборку не создаёт не-админ без кабинета оператора', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/hub/selections/route.ts'), 'utf8');
    // Кабинет — свой или команды (operatorAccess, CRM 2г-2); без него — 403
    // до проверки туров и записи, «не смогли проверить» — 503 (accessFailure).
    expect(src).toMatch(/if \(auth\.role !== 'admin'\) \{\s*const access = await operatorAccess\(auth\.userId\);\s*if \(access\.kind === 'none' && access\.reason === 'no_profile'\) \{\s*return NextResponse\.json\(\{ error: 'Подборки создаёт оператор: профиль оператора не найден' \}, \{ status: 403 \}\);/);
    expect(src).toMatch(/if \(access\.kind !== 'owner' && access\.kind !== 'manager'\) return accessFailure\(access\);\s*operatorId = access\.partnerId;/);
  });

  it('период аналитики валидируется Zod, а не голым parseInt', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/operator/analytics/route.ts'), 'utf8');
    expect(src).toMatch(/z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(365\)/);
    expect(src).not.toMatch(/parseInt\(searchParams\.get\('period'\)/);
  });
});
