/**
 * Миграция 1509: вулкан Пийпа в описании /park/komandorskiy.
 * Факты — ИВиС ДВО РАН и сайт парка; не утверждаем, что вулкан внутри границ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const SQL = readFileSync(join(root, 'migrations/1509_park_komandorskiy_piip.sql'), 'utf-8');

const rows = [...SQL.matchAll(/\(\s*'([a-z-]+)',\s*'((?:[^']|'')*)'\)/g)].map((m) => ({
  slug: m[1],
  txt: m[2].replace(/''/g, "'"),
}));

describe('миграция 1509: Пийпа на странице Командорского парка', () => {
  it('дописывает только komandorskiy и только один раз', () => {
    expect(rows.map((r) => r.slug)).toEqual(['komandorskiy']);
    expect(SQL).toContain("SET description = btrim(p.description) || E'\\n' || src.txt");
    expect(SQL).toContain('position(src.txt IN p.description) = 0');
  });

  it('называет подводный вулкан Пийпа рядом с парком, без «внутри границ»', () => {
    const txt = rows[0].txt;
    expect(txt).toMatch(/подводный вулкан Пийпа/);
    expect(txt).toMatch(/70 км/);
    expect(txt).toMatch(/острова Беринга/);
    expect(txt).toMatch(/300 м ниже уровня моря/);
    expect(txt).toMatch(/1984/);
    expect(txt).toMatch(/^Рядом с парком/);
    expect(txt).not.toMatch(/внутри границ|входит в парк|на территории парка/i);
    expect(txt).not.toMatch(/₽|руб|цена/i);
  });

  it('в комментарии миграции указаны источники ИВиС и сайта парка', () => {
    expect(SQL).toMatch(/geoportal\.kscnet\.ru\/volcanoes\/volc\.php\?lang=ru&name=Piip/);
    expect(SQL).toMatch(/commanderislands\.ru\/territoriya/);
    expect(SQL).toMatch(/30 морских миль/);
  });
});
