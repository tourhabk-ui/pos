/**
 * Ни один литерал-пароль не уходит в hashPassword.
 *
 * Находка эволюции #999 (07.08, критикал, DeepSeek): импортёр Местечка
 * хешировал '1234567890' — предсказуемый пароль оператора = вход любому, кто
 * знает email. Первый настоящий улов руки эволюции после расшивки дедлока
 * пробника (#992). Сторож ловит весь класс: пароль в hashPassword должен быть
 * переменной (ввод пользователя или crypto-генерация), не строковым/числовым
 * литералом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

describe('нет захардкоженных паролей', () => {
  it('hashPassword никогда не вызывается со строковым или числовым литералом', () => {
    const files = [...walk('app'), ...walk('lib'), ...walk('scripts').filter(() => true)].filter(Boolean);
    // hashPassword( '…' )  или  hashPassword( 123 ) — литерал прямо в аргументе.
    const bad = /hashPassword\(\s*(['"`]|\d)/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      if (bad.test(src)) offenders.push(f);
    }
    expect(offenders, `литерал-пароль в hashPassword: ${offenders.join(', ')}`).toEqual([]);
  });

  it('импортёр Местечка отдаёт one_time_password и не содержит 1234567890', () => {
    const src = readFileSync(join(ROOT, 'app/api/admin/import-mestechko/route.ts'), 'utf-8');
    expect(src).not.toMatch(/1234567890/);
    expect(src).toMatch(/randomBytes\(/);
    expect(src).toMatch(/one_time_password/);
  });
});
