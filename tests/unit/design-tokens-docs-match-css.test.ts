/**
 * Сторож: таблицы токенов в инструкциях агентов совпадают со стилями.
 *
 * Повод — сверка инструкций 13.11 (руководство Anthropic для Fable 5.2:
 * устаревшая заметка исполняется буквально). В `.claude/DESIGN_SYSTEM.md`
 * четыре значения светлой темы остались от прежнего оранжевого акцента:
 * hover синей кнопки значился оранжевым `#B83E0A`, фон страницы — кремовым
 * `#FAFAF9`. Агент, взявший hex из таблицы, получил бы цвет, которого на
 * сайте нет. Тёмная тема при этом совпадала — половина таблицы была верной,
 * и потому ей верили.
 *
 * Источник значений один — `app/globals.css`. Таблицы в `DESIGN_SYSTEM.md` и
 * в `CLAUDE.md` §2 — его пересказ; сторож держит пересказ равным источнику.
 * Судится артефакт (значение токена), а не форма строки.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const CSS = read('app/globals.css');

/** Значения токенов из блока стилей: `--name: value;`. */
function tokensOf(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) out.set(m[1], m[2].trim());
  return out;
}

/**
 * Тело блока, строка селектора которого начинается с `selectorStart`, — до
 * первой закрывающей скобки в начале строки. У тёмной темы селекторов два
 * через запятую, поэтому ищется начало строки, а не строка целиком.
 */
function blockOf(selectorStart: string): string {
  const at = CSS.indexOf(`\n${selectorStart}`);
  if (at < 0) return '';
  const open = CSS.indexOf('{', at);
  const end = CSS.indexOf('\n}', open);
  return CSS.slice(open, end);
}

const DARK = tokensOf(blockOf(':root[data-theme="dark"]'));
const LIGHT = tokensOf(blockOf(':root[data-theme="light"]'));

/** `#D4623C` и `#d4623c`, `rgba(0,0,0,.07)` и `rgba(0, 0, 0, 0.07)` — одно значение. */
function norm(v: string): string {
  return v.toLowerCase().replace(/\s+/g, '').replace(/(^|[(,])\./g, '$10.');
}

const VALUE = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i;

interface Row { token: string; dark: string; light: string; line: string }

/** Строки таблицы `| \`--token\` | … |` с двумя значениями цвета. */
function rows(doc: string, order: 'dark-light' | 'light-dark'): Row[] {
  const out: Row[] = [];
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const token = cells[1]?.match(/^`(--[a-z0-9-]+)`$/)?.[1];
    if (!token) continue;
    const values = cells.slice(2).map((c) => c.replace(/`/g, '')).filter((c) => VALUE.test(c));
    if (values.length !== 2) continue;
    const [a, b] = values;
    out.push(order === 'dark-light' ? { token, dark: a, light: b, line } : { token, dark: b, light: a, line });
  }
  return out;
}

function check(name: string, list: Row[]) {
  // Пустой разбор — отказ, а не успех: таблица переехала или сменила вид.
  it(`${name}: таблица токенов прочитана`, () => {
    expect(list.length, `${name}: строк с двумя значениями цвета не найдено`).toBeGreaterThanOrEqual(10);
  });

  it(`${name}: каждое значение совпадает с globals.css`, () => {
    const diff: string[] = [];
    for (const r of list) {
      const dark = DARK.get(r.token);
      const light = LIGHT.get(r.token);
      if (dark === undefined || light === undefined) {
        diff.push(`${r.token}: токена нет в globals.css (тёмная: ${dark ?? 'нет'}, светлая: ${light ?? 'нет'})`);
        continue;
      }
      if (norm(r.dark) !== norm(dark)) diff.push(`${r.token} тёмная: в таблице ${r.dark}, в стилях ${dark}`);
      if (norm(r.light) !== norm(light)) diff.push(`${r.token} светлая: в таблице ${r.light}, в стилях ${light}`);
    }
    expect(diff, `${name} разошлась со стилями — правь таблицу, источник значений — app/globals.css`).toEqual([]);
  });
}

describe('таблицы токенов в инструкциях равны стилям', () => {
  // DESIGN_SYSTEM.md: | Токен | Назначение | dark | light |
  check('.claude/DESIGN_SYSTEM.md', rows(read('.claude/DESIGN_SYSTEM.md'), 'dark-light'));
  // CLAUDE.md §2: | Токен | Light | Dark | Назначение |
  check('CLAUDE.md §2', rows(read('CLAUDE.md'), 'light-dark'));

  it('разбор стилей сам не пуст и различает темы', () => {
    // Блок не найден — это отказ разбора, а не «расхождений нет».
    expect(DARK.size, 'блок тёмной темы в globals.css не прочитан').toBeGreaterThanOrEqual(10);
    expect(LIGHT.size, 'блок светлой темы в globals.css не прочитан').toBeGreaterThanOrEqual(10);
    expect(DARK.get('--accent')).toBeTruthy();
    expect(LIGHT.get('--accent')).toBeTruthy();
    expect(norm(DARK.get('--accent') ?? '')).not.toBe(norm(LIGHT.get('--accent') ?? ''));
  });
});
