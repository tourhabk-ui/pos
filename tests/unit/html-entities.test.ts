/**
 * Сторож разворота сущностей: один проход, и ни одного второго.
 *
 * js/double-escaping, 5 находок 23.08.2026. Цепочка `.replace()` разворачивает
 * текст дважды, и `&amp;lt;` — то, как автор записал СТРОКУ `&lt;`, —
 * превращается в символ `<`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { decodeHtmlEntities, normalizePunctuation } from '@/lib/html/entities';

describe('разворот идёт ровно один раз', () => {
  it('&amp;lt; остаётся строкой &lt;, а не становится тегом', () => {
    // Это и есть дефект: результат первой замены читался второй.
    expect(decodeHtmlEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('&amp;amp; разворачивается в &amp;, а не в &', () => {
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
  });

  it('обычные сущности разворачиваются', () => {
    expect(decodeHtmlEntities('Иванов &amp; Ко')).toBe('Иванов & Ко');
    expect(decodeHtmlEntities('&lt;p&gt;')).toBe('<p>');
    expect(decodeHtmlEntities('&laquo;Ведар&raquo;')).toBe('«Ведар»');
    expect(decodeHtmlEntities('&#171;Ведар&#187;')).toBe('«Ведар»');
    expect(decodeHtmlEntities('а&nbsp;б')).toBe('а б');
  });

  it('неизвестная сущность остаётся как написана', () => {
    // Молча выбросить — значит потерять текст, не сказав об этом (§4.0).
    expect(decodeHtmlEntities('&copy; 2026')).toBe('&copy; 2026');
    expect(decodeHtmlEntities('&#8212;')).toBe('&#8212;');
  });

  it('регистр имени сущности не важен', () => {
    expect(decodeHtmlEntities('&AMP;')).toBe('&');
  });
});

describe('нормализация знаков — отдельное решение', () => {
  it('ёлочки и тире приводятся к простым', () => {
    expect(normalizePunctuation('«Ведар» — тур')).toBe('"Ведар" - тур');
  });

  it('разворот сам по себе знаки НЕ нормализует', () => {
    expect(decodeHtmlEntities('&laquo;a&raquo;')).toBe('«a»');
  });
});

describe('цепочек разворота в репозитории не осталось', () => {
  // `.claude` — вендорные скрипты плагинов, не код платформы; правки в них
  // теряются при обновлении плагина. Оговорка не пустая: в
  // .claude/skills/impeccable/scripts/live-manual-edit-evidence.mjs та же
  // цепочка есть (`&amp;` разворачивается перед `&lt;`/`&gt;`). В 81 находке
  // CodeQL от 23.08.2026 её нет, и чинить чужой файл мы не стали — но и
  // делать вид, что её нет, тоже.
  const SKIP = new Set(['node_modules', '.next', '.git', '.claude', 'public', 'migrations', 'docs', 'tests']);
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx|js|mjs)$/.test(e)) acc.push(p);
    }
    return acc;
  };

  it('ни один файл не разворачивает &amp; отдельной заменой', () => {
    // Именно эта замена и открывает второй проход: всё, что после неё,
    // читает уже развёрнутый текст.
    const offenders = walk(process.cwd())
      .filter((f) => !f.endsWith(join('lib', 'html', 'entities.ts')))
      .filter((f) => {
        const src = readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
        return /replace\(\s*\/&amp;\//.test(src);
      })
      .map((f) => f.replace(process.cwd() + '/', ''));
    expect(offenders, `цепочка разворота вернулась: ${offenders.join(', ')}`).toEqual([]);
  });
});
