/**
 * Перепись потерь на запертой двери: считает точно, ПД не выносит,
 * невидимую потерю называет вслух.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARTNER_ROLES, CONTROL_ROLE } from '@/app/api/cron/locked-out-partners/route';

const SRC      = readFileSync(join(process.cwd(), 'app/api/cron/locked-out-partners/route.ts'), 'utf-8');
const REGISTER = readFileSync(join(process.cwd(), 'app/api/auth/register/route.ts'), 'utf-8');

describe('роли те же, что у регистрации', () => {
  it('список партнёрских ролей совпадает с PARTNER_ROLE_SET регистрации', () => {
    const m = REGISTER.match(/PARTNER_ROLE_SET = new Set\(\[([^\]]+)\]\)/);
    expect(m, 'набор партнёрских ролей в регистрации не найден').not.toBeNull();
    const inRegister = (m as RegExpMatchArray)[1]
      .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    expect([...PARTNER_ROLES].sort()).toEqual(inRegister);
  });

  it('контрольная роль — та, у которой в регистрации отдельная ветка VALUES', () => {
    expect(CONTROL_ROLE).toBe('operator');
    expect(REGISTER).toMatch(/partnerRole === 'operator'/);
    expect(REGISTER).toMatch(/VALUES \(\$1, \$2, 'operator'/);
  });

  it('контроль не выброшен из ответа: он и есть улика о причине', () => {
    expect(SRC).toContain('control_reads_as');
    expect(SRC).toContain('control_role');
  });

  it('вывод о причине не делается, когда контроля нет', () => {
    expect(SRC).toMatch(/операторов в базе нет — контроля нет/);
  });
});

describe('персональные данные не выносятся в лог', () => {
  it('почта и имя не выбираются вовсе', () => {
    expect(SRC).not.toMatch(/\bu\.email\b|\bu\.name\b|SELECT[^;]*email/i);
  });

  it('оговорка про 152-ФЗ стоит в ответе, а не только в шапке', () => {
    expect(SRC).toContain('pii_note');
  });
});

describe('перепись честна о своих границах', () => {
  it('невидимая потеря названа, а не молча опущена', () => {
    expect(SRC).toContain('invisible_loss');
  });

  it('обрезка списка объявлена', () => {
    expect(SRC).toContain('lost_rows_truncated');
  });

  it('отказ переписи — отказ, а не «потерь нет»', () => {
    expect(SRC).toMatch(/console\.error\('\[locked-out-partners\] перепись не удалась/);
    expect(SRC).toMatch(/ok: false/);
  });

  it('только чтение', () => {
    expect(SRC).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });
});
