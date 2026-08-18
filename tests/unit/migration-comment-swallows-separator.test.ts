/**
 * Комментарий не должен съедать разделитель.
 *
 * 18.08 миграция 874 не применилась на проде, и перепись честно покраснела:
 * «column rw.link_kind does not exist». Причина была не в базе и не в правах —
 * в 238 строках списка значений запятые оказались ПОСЛЕ `--`:
 *
 *   ('uuid','uuid')  -- 653,
 *
 * То есть каждый разделитель был закомментирован. Postgres не разобрал VALUES,
 * транзакция откатилась целиком, и колонки не появилось.
 *
 * Ошибка тихая по своей природе: файл выглядит правильным, глаз читает запятую
 * в конце строки и не замечает, что она за комментарием. А цена — молчаливо
 * пропущенная миграция, которая обнаруживается только когда об неё спотыкается
 * код на проде.
 *
 * Сторож читает ФАЙЛЫ и ищет ровно этот признак: строка-комментарий,
 * заканчивающаяся запятой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'migrations');

describe('в миграциях нет закомментированных разделителей', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

  it('файлов миграций найдено', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('ни одна строка не заканчивается запятой внутри комментария', () => {
    const bad: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(DIR, f), 'utf-8').split('\n');
      lines.forEach((line, i) => {
        const at = line.indexOf('--');
        if (at === -1) return;
        const code = line.slice(0, at).trim();
        // Строка-проза (комментарий с начала строки) законно переносится и
        // законно кончается запятой — там нечего разделять.
        if (!code) return;
        // Код уже несёт свой разделитель — запятая в тексте безобидна.
        if (code.endsWith(',')) return;
        const tail = line.slice(at).trimEnd();
        if (!tail.endsWith(',')) return;
        bad.push(`${f}:${i + 1} → ${line.trim()}`);
      });
    }
    expect(
      bad,
      `запятая-разделитель спрятана в комментарии — миграция не разберётся:\n${bad.join('\n')}`,
    ).toEqual([]);
  });
});
