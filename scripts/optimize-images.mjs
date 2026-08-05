#!/usr/bin/env node
/**
 * Нарезка WebP-вариантов для контентных фото.
 *
 * Владелец 06.08 с телефона: «фото долго грузится, нужно адаптировать».
 * Причина измерена: оптимизатор Next отключён осознанно (images.unoptimized —
 * sharp не влезает в лимит standalone на Timeweb), поэтому карточки грузят
 * ОРИГИНАЛЫ — 150–320 КБ на фото 1280px, галерея тура тянет 1,7 МБ разом.
 * На полевом EDGE это десятки секунд.
 *
 * Решение — то же, что уже сделано руками для бренд-графики (bear-64/128/192,
 * portrait-96/192/384): варианты нарезаются ЗАРАНЕЕ и коммитятся в git, а
 * компоненты подключают их через lib/images/variant.ts. Этот скрипт — станок,
 * который делает для контентных фото то, что для бренда сделано вручную.
 *
 * Для каждого jpg/jpeg/png тяжелее MIN_BYTES:
 *   <имя>.640.webp  — карточки, плитки, филмстрип
 *   <имя>.1280.webp — hero карточки тура (если исходник не уже)
 * Оригинал остаётся: лайтбокс и старые ссылки живут как жили.
 *
 * Манифест lib/images/photo-variants.json — список путей, у которых варианты
 * ЕСТЬ. Хелпер подменяет путь только по манифесту, поэтому 404 невозможен:
 * фото, загруженное оператором в рантайме (S3 или /tmp), в манифест не попадёт
 * и поедет оригиналом.
 *
 * sharp — devDependency: скрипт гоняется на машине разработчика и в CI-тесте
 * покрытия, в прод-бандл sharp не попадает (standalone трассирует только
 * прод-импорты).
 *
 * Идемпотентен: пересоздаёт вариант только если исходник новее.
 */

import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const IMAGES_DIR = path.join(ROOT, 'public', 'images');
const MANIFEST = path.join(ROOT, 'lib', 'images', 'photo-variants.json');

/** Легче этого — не трогаем: иконки и плейсхолдеры и так быстрые. */
const MIN_BYTES = 50 * 1024;
const WIDTHS = [640, 1280];
const QUALITY = { 640: 72, 1280: 74 };

/** Наши же сгенерированные варианты — не входы. */
const VARIANT_RE = /\.(640|1280)\.webp$/;
const SOURCE_RE = /\.(jpe?g|png)$/i;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function webPath(abs) {
  return '/' + path.relative(path.join(ROOT, 'public'), abs).split(path.sep).join('/');
}

const manifest = [];
let made = 0, kept = 0, skipped = 0;

for await (const file of walk(IMAGES_DIR)) {
  if (VARIANT_RE.test(file) || !SOURCE_RE.test(file)) continue;
  const st = await stat(file);
  if (st.size < MIN_BYTES) { skipped++; continue; }

  const meta = await sharp(file).metadata();
  const entry = { src: webPath(file), widths: [] };

  for (const w of WIDTHS) {
    // Уже вариант — не растягиваем исходник до 1280, если он 800px.
    if (w > 640 && (meta.width ?? 0) < w * 0.9) continue;
    const out = file.replace(SOURCE_RE, `.${w}.webp`);
    entry.widths.push(w);
    if (existsSync(out) && statSync(out).mtimeMs >= st.mtimeMs) { kept++; continue; }
    await sharp(file)
      .rotate() // уважить EXIF-ориентацию телефонов операторов
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: QUALITY[w] })
      .toFile(out);
    made++;
  }

  if (entry.widths.length > 0) manifest.push(entry);
}

manifest.sort((a, b) => a.src.localeCompare(b.src));
await mkdir(path.dirname(MANIFEST), { recursive: true });
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

console.log(`[images] вариантов создано: ${made}, актуальны: ${kept}, лёгких пропущено: ${skipped}`);
console.log(`[images] в манифесте: ${manifest.length} фото`);
