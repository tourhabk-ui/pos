/**
 * Карточки «Парк «Ключевской»» и «Остров Старичков», оставшиеся без единого
 * снимка после 1263 и 1265, получают снимки Commons с названным автором
 * (15.10, миграция 1271).
 *
 * Держится связка происхождения, а не текст подписи:
 *   ключ хранилища → файл, залитый media-to-s3 (тот же размер, что записан в
 *   галерее) → страница Commons с той же пропорцией оригинала (размеры —
 *   imageinfo, проба 941) → автор и свободная лицензия у строки;
 *   кадров партнёров без согласия среди них нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jpegSize } from '../helpers/jpeg-size';

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1271_klyuchevskoy_starichkov_commons_photos.sql'), 'utf-8');
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

const STARICHKOV = '4dd86a74-d010-4ff4-81ad-23af3ba966a5';
const KLYUCHEVSKOY = '1c93607e-9a9e-4abc-a7dc-0a1b774c21d0';

/** Размеры оригиналов на Commons — imageinfo (проба 941). */
const ORIGINAL: Record<string, [number, number]> = {
  'Остров Старичков - Фото 1.jpg': [3488, 2616],
  'Птичий базар на острове Старичков.jpg': [4368, 2912],
  'Вид на остров Старичков, кекур Караульный и кекур Часовой.jpg': [4640, 2088],
  'Ključevskaja za východu slunce.jpg': [2048, 1536],
  'Klyuchevskaya Sopka eruption - Kamchatka, Russian Federation - Summer 1993 03.jpg': [7500, 5000],
  'Вулкан ключевская сопка.jpg': [1100, 721],
};

interface Row {
  place: string; width: number; height: number; caption: string; author: string;
  license: string; licenseUrl: string | null; source: string; key: string;
}

const q = (v: string): string | null => (v === 'NULL' ? null : v.slice(1, -1));
const ROWS: Row[] = [...BODY.matchAll(
  /\('([0-9a-f-]{36})', \d+, (\d+), (\d+),\s+'([^']+)',\s+'([^']+)', '([^']+)', ('[^']*'|NULL),\s+'([^']+)',\s+'([^']+\.jpg)'\)/g,
)].map((m) => ({
  place: m[1], width: Number(m[2]), height: Number(m[3]), caption: m[4], author: m[5],
  license: m[6], licenseUrl: q(m[7]), source: m[8], key: m[9],
}));
const titleOf = (source: string) => decodeURIComponent(source.replace(/^.*\/File:/, '')).replace(/_/g, ' ');

describe('миграция 1271: снимки двум карточкам без снимков', () => {
  it('по три кадра каждой карточке', () => {
    expect(ROWS).toHaveLength(6);
    expect(ROWS.filter((r) => r.place === STARICHKOV)).toHaveLength(3);
    expect(ROWS.filter((r) => r.place === KLYUCHEVSKOY)).toHaveLength(3);
  });

  it('у обеих карточек главным кадром стоял кадр партнёра — 1256 и 1250', () => {
    const m1256 = readFileSync(join(ROOT, 'migrations/1256_petropavlovsk_nature_monuments.sql'), 'utf-8');
    const m1250 = readFileSync(join(ROOT, 'migrations/1250_volcanoes_national_park_cards.sql'), 'utf-8');
    expect(m1256).toContain('photos/starichkov/mestechko-');
    const heroes1250 = m1250.slice(m1250.indexOf('WITH heroes'), m1250.indexOf('INSERT INTO ai_route_images'));
    expect(heroes1250.slice(heroes1250.indexOf(`('${KLYUCHEVSKOY}',`), heroes1250.indexOf(`('${KLYUCHEVSKOY}',`) + 300)).toMatch(/'Край Вулканов'/);
  });

  it('кадров партнёров без согласия среди них нет', () => {
    for (const r of ROWS) {
      expect(r.author, r.key).not.toMatch(/Местечко|Край Вулканов/);
      expect(r.key, r.key).not.toMatch(/mestechko|kraj-vulkanov/);
    }
  });

  it('автор, свободная лицензия со ссылкой и страница файла Commons у каждого кадра', () => {
    for (const r of ROWS) {
      expect(r.source, r.key).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(Object.keys(ORIGINAL), r.key).toContain(titleOf(r.source));
      if (r.license === 'Общественное достояние') {
        expect(r.licenseUrl, r.key).toBeNull();
      } else {
        expect(r.license, r.key).toMatch(/^CC BY(-SA)? \d\.\d$/);
        const v = r.license.match(/(\d\.\d)$/)![1];
        expect(r.licenseUrl, r.key).toBe(`https://creativecommons.org/licenses/by-sa/${v}`);
      }
    }
  });

  it('файл хранилища — пережатый оригинал именно той страницы, что названа в строке', () => {
    for (const r of ROWS) {
      const orig = ORIGINAL[titleOf(r.source)];
      expect(Math.max(r.width, r.height), r.key).toBe(Math.min(1600, Math.max(...orig)));
      expect(Math.abs(r.width / r.height - orig[0] / orig[1]), r.key).toBeLessThan(0.01);
    }
  });

  it('файл залит media-to-s3, и его размер — тот, что записан в галерее', () => {
    const items = (JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
      run: number; items: Array<{ file: string; key: string }>;
    });
    expect(items.run).toBeGreaterThanOrEqual(15);
    for (const r of ROWS) {
      const item = items.items.find((i) => i.key === r.key);
      expect(item, r.key).toBeDefined();
      expect(jpegSize(readFileSync(join(ROOT, item!.file))), r.key).toEqual({ width: r.width, height: r.height });
    }
  });

  it('повтор ничего не добавляет; галерея встаёт следом за тем, что у места уже есть', () => {
    expect(BODY).toMatch(/AND NOT EXISTS \(SELECT 1 FROM place_gallery_photos g\s+WHERE g\.ark_id = p\.ark_id AND g\.s3_key = s\.s3_key\)/);
    expect(BODY).toMatch(/COALESCE\(\(SELECT max\(g\.position\) FROM place_gallery_photos g WHERE g\.ark_id = p\.ark_id\), 0\) \+ s\.ord/);
    expect(BODY).not.toMatch(/DELETE FROM|UPDATE ai_route_images/);
  });
});
