#!/usr/bin/env node
/**
 * Замер снимка: насколько он «яркий» для обложки карточки.
 *
 * Повод — владелец 12.10, с телефона о главной: «почти все туры с каким-то
 * серым небом, а хочется поярче фоток». Герой карточки — первый снимок
 * галереи тура (lib/tours/hero-image), а первым у импортированных туров
 * стоял первый снимок со страницы оператора, каким бы он ни был.
 *
 * Что меряется (на уменьшенной до 160 px копии, по каждому пикселю):
 *   sat      — средняя насыщенность (HSV S), 0…1;
 *   lum      — средняя яркость, 0…255;
 *   colorful — «цветность» по Hasler–Süsstrunk (2003): разброс и смещение
 *              осей rg / yb; серый кадр — около 10, сочный — 60 и выше;
 *   skyGray  — доля пикселей ВЕРХНЕЙ ТРЕТИ кадра, которые светлые и
 *              ненасыщенные, то есть серое или белёсое небо, 0…1.
 *
 * Оценка обложки — `coverScore`: цветность минус штраф за серое небо.
 * Она решает только спор «какой из снимков ярче». Что на снимке — сюжет,
 * автобус вместо вертолёта, дорога вместо озера — число не видит, это
 * смотрят глазами (миграция 1221, сторож tests/unit/tour-covers-brighter).
 *
 * CLI: node scripts/photo-vividness.mjs public/images/mestechko [ещё каталоги]
 * Печатает JSON-массив замеров. sharp — devDependency, в прод-бандл не идёт.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/** Верхняя треть кадра — там небо; ниже горизонт и земля. */
const SKY_SHARE = 0.35;
/** Светлый и ненасыщенный пиксель в небе — серое или белёсое небо. */
const SKY_GRAY = { maxSat: 0.14, minLum: 95, maxLum: 235 };
/** Вес серого неба в оценке: кадр с небом сплошь серым теряет 40 пунктов цветности. */
const SKY_PENALTY = 40;

/** @typedef {{ sat: number; lum: number; colorful: number; skyGray: number }} Vividness */

/** @param {string} absPath @returns {Promise<Vividness>} */
export async function measurePhoto(absPath) {
  const { data, info } = await sharp(absPath).rotate().resize({ width: 160 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const skyRows = Math.floor(height * SKY_SHARE);
  let sumSat = 0, sumLum = 0, n = 0;
  let rgSum = 0, ybSum = 0, rgSq = 0, ybSq = 0;
  let skyN = 0, skyGray = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sumSat += sat; sumLum += lum; n++;
      const rg = r - g, yb = 0.5 * (r + g) - b;
      rgSum += rg; ybSum += yb; rgSq += rg * rg; ybSq += yb * yb;
      if (y < skyRows) {
        skyN++;
        if (sat < SKY_GRAY.maxSat && lum > SKY_GRAY.minLum && lum < SKY_GRAY.maxLum) skyGray++;
      }
    }
  }
  const rgMean = rgSum / n, ybMean = ybSum / n;
  const rgStd = Math.sqrt(Math.max(0, rgSq / n - rgMean * rgMean));
  const ybStd = Math.sqrt(Math.max(0, ybSq / n - ybMean * ybMean));
  const colorful = Math.sqrt(rgStd ** 2 + ybStd ** 2) + 0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2);
  return {
    sat: +(sumSat / n).toFixed(3),
    lum: +(sumLum / n).toFixed(0),
    colorful: +colorful.toFixed(1),
    skyGray: skyN === 0 ? 0 : +(skyGray / skyN).toFixed(2),
  };
}

/** Оценка обложки: цветность минус серое небо. Больше — ярче. */
export function coverScore(/** @type {Vividness} */ v) {
  return +(v.colorful - SKY_PENALTY * v.skyGray).toFixed(1);
}

async function main(dirs) {
  const out = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (!/\.(jpe?g|png)$/i.test(f)) continue;
      const p = join(dir, f);
      if (!statSync(p).isFile()) continue;
      const v = await measurePhoto(p);
      out.push({ file: p, ...v, score: coverScore(v) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('Укажите каталоги со снимками: node scripts/photo-vividness.mjs public/images/mestechko');
    process.exit(2);
  }
  main(dirs).catch((err) => { console.error(err); process.exit(1); });
}
