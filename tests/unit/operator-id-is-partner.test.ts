/**
 * operator_tours.operator_id — это partners.id, и ничто другое.
 *
 * Схема отвечает на это внешним ключом, а не мнением:
 *   ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_operator_id_fkey
 *     FOREIGN KEY (operator_id) REFERENCES partners(id) ON DELETE CASCADE;
 *
 * Замер 23.08: СЕМЬ мест соединяли эту колонку с `users.id`. Догадка была
 * записана даже комментарием — «operators can be in either table». Оба id
 * типа uuid, поэтому Постгрес не спорил: соединение просто не совпадало
 * никогда.
 *
 * Последствия были разной тяжести, и это важно:
 *  - пять запросов брали `u.company_name`, а такой колонки у users НЕТ вовсе
 *    (миграция 052 добавила company_name в partners) — запрос падал ошибкой;
 *    это подбор туров планером и три инструмента Кузьмича для туриста;
 *  - два выбирали `u.telegram_id`, который у users есть, — эти не падали, а
 *    молча не находили оператора: он не получал уведомления о своей броне.
 *
 * Тихий отказ хуже громкого: планер краснел и это было видно, а оператор
 * просто не узнавал о брони и считал, что заявок нет.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'tests']);

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) acc.push(full);
  }
}

/** Только код: в комментариях ошибочное соединение законно названо по имени. */
const codeOf = (abs: string) =>
  readFileSync(abs, 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/** Соединение колонки оператора тура с таблицей пользователей. */
/**
 * Соединение колонки оператора тура с чем угодно, кроме partners.id.
 *
 * Первая редакция искала только `users.id = t.operator_id` — и пропустила два
 * места, где ту же ошибку записали иначе: `ot.operator_id = p.user_id`. Нашёл
 * их не этот сторож, а объектив схемы (lib/agents/evo/schema-lens.ts), потому
 * что он сравнивает с внешним ключом, а не с моим списком написаний.
 * Правило, перечисляющее формы записи, всегда отстаёт от изобретательности
 * кода; здесь оно оставлено как быстрый барьер, а полноту даёт объектив.
 */
const WRONG_JOIN =
  /\b(?:users?|u)\s*\.\s*id\s*=\s*(?:ot|t|tours?)\s*\.\s*operator_id|\b(?:ot|t)\s*\.\s*operator_id\s*=\s*(?:users?|u)\s*\.\s*id|\boperator_id\s*=\s*[a-z_]+\.user_id|\b[a-z_]+\.user_id\s*=\s*[a-z_]+\.operator_id/i;

/** Обращение к company_name у алиаса пользователей — такой колонки нет. */
const USERS_COMPANY_NAME = /\bu\s*\.\s*company_name\b/i;

describe('оператор тура — партнёр, а не пользователь', () => {
  const files: string[] = [];
  walk(join(ROOT, 'app'), files);
  walk(join(ROOT, 'lib'), files);

  it('нигде operator_id не соединяется с users.id', () => {
    const bad = files
      .filter((f) => WRONG_JOIN.test(codeOf(f)))
      .map((f) => relative(ROOT, f).split('\\').join('/'));
    expect(bad, `operator_id снова принят за id пользователя: ${bad.join(', ')}`).toEqual([]);
  });

  it('company_name нигде не читается у алиаса пользователей', () => {
    // Колонка живёт в partners (миграция 052). У users её нет — запрос падает.
    const bad = files
      .filter((f) => USERS_COMPANY_NAME.test(codeOf(f)))
      .map((f) => relative(ROOT, f).split('\\').join('/'));
    expect(bad, `u.company_name — такой колонки нет: ${bad.join(', ')}`).toEqual([]);
  });
});

describe('внешний ключ, на котором всё держится, объявлен', () => {
  it('operator_tours.operator_id ссылается на partners.id', () => {
    // Если ключ когда-нибудь переобъявят на users — правило выше станет
    // неверным, и узнать об этом надо здесь, а не по пустому подбору туров.
    const baseline = readFileSync(join(ROOT, 'lib/database/baseline/schema-baseline.sql'), 'utf-8');
    expect(baseline).toMatch(
      /operator_tours_operator_id_fkey\s+FOREIGN KEY \(operator_id\)\s+REFERENCES partners\(id\)/i,
    );
  });
});
