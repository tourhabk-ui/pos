/**
 * Каждый openGraph страницы несёт картинку.
 *
 * Next.js заменяет openGraph страницы целиком: свой openGraph без images —
 * и картинка из app/layout.tsx пропадает (сборка 01.10: у /guides, /faq,
 * /about в пререндере нет og:image, у /tools без своего openGraph — есть).
 * Аудит 01.10: 464 страницы из 897 раскрывались в мессенджере голой ссылкой.
 *
 * Правило: у объекта openGraph ключ images на верхнем уровне. Условная
 * подстановка `...(x ? { images } : {})` не считается — она и давала пустоту,
 * когда снимка нет. Нет своей картинки — defaultOgImages().
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defaultOgImages } from '@/lib/seo/og-image';

const ROOT = process.cwd();

function files(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

/** Тело объекта после `openGraph: {` до парной скобки. */
function objectBodies(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/openGraph:\s*\{/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** Текст объекта без вложенных скобок — только ключи верхнего уровня. */
function topLevel(body: string): string {
  let depth = 0;
  let out = '';
  for (const ch of body) {
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

const HAS_IMAGES = /(^|[\s,])images\s*(:|,|$)/;

describe('openGraph без картинки не остаётся', () => {
  it('у каждого openGraph в app/ ключ images на верхнем уровне', () => {
    const bad: string[] = [];
    for (const f of files(join(ROOT, 'app'))) {
      const src = readFileSync(f, 'utf-8');
      for (const body of objectBodies(src)) {
        if (!HAS_IMAGES.test(topLevel(body))) bad.push(relative(ROOT, f));
      }
    }
    expect(bad).toEqual([]);
  });

  it('условная подстановка картинки не засчитывается', () => {
    expect(HAS_IMAGES.test(topLevel(" url: x, ...(img ? { images: [img] } : {}),"))).toBe(false);
    expect(HAS_IMAGES.test(topLevel(' url: x, images: img ? [img] : defaultOgImages(),'))).toBe(true);
    expect(HAS_IMAGES.test(topLevel(' url: x, images,'))).toBe(true);
  });

  // Ключ на месте, а картинки нет: `images: x ? [x] : []` — у шести подборок
  // ссылка уходила без превью (аудит vedarai.ru 01.10). Запас — defaultOgImages().
  // `undefined` и `null` — то же самое: ключ есть, картинки нет (аудит 01.10,
  // /operators/kamchatka-rafting).
  const EMPTY_FALLBACK = /\bimages\s*:[^\n]*(?::|\?\?|\|\|)\s*(?:\[\s*\]|undefined\b|null\b)/;

  it('пустой массив как запас не засчитывается', () => {
    const bad: string[] = [];
    for (const f of files(join(ROOT, 'app'))) {
      const src = readFileSync(f, 'utf-8');
      for (const body of objectBodies(src)) {
        if (EMPTY_FALLBACK.test(body)) bad.push(relative(ROOT, f));
      }
    }
    expect(bad).toEqual([]);
    expect(EMPTY_FALLBACK.test(' images: col.cover_image ? [col.cover_image] : [],')).toBe(true);
    expect(EMPTY_FALLBACK.test(' images: list ?? [],')).toBe(true);
    expect(EMPTY_FALLBACK.test(' images: x ? [{ url: x }] : undefined,')).toBe(true);
    expect(EMPTY_FALLBACK.test(' images: x ?? null,')).toBe(true);
    expect(EMPTY_FALLBACK.test(' images: col.cover_image ? [col.cover_image] : defaultOgImages(),')).toBe(false);
  });

  it('картинка по умолчанию лежит в public и отдаётся новым массивом', () => {
    const [img] = defaultOgImages();
    expect(existsSync(join(ROOT, 'public', img.url))).toBe(true);
    expect(img.alt.length).toBeGreaterThan(0);
    expect(defaultOgImages()).not.toBe(defaultOgImages());
  });

  it('layout берёт ту же картинку, а не свою копию', () => {
    const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf-8');
    expect(layout).toMatch(/images: defaultOgImages\(\)/);
    expect(layout).not.toMatch(/url: '\/images\/hero\/hero-light\.jpeg'/);
  });
});
