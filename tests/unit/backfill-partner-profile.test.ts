/**
 * Актуатор возврата партнёрских профилей: та же дисциплина, что у
 * tour-pickup и place-coords, применённая к деньгам — точнее, к людям.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/backfill-partner-profile/route.ts'), 'utf-8');

describe('дисциплина source/why/dry-run/партия', () => {
  it('source и why обязательны без умолчаний', () => {
    expect(SRC).toMatch(/source: z\.string\(\)\.trim\(\)\.min\(3/);
    expect(SRC).toMatch(/why: z\.string\(\)\.trim\(\)\.min\(3/);
  });

  it('сухой прогон по умолчанию', () => {
    expect(SRC).toMatch(/dry_run: z\.boolean\(\)\.default\(true\)/);
  });

  it('партия не больше десяти', () => {
    expect(SRC).toContain('LIVE_BATCH_MAX = 10');
    expect(SRC).toMatch(/z\.array\(ItemSchema\)\.min\(1\)\.max\(LIVE_BATCH_MAX\)/);
  });
});

describe('не заводит второй способ создания профиля', () => {
  it('вызывает ensurePartnerForRole, а не пишет свой SQL', () => {
    expect(SRC).toMatch(/import \{ ensurePartnerForRole \} from '@\/lib\/auth\/partner-profile'/);
    expect(SRC).toContain('await ensurePartnerForRole(item.user_id, item.role)');
    expect(SRC).not.toMatch(/INSERT INTO partners/);
  });

  it('сухой прогон не вызывает ensurePartnerForRole вовсе', () => {
    expect(SRC).toMatch(/if \(dry_run\) \{[\s\S]*?continue;\s*\}/);
  });
});

describe('роли ограничены известным набором', () => {
  it('ролевой enum совпадает с партнёрскими ролями регистрации', () => {
    const register = readFileSync(join(process.cwd(), 'app/api/auth/register/route.ts'), 'utf-8');
    const m = register.match(/PARTNER_ROLE_SET = new Set\(\[([^\]]+)\]\)/);
    const inRegister = (m as RegExpMatchArray)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort();
    const inRoute = Array.from(SRC.matchAll(/'(\w+)'/g))
      .map((m2) => m2[1])
      .filter((r) => inRegister.includes(r));
    // enum роута перечисляет ровно те же роли (порядок не важен, дубли не считаем)
    expect(new Set(inRoute)).toEqual(new Set(inRegister));
  });

  it('user_id проверяется как uuid', () => {
    expect(SRC).toMatch(/user_id: z\.string\(\)\.uuid\(\)/);
  });
});
