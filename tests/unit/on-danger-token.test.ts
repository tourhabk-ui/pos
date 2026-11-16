/**
 * Текст на заливке --danger — один токен --on-danger (аудит 09.11, п. 9в;
 * слово владельца 16.11 «карт-бланш»).
 *
 * До него на красной заливке писали белым в обеих темах. В тёмной теме
 * --danger светлый (#F85149), и белый на нём давал 3.35:1 — ниже AA 4.5:1 у
 * кнопки «112» на карточке места, у SOS в поле и поверх фото, у кнопок
 * удаления. Токен устроен как --on-accent: тёмный в тёмной теме, белый в
 * светлой.
 *
 * Сторож судит данные, а не форму строки: контраст считается по значениям
 * токенов из каждого блока темы. Регулярка — только запрет: белый текст на
 * красной заливке не возвращается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const CSS = read('app/globals.css');

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Пары (--danger, --on-danger) по блокам тем, в порядке объявления. */
function pairs(): Array<{ danger: string; on: string | null }> {
  const out: Array<{ danger: string; on: string | null }> = [];
  for (const block of CSS.split(/\n\}/)) {
    const danger = block.match(/^\s*--danger:\s*(#[0-9A-Fa-f]{6})\s*;/m)?.[1];
    if (!danger) continue;
    out.push({ danger, on: block.match(/^\s*--on-danger:\s*(#[0-9A-Fa-f]{6})\s*;/m)?.[1] ?? null });
  }
  return out;
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...tsxFiles(rel));
    else if (name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

describe('--on-danger', () => {
  it('объявлен в каждом блоке темы, где объявлен --danger', () => {
    const p = pairs();
    expect(p.length).toBeGreaterThanOrEqual(2);
    for (const { danger, on } of p) expect(on, `--danger ${danger} без --on-danger`).not.toBeNull();
  });

  it('контраст текста на красной заливке — не ниже 4.5:1 в каждой теме', () => {
    for (const { danger, on } of pairs()) {
      const ratio = contrast(danger, on!);
      expect(ratio, `${on} на ${danger}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('ds-btn-danger берёт текст из токена', () => {
    expect(CSS).toMatch(/\.ds-btn-danger\s*\{[^}]*color:\s*var\(--on-danger\)/);
  });

  it('белого текста на красной заливке нет ни в одном компоненте', () => {
    const hits: string[] = [];
    for (const file of [...tsxFiles('app'), ...tsxFiles('components')]) {
      const src = read(file);
      for (const m of src.matchAll(/["'`]([^"'`]*)["'`]/g)) {
        const cls = m[1]!;
        if (cls.includes('bg-[var(--danger)]') && /(?<![\w-])text-white(?![\w/-])/.test(cls)) hits.push(file);
      }
      // Объект стиля с красным фоном и белым текстом — в одной паре скобок.
      for (const obj of src.match(/\{[^{}]*background:\s*'var\(--danger\)'[^{}]*\}/g) ?? []) {
        if (/color:\s*'(?:#fff(?:fff)?|white|rgb\(255,\s*255,\s*255\))'/i.test(obj)) hits.push(`${file} (style)`);
      }
      // Тег с красным фоном в style и белым текстом в className.
      for (const tag of src.match(/<[A-Za-z][\w.]*\s[^<>]*?style=\{\{[^{}]*background:\s*'var\(--danger\)'[^{}]*\}\}[^<>]*>/g) ?? []) {
        if (/className="[^"]*(?<![\w-])text-white(?![\w-])/.test(tag)) hits.push(`${file} (тег)`);
      }
    }
    expect(hits, 'белый текст на --danger: в тёмной теме это 3.35:1').toEqual([]);
  });
});
