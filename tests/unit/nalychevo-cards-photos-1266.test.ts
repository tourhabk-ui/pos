/**
 * Карточки Налычева, оставшиеся без снимков после 1263, получают снимки с
 * названным автором (15.10, миграция 1266).
 *
 * Держится связка происхождения, а не текст подписи:
 *   ключ хранилища → файл, залитый media-to-s3 (те же байты, тот же размер,
 *   что записан в галерее) → файл Commons с той же пропорцией оригинала
 *   (размеры — imageinfo Commons, пробы 853 и 859) → автор и свободная
 *   лицензия у строки;
 *   снимок владельца — его собственный, из 958, с той же подписью, что в
 *   галерее парка (1248);
 *   кадров партнёров без согласия среди них нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1266_nalychevo_cards_photos_after_partner_hidden.sql'), 'utf-8');
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

const CARDS = {
  springs: 'c7c9f572-5e78-4d4f-a9ee-d0182eb313d6',
  valley: '4732f58e-63e5-4ec1-902e-f0f531391193',
  pass: '3dd2ceaf-1351-4625-9171-711eb8b1a455',
};

interface Row {
  place: string; width: number; height: number; caption: string; author: string;
  license: string | null; licenseUrl: string | null; source: string | null; key: string;
}

const q = (v: string): string | null => (v === 'NULL' ? null : v.slice(1, -1));
const ROWS: Row[] = [...BODY.matchAll(
  /\('([0-9a-f-]{36})', \d+, (\d+), (\d+),\s+'([^']+)',\s+'([^']+)', ('[^']*'|NULL), ('[^']*'|NULL),\s+('[^']*'|NULL),\s+'([^']+\.jpg)'\)/g,
)].map((m) => ({
  place: m[1], width: Number(m[2]), height: Number(m[3]), caption: m[4], author: m[5],
  license: q(m[6]), licenseUrl: q(m[7]), source: q(m[8]), key: m[9],
}));

/**
 * Размеры оригиналов Commons — imageinfo (пробы 853 и 859). Пережатие сводит
 * длинную сторону к 1600 и сохраняет пропорции: файл чужой страницы с другой
 * пропорцией здесь не пройдёт. Список кандидатов 14.10 (маркер
 * operator-photos, прогон 7) маркер не хранит — его сменяет следующая закачка.
 */
const ORIGINAL: Record<string, [number, number]> = {
  'Налычевские термальные источники.jpg': [3859, 2830],
  'Налычевские термальные источники 1.jpg': [4000, 3000],
  'Третья "лужа".JPG': [1632, 1224],
  'Nalychevo.jpg': [2000, 1500],
};
const titleOf = (source: string) => decodeURIComponent(source.replace(/^.*\/File:/, '')).replace(/_/g, ' ');

/** Ширина и высота JPEG из маркера SOF — без зависимостей. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('нет маркера SOF');
}

describe('миграция 1266: снимки карточкам без снимков', () => {
  it('пять строк: двум карточкам — по два кадра Commons, перевалу — снимок владельца', () => {
    expect(ROWS).toHaveLength(5);
    expect(ROWS.filter((r) => r.place === CARDS.springs)).toHaveLength(2);
    expect(ROWS.filter((r) => r.place === CARDS.valley)).toHaveLength(2);
    expect(ROWS.filter((r) => r.place === CARDS.pass).map((r) => r.author)).toEqual(['владелец платформы']);
  });

  it('у этих трёх карточек главным кадром стоял кадр партнёра, спрятанный 1263', () => {
    const m1248 = readFileSync(join(ROOT, 'migrations/1248_nalychevo_natural_park.sql'), 'utf-8');
    const heroes = m1248.slice(m1248.indexOf('WITH heroes'), m1248.indexOf('INSERT INTO ai_route_images'));
    for (const id of Object.values(CARDS)) {
      const at = heroes.indexOf(`('${id}',`);
      expect(at, id).toBeGreaterThan(-1);
      expect(heroes.slice(at, at + 400), id).toMatch(/'Местечко Камчатка'/);
    }
  });

  it('кадров партнёров без согласия среди них нет', () => {
    for (const r of ROWS) {
      expect(r.author, r.key).not.toMatch(/Местечко|Край Вулканов/);
      expect(r.key, r.key).not.toMatch(/mestechko|kraj-vulkanov/);
    }
  });

  it('Commons: автор, свободная лицензия и страница файла — одного из сверенных оригиналов', () => {
    const commons = ROWS.filter((r) => r.author !== 'владелец платформы');
    expect(commons).toHaveLength(4);
    for (const r of commons) {
      expect(r.source, r.key).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(Object.keys(ORIGINAL), r.key).toContain(titleOf(r.source!));
      if (r.license === 'Общественное достояние') {
        expect(r.licenseUrl, r.key).toBeNull();
      } else {
        expect(r.license, r.key).toMatch(/^CC BY(-SA)? \d\.\d$/);
        expect(r.licenseUrl, r.key).toMatch(/^https:\/\/creativecommons\.org\/licenses\/by(-sa)?\/\d\.\d$/);
      }
    }
  });

  it('файл хранилища — пережатый оригинал именно той страницы Commons, что названа в строке', () => {
    for (const r of ROWS.filter((x) => x.source)) {
      const title = titleOf(r.source!);
      const orig = ORIGINAL[title];
      expect(orig, `${r.key}: ${title}`).toBeDefined();
      expect(Math.max(r.width, r.height), r.key).toBe(Math.min(1600, Math.max(...orig)));
      expect(Math.abs(r.width / r.height - orig[0] / orig[1]), r.key).toBeLessThan(0.01);
    }
  });

  it('файл хранилища залит media-to-s3, и его размер — тот, что записан в галерее', () => {
    const items = (JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
      items: Array<{ file: string; key: string }>;
    }).items;
    for (const r of ROWS.filter((x) => x.key.startsWith('photos/'))) {
      const item = items.find((i) => i.key === r.key);
      expect(item, r.key).toBeDefined();
      expect(jpegSize(readFileSync(join(ROOT, item!.file))), r.key).toEqual({ width: r.width, height: r.height });
    }
  });

  it('снимок владельца — его собственный (958), с подписью, которую ему дала галерея парка', () => {
    const own = ROWS.find((r) => r.place === CARDS.pass)!;
    expect(own.license).toBeNull();
    expect(own.source).toBeNull();
    expect(readFileSync(join(ROOT, 'migrations/958_owner_photos_seven_places.sql'), 'utf-8')).toContain(`'${own.key}'`);
    const m1248 = readFileSync(join(ROOT, 'migrations/1248_nalychevo_natural_park.sql'), 'utf-8');
    const at = m1248.indexOf(`'${own.key}'`);
    expect(m1248.slice(Math.max(0, at - 200), at)).toContain(`'${own.caption}'`);
  });

  it('повтор ничего не добавляет; галерея встаёт следом за тем, что у места уже есть', () => {
    expect(BODY).toMatch(/AND NOT EXISTS \(SELECT 1 FROM place_gallery_photos g\s+WHERE g\.ark_id = p\.ark_id AND g\.s3_key = s\.s3_key\)/);
    expect(BODY).toMatch(/COALESCE\(\(SELECT max\(g\.position\) FROM place_gallery_photos g WHERE g\.ark_id = p\.ark_id\), 0\) \+ s\.ord/);
    expect(BODY).not.toMatch(/DELETE FROM|UPDATE ai_route_images/);
  });
});
