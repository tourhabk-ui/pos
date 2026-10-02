/**
 * Картинка метаданных обязана существовать.
 *
 * Аудит SEO 29.09 (Н6): `/icons/og-image.jpg` у всех `/plans/*` и
 * `/trip/[token]`, `/og-image.jpg` в JSON-LD `/contact` отвечали 404 —
 * файлов не было никогда. Поиск это почти не задевает, но ссылка, которую
 * человек пересылает в мессенджер, приходила без картинки.
 *
 * Сторож собирает из исходников `app/` все локальные пути картинок в
 * метаданных (`url: '/…jpg'`, `images: ['/…']`, `image: 'https://vedarai.ru/…'`)
 * и требует файл в `public/`. Динамические пути (шаблонные строки) не
 * проверяются — их источник БД.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const IMG = String.raw`\/[A-Za-z0-9_\-./]+\.(?:jpe?g|png|webp|gif|svg)`;
const PATTERNS = [
  new RegExp(String.raw`\burl:\s*['"](${IMG})['"]`, 'g'),
  new RegExp(String.raw`\bimages:\s*\[\s*['"](${IMG})['"]`, 'g'),
  new RegExp(String.raw`\bimage:\s*['"]https:\/\/vedarai\.ru(${IMG})['"]`, 'g'),
  new RegExp(String.raw`\bimage:\s*['"](${IMG})['"]`, 'g'),
  // Картинка по умолчанию с 02.10 объявлена ОДИН раз, константой в lib/seo.
  new RegExp(String.raw`DEFAULT_OG_IMAGE = ['"](${IMG})['"]`, 'g'),
];

describe('картинки метаданных существуют', () => {
  const refs: { file: string; path: string }[] = [];
  for (const file of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib', 'seo'))]) {
    const src = readFileSync(file, 'utf-8');
    for (const re of PATTERNS) for (const m of src.matchAll(re)) refs.push({ file: file.slice(ROOT.length + 1), path: m[1] });
  }

  it('перепись не пуста', () => {
    // 02.10: страницы берут defaultOgImages() и своих путей не держат —
    // литералов стало три (константа по умолчанию, рыбалка, виджет), и
    // меньше одного быть не может: сама картинка по умолчанию — литерал.
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs.some(r => r.path === '/images/og/vedar-1200x630.jpg'), 'константа DEFAULT_OG_IMAGE в переписи').toBe(true);
  });

  it('каждый локальный путь есть в public/', () => {
    const missing = refs.filter(r => !existsSync(join(ROOT, 'public', r.path))).map(r => `${r.file}: ${r.path}`);
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
