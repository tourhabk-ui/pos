/**
 * Портрет Кузьмича на главной: файлы должны лежать там, куда указывает разметка.
 *
 * Повод: секция «Проводник Кузьмич» была цитатой без говорящего — лица у
 * проводника не существовало ни одного. Портрет добавлен, и вместе с ним
 * появился новый способ тихо сломаться: путь в `src`/`srcSet` — обычная
 * строка, переименование папки в `public/` компилятор не заметит, а турист
 * увидит битую картинку на месте лица.
 *
 * Поэтому проверяем не «есть ли где-то webp», а ровно те пути, которые
 * страница отдаёт браузеру: они извлекаются из исходника, а не перечислены
 * здесь списком.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/_home/_HomeV8Client.tsx'), 'utf-8');

/** Все пути на картинки Кузьмича, которые реально попадут в HTML. */
function portraitPaths(): string[] {
  const code = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  return [...new Set([...code.matchAll(/\/images\/kuzmich\/[\w.-]+\.webp/g)].map((m) => m[0]))];
}

describe('портрет Кузьмича на главной', () => {
  const paths = portraitPaths();

  it('разметка вообще ссылается на портрет', () => {
    expect(paths.length, 'портрет пропал из секции «Проводник Кузьмич»').toBeGreaterThan(0);
  });

  it('каждый путь существует в public/', () => {
    for (const p of paths) {
      expect(existsSync(join(ROOT, 'public', p)), `нет файла public${p}`).toBe(true);
    }
  });

  it('портрет весит по-мобильному, а не как исходник в 1024 px', () => {
    // Исходник из набора владельца — 855 КБ. Отдавать его в секцию главной
    // значит платить мегабайтом за медальон 72×72 на связи в поле.
    for (const p of paths) {
      const kb = statSync(join(ROOT, 'public', p)).size / 1024;
      expect(kb, `${p} слишком тяжёлый: ${Math.round(kb)} КБ`).toBeLessThan(60);
    }
  });

  it('у портрета есть текстовая альтернатива', () => {
    expect(SRC).toMatch(/className="face"[\s\S]{0,400}?alt="[^"]+"/);
  });
});
