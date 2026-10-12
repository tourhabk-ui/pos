// @vitest-environment node
/**
 * Обложки туров витрины — ярче ПО ЗАМЕРУ, а не по памяти шапки (миграция
 * 1221; владелец 12.10: «почти все туры с каким-то серым небом, а хочется
 * поярче фоток», «почему облёт вулкана Толбачик вертолёт, а на фото
 * автобус ПАЗ?»).
 *
 * Держит связку целиком (§10.09):
 *  - каждая новая обложка лежит в public/ и нарезана (манифест
 *    lib/images/photo-variants.json) — карточка не поедет оригиналом;
 *  - форма UPDATE безопасна: обложка переставляется в начало галереи, только
 *    если в галерее есть, и только если ещё не первая; tour_image — зеркало;
 *  - снятый стоковый автобус удалён и из репозитория, и из манифеста;
 *  - оценка новой обложки ВЫШЕ прежней (первого снимка галереи по миграции,
 *    которая её завела) — считается здесь тем же scripts/photo-vividness.mjs,
 *    которым выбирали. Число судит только яркость; сюжет судили глазами, и
 *    снятый автобус из сравнения исключён: он ярче вертолёта на лаве, но
 *    не про тур.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { measurePhoto, coverScore } from '../../scripts/photo-vividness.mjs';
import manifest from '@/lib/images/photo-variants.json';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const strip = (s: string) => s.replace(/--[^\n]*/g, '');
const SQL = strip(read('migrations/1221_tour_covers_brighter.sql'));
const MESTECHKO = strip(read('migrations/1217_mestechko_tours.sql'));
const VOLCANOES = strip(read('migrations/1177_volcanoesland_photos_and_card_public.sql'));
const FISHINGKAM = strip(read('migrations/836_fishingkam_distinct_galleries.sql'));
/** Тот же порог, что в scripts/optimize-images.mjs и tests/unit/photo-variants. */
const MIN_BYTES = 50 * 1024;
const IN_MANIFEST = new Set((manifest as Array<{ src: string }>).map((e) => e.src));

/** Снятые из галерей снимки. */
const REMOVED = [...SQL.matchAll(/array_remove\(photos, '(\/images\/[^']+)'\)/g)].map((m) => m[1]);
/** Перестановки по slug. */
const MOVES = [...SQL.matchAll(/\('((?:mestechko|volcanoesland)-[a-z0-9-]+)',\s*'(\/images\/[^']+)'\)/g)]
  .map((m) => ({ key: m[1], cover: m[2] }));
/** Рыбалка — по id тура. */
const FISH_ID = /WHERE ot\.id = (\d+)\s/.exec(SQL)?.[1];
const FISH_COVER = /ARRAY\['(\/images\/fishingkam\/[^']+)'\]::text\[\] \|\| array_remove\(ot\.photos, '\1'\)/.exec(SQL)?.[1];

const photosOf = (arr: string) => [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** Первый снимок галереи по миграции, которая её завела, без снятых. */
function priorCover(key: string): string | undefined {
  let arr: string | undefined;
  if (key.startsWith('mestechko-')) {
    arr = new RegExp(`'${key}',[\\s\\S]*?ARRAY\\[('/images/mestechko/[^\\]]*)\\]::text\\[\\]`).exec(MESTECHKO)?.[1];
  } else if (key.startsWith('volcanoesland-')) {
    arr = new RegExp(`\\('${key}',\\s*ARRAY\\[([^\\]]*)\\]`).exec(VOLCANOES)?.[1];
  } else {
    arr = new RegExp(`\\(${key},\\s*ARRAY\\[([^\\]]*)\\]`).exec(FISHINGKAM)?.[1];
  }
  return arr ? photosOf(arr).filter((p) => !REMOVED.includes(p))[0] : undefined;
}

describe('миграция 1221: форма и файлы', () => {
  it('перестановок не меньше дюжины, ключи не повторяются, рыбалка названа', () => {
    expect(MOVES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(MOVES.map((m) => m.key)).size).toBe(MOVES.length);
    expect(FISH_ID).toBe('5');
    expect(FISH_COVER).toBe('/images/fishingkam/catch-05.jpg');
  });

  it('обложка переставляется, а не переписывает галерею; только если есть и ещё не первая; tour_image — зеркало', () => {
    expect(SQL).toContain('ARRAY[v.cover]::text[] || array_remove(ot.photos, v.cover)');
    expect(SQL).toContain('AND v.cover = ANY(ot.photos)');
    expect(SQL).toContain('AND ot.photos[1] IS DISTINCT FROM v.cover');
    expect(SQL).toMatch(/tour_image = v\.cover/);
    expect(SQL).toMatch(/ot\.deleted_at IS NULL/);
    expect(SQL).toMatch(/ILIKE 'камчатская рыбалка'/);
    // Каждое присваивание photos — перестановка (|| array_remove), не замена галереи литералом.
    const sets = SQL.match(/photos\s*=\s*ARRAY\[[^\n]*/g) ?? [];
    expect(sets.length).toBeGreaterThanOrEqual(2);
    for (const line of sets) expect(line).toMatch(/\|\| array_remove\(ot\.photos, /);
  });

  it('каждая новая обложка лежит на диске и нарезана', () => {
    const covers = [...MOVES.map((m) => m.cover), FISH_COVER!];
    for (const c of covers) {
      const file = join(ROOT, 'public', c);
      expect(existsSync(file), c).toBe(true);
      // Нарезка — только тяжёлым (порог scripts/optimize-images.mjs); лёгкий снимок едет оригиналом.
      if (statSync(file).size >= MIN_BYTES) {
        expect(IN_MANIFEST.has(c), `${c} не в манифесте нарезки — npm run images`).toBe(true);
      }
    }
  });

  it('снятый автобус: назван, из галереи вертолётного тура, удалён с диска и из манифеста', () => {
    expect(REMOVED).toEqual(['/images/mestechko/vertolet-tolbachik-01.jpg']);
    expect(SQL).toMatch(/slug = 'mestechko-vertolet-tolbachik'[\s\S]*?= ANY\(photos\)/);
    for (const r of REMOVED) {
      expect(existsSync(join(ROOT, 'public', r)), r).toBe(false);
      for (const w of [320, 640, 1280]) expect(existsSync(join(ROOT, 'public', r.replace(/\.jpg$/, `.${w}.webp`)))).toBe(false);
      expect(IN_MANIFEST.has(r)).toBe(false);
    }
    // Новая обложка того же тура — не снятый снимок.
    const heli = MOVES.find((m) => m.key === 'mestechko-vertolet-tolbachik');
    expect(heli?.cover).toBeDefined();
    expect(REMOVED).not.toContain(heli!.cover);
  });
});

describe('миграция 1221: новая обложка ярче прежней по замеру', () => {
  const pairs = [...MOVES, { key: FISH_ID!, cover: FISH_COVER! }];
  for (const { key, cover } of pairs) {
    it(`${key}: ${cover.split('/').pop()}`, async () => {
      const prior = priorCover(key);
      expect(prior, `прежняя обложка ${key} не найдена в миграции-источнике`).toBeDefined();
      expect(prior).not.toBe(cover);
      const [was, now] = await Promise.all([
        measurePhoto(join(ROOT, 'public', prior!)),
        measurePhoto(join(ROOT, 'public', cover)),
      ]);
      expect(coverScore(now), `${cover} ${JSON.stringify(now)} не ярче ${prior} ${JSON.stringify(was)}`).toBeGreaterThan(coverScore(was));
    });
  }
});
