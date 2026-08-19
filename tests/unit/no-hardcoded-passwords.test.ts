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

/**
 * Пароль от почтового ящика не печатается на экране и не лежит в исходниках.
 *
 * Найдено 17.08 попутно: страница «Email» в админке печатала подсказку «какие
 * переменные завести в Timeweb» — и подставляла в неё НАСТОЯЩИЙ пароль ящика
 * `noreply@` строковым литералом. То есть пароль лежал в публичном
 * репозитории, уезжал в клиентский бандл и рисовался на странице.
 *
 * Подсказка о переменных не нуждается в значении секрета: имя переменной
 * говорит, что заполнить, а чем — знает тот, кто заводил ящик. Владелец
 * пароль меняет; из истории git старое значение никуда не денется, поэтому
 * единственное настоящее лекарство — ротация, а этот сторож не даёт завести
 * следующий такой же.
 */
describe('секреты почты не попадают в исходники', () => {
  const EMAIL_ADMIN = 'app/hub/admin/email/_EmailAdminClient.tsx';

  it('рядом с SMTP_PASS нет литерала-значения', () => {
    const src = readFileSync(join(ROOT, EMAIL_ADMIN), 'utf-8');
    // ['SMTP_PASS','что-то'] — ровно та форма, в которой пароль и лежал.
    // Плейсхолдер в угловых скобках разрешён: он ничего не раскрывает.
    const pair = /['"]SMTP_PASS['"]\s*,\s*['"]([^'"]*)['"]/g;
    for (const m of src.matchAll(pair)) {
      expect(m[1], `значение SMTP_PASS в ${EMAIL_ADMIN}`).toMatch(/^<.*>$/);
    }
  });

  it('во всём фронтенде нет пары SMTP_PASS со значением', () => {
    // Класс, а не одно место: страница может переехать или размножиться.
    const files = [...walk('app'), ...walk('components')];
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      for (const m of src.matchAll(/['"]SMTP_PASS['"]\s*,\s*['"]([^'"]*)['"]/g)) {
        if (!/^<.*>$/.test(m[1])) offenders.push(`${f}: ${m[1].slice(0, 3)}…`);
      }
    }
    expect(offenders, `значение SMTP_PASS в исходниках: ${offenders.join(', ')}`).toEqual([]);
  });
});
