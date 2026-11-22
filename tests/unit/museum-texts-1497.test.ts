/**
 * Миграция 1497 (#3487, сверка 21.11): с текстов двух музеев партии 7 (1488)
 * сняты утверждения, которые источник не держит, — переименование
 * Елизовского музея и «первый на Камчатке интерактивный промышленный музей»
 * у Океанрыбфлота. Держит:
 *  - правка ложится только на текст, который 1488 записала слово в слово
 *    (md5 считается здесь из самой 1488, а не переписан руками);
 *  - новый текст — тот же текст 1488 без снятого, ничего не дописано;
 *  - снятых утверждений в новых текстах нет;
 *  - источники и журнал происхождения на месте, решение владельца не тронуто.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const read = (name: string) => readFileSync(join(__dirname, '../../migrations', name), 'utf-8');
const SQL_1488 = read('1488_thin_texts_batch7.sql');
const SQL_1497 = read('1497_museum_texts_unconfirmed_claims.sql');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const un = (s: string) => s.replace(/''/g, "'");

function texts1488(): Map<string, { txt: string; sources: string[] }> {
  const out = new Map<string, { txt: string; sources: string[] }>();
  const re = /\(\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'::jsonb\)/g;
  for (const m of SQL_1488.matchAll(re)) out.set(un(m[1]), { txt: un(m[2]), sources: JSON.parse(un(m[3])) });
  return out;
}

interface Row { slug: string; oldMd5: string; txt: string; sources: string[] }
function rows1497(): Row[] {
  const re = /\(\s*'((?:[^']|'')*)',\s*'([0-9a-f]{32})',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'::jsonb\)/g;
  return [...SQL_1497.matchAll(re)].map((m) => ({ slug: un(m[1]), oldMd5: m[2], txt: un(m[3]), sources: JSON.parse(un(m[4])) }));
}

const REMOVED: Record<string, string> = {
  'elizovskij-kraevedcheskij-muzej':
    ' В октябре 2026 года учреждение получило нынешнее имя — муниципальное бюджетное учреждение культуры «Елизовский краеведческий музей»; прежде оно называлось «Елизовский районный краеведческий музей».',
  'muzej-okeanrybflota': ' — первый на Камчатке интерактивный промышленный музей. Он',
};

describe('миграция 1497: утверждения без подтверждения сняты с текстов музеев', () => {
  const before = texts1488();
  const rows = rows1497();

  it('ровно два места, оба из партии 1488', () => {
    expect(rows.map((r) => r.slug).sort()).toEqual(['elizovskij-kraevedcheskij-muzej', 'muzej-okeanrybflota']);
    for (const r of rows) expect(before.has(r.slug), r.slug).toBe(true);
  });

  it('правка ложится только на текст 1488 слово в слово: md5 — из самой 1488', () => {
    for (const r of rows) expect(r.oldMd5, r.slug).toBe(md5(before.get(r.slug)!.txt));
    expect(SQL_1497).toMatch(/WHERE md5\(t\.description\) = s\.old_md5/);
  });

  it('новый текст — текст 1488 без снятого; ничего не дописано', () => {
    for (const r of rows) {
      const old = before.get(r.slug)!.txt;
      expect(old.includes(REMOVED[r.slug]), r.slug).toBe(true);
      expect(r.txt, r.slug).toBe(old.replace(REMOVED[r.slug], ''));
    }
  });

  it('снятых утверждений в новых текстах нет', () => {
    const all = rows.map((r) => r.txt).join('\n');
    expect(all).not.toMatch(/получило нынешнее имя|прежде оно называлось|районный/);
    expect(all).not.toMatch(/первый на Камчатке|промышленный музей/);
    // Факты, которые остаются, — на месте.
    expect(all).toContain('на улице Виталия Кручины, 13');
    expect(all).toContain('на улице Ключевской, 32');
    expect(all).toContain('Корпоративный музей открылся 1 апреля 2022 года');
  });

  it('источники — те же, что у 1488; журнал происхождения пишется; решение владельца не трогается', () => {
    for (const r of rows) expect(r.sources, r.slug).toEqual(before.get(r.slug)!.sources);
    expect(SQL_1497).toContain("'fact-check'");
    expect(SQL_1497).toMatch(/INSERT INTO description_provenance/);
    expect(SQL_1497).toMatch(/dp_owner\.written_by = 'owner-decision'/);
  });
});
