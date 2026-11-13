/**
 * Точка кадра считается по самому снимку (12.11, «карт-бланш» владельца после
 * жалобы «на десктопной тоже небо вместо локаций»).
 *
 * Ручной список `PHOTO_FOCUS_Y` лечит только просмотренные снимки: новая
 * вертикальная обложка снова показала бы в плитке 16:10 одно небо. Станок
 * `scripts/photo-focus.mjs` ищет, где кончается ровное небо и начинаются
 * детали, и ставит окно плитки чуть выше этого места.
 *
 * Сторож держит три вещи:
 *   1) правило — на синтетических кадрах: небо срезается, деталь, с которой
 *      начинается содержимое, всегда остаётся в окне (голова человека, вершина
 *      вулкана), а снимок без неба, без деталей или не портретный не двигается;
 *   2) файл `lib/images/photo-focus.json` совпадает с тем, что правило даёт на
 *      снимках с диска: новый снимок без прогона `npm run images` — красный;
 *   3) порядок: ручная точка главнее посчитанной, посчитанная — главнее верха.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '@/lib/images/photo-focus.json';
import {
  focusFromPixels, photoFocusFor, keyOf, PHOTOS_DIR, MARGIN, TILE_RATIO, TOP_T,
} from '../../scripts/photo-focus.mjs';
import { PHOTO_FOCUS_Y, photoFocusY, tourPhotoPosition } from '@/lib/tours/photo-focus';

const W = 48;

/** Портрет 3:4: ровное небо до строки `contentRow`, ниже — пёстрые детали. */
function skyThenDetail(contentRow: number, height = 64, srcW = 960, srcH = 1280) {
  const data = new Uint8Array(W * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (y < contentRow) { data[i] = 120; data[i + 1] = 170; data[i + 2] = 230; }
      else {
        const v = ((x * 37 + y * 61) % 7) * 30;
        data[i] = v; data[i + 1] = 255 - v; data[i + 2] = (v * 3) % 255;
      }
    }
  }
  return { data, width: W, height, srcW, srcH };
}

describe('правило точки кадра', () => {
  it('небо над пейзажем срезается, начало деталей остаётся в окне', () => {
    const height = 64;
    for (let row = 8; row < height - 1; row++) {
      const px = skyThenDetail(row, height);
      const t = row / height;
      const y = focusFromPixels(px);
      if (t < TOP_T) { expect(y, `строка ${row}`).toBeNull(); continue; }
      expect(y, `строка ${row}`).not.toBeNull();
      expect(y! % 5, `строка ${row}: шаг 5`).toBe(0);
      const visible = px.srcW / px.srcH / TILE_RATIO;
      const top = (y! / 100) * (1 - visible);
      // Верх окна выше начала содержимого: вершина и голова целы.
      expect(top, `строка ${row}: окно ${top.toFixed(3)} ниже содержимого ${t.toFixed(3)}`).toBeLessThan(t);
      // И небо действительно срезано, когда его много.
      if (t - MARGIN < 1 - visible) expect(top, `строка ${row}`).toBeGreaterThan(t - MARGIN - 0.03);
    }
  });

  it('деталь в самом верху кадра — верх кадра (рыбак во весь рост)', () => {
    expect(focusFromPixels(skyThenDetail(0))).toBeNull();
    expect(focusFromPixels(skyThenDetail(5))).toBeNull();
  });

  it('деталей нет вовсе — правило не знает, где предмет, и не двигает', () => {
    expect(focusFromPixels(skyThenDetail(64))).toBeNull();
  });

  it('не портрет — точка не нужна', () => {
    expect(focusFromPixels(skyThenDetail(40, 64, 1280, 960))).toBeNull();
    expect(focusFromPixels(skyThenDetail(40, 64, 1000, 1000))).toBeNull();
  });
});

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(jpe?g|png)$/i.test(entry)) acc.push(full);
  }
  return acc;
}

const auto = manifest as Record<string, number>;

describe('lib/images/photo-focus.json — то, что правило даёт на снимках с диска', () => {
  it('каждый снимок в media/s3/photos посчитан, лишних записей нет', async () => {
    const files = walk(PHOTOS_DIR);
    expect(files.length).toBeGreaterThan(100);
    const wrong: string[] = [];
    const keys = new Set<string>();
    for (const file of files) {
      const key = keyOf(file);
      keys.add(key);
      const y = await photoFocusFor(file);
      const m = Object.prototype.hasOwnProperty.call(auto, key) ? auto[key] : null;
      // Допуск 10: декодер на другой машине может сдвинуть строку на одну.
      const ok = y == null ? m == null : m != null && Math.abs(m - y) <= 10;
      if (!ok) wrong.push(`${key}: в файле ${m}, правило даёт ${y}`);
    }
    for (const key of Object.keys(auto)) if (!keys.has(key)) wrong.push(`${key}: снимка нет на диске`);
    expect(
      wrong,
      `Точки кадра устарели — прогоните \`npm run images\` и закоммитьте lib/images/photo-focus.json:\n${wrong.join('\n')}`,
    ).toEqual([]);
  }, 60_000);

  it('записи — точки 5..100 с шагом 5', () => {
    for (const [key, y] of Object.entries(auto)) {
      expect(Number.isInteger(y) && y > 0 && y <= 100 && y % 5 === 0, `${key}: ${y}`).toBe(true);
    }
  });
});

describe('порядок: ручная точка, посчитанная, верх кадра', () => {
  const S3 = '/api/images/s3/photos/';

  it('ручная главнее посчитанной (у каньона станок видит хребет, глаз — водопад)', () => {
    const key = 'laguna-expedition/kanon-opasnyj-cover';
    expect(PHOTO_FOCUS_Y[key]).toBe(65);
    expect(auto[key]).not.toBe(65);
    expect(photoFocusY(`${S3}${key}.jpg`)).toBe(65);
  });

  it('снимок вне ручного списка встаёт на посчитанную точку во всех адресах', () => {
    const key = Object.keys(auto).find((k) => !(k in PHOTO_FOCUS_Y) && existsSync(join(PHOTOS_DIR, `${k}.jpg`)));
    expect(key).toBeDefined();
    const y = auto[key!];
    for (const src of [`${S3}${key}.jpg`, `${S3}${key}.640.webp`, `https://vedarai.ru${S3}${key}.jpg?v=1`]) {
      expect(tourPhotoPosition(src), src).toBe(`50% ${y}%`);
    }
  });

  it('снимок, которого станок не видел (загружен в рантайме), — верх кадра', () => {
    expect(tourPhotoPosition(`${S3}some-operator/uploaded-yesterday.jpg`)).toBe('50% 0%');
  });
});
