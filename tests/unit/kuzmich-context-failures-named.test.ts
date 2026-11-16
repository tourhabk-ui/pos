/**
 * Отказ сборки данных хода Кузьмича называется в логе (#3199, K9).
 *
 * До 16.11 пять мест данных хода глушили отказ формой `.catch(() => '')`:
 * live-контекст (погода, новости, МЧС), обогащение (места, база знаний), туры к
 * месту рядом с прайсом машин и контекст места человека в обоих чатах сайта.
 * Пустая строка уходила в промпт как «данных нет», и упавший запрос жил
 * незамеченным ровно столько, сколько никто не смотрит (§4.0: ловить можно,
 * молчать нельзя).
 *
 * Теперь каждое такое место пишет `logSwallowedFailure` со своим источником.
 * Регулярка здесь только запрещает форму (CLAUDE.md §4, «Сторож судит
 * поведение»): вернуть `.catch(() => '')` в путь данных хода — красный.
 * Распознаватель общего долга (`lib/quality/empty-catch.ts`) эту форму не
 * считает намеренно — у пустой строки бывает честный смысл «значения нет», —
 * поэтому запрет здесь узкий: только путь, по которому данные идут в модель.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SILENT = /\.catch\(\s*\(\s*\)\s*=>\s*(''|"")\s*\)/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...tsFiles(rel));
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

describe('данные хода Кузьмича: отказ не глушится пустой строкой', () => {
  const files = [
    ...tsFiles('lib/kuzmich'),
    'app/api/ai/chat/route.ts',
    'app/api/ai/chat-stream/route.ts',
  ];

  it('путь данных хода найден — сторож не пустой', () => {
    expect(files).toContain('lib/kuzmich/core.ts');
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s — нет `.catch(() => \'\')`', (file) => {
    const lines = readFileSync(join(ROOT, file), 'utf-8').split('\n');
    const hits = lines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => SILENT.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .map(({ n }) => `${file}:${n}`);
    expect(hits, 'отказ снова глушится пустой строкой — назовите его через logSwallowedFailure').toEqual([]);
  });
});
