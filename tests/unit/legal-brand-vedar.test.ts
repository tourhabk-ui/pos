/**
 * Одно имя платформы в документах (решение владельца 01.10).
 *
 * Аудит vedarai.ru 01.10: сайт называется «Ведар», а оферта, политика,
 * соглашение и агентский договор — «торговая марка TourHab». Турист,
 * открывший документы, видел другое имя и вправе был усомниться, с кем
 * заключает договор. Имя теперь берётся из REQUISITES.brand, телефон — из
 * REQUISITES.phone (его сменит номер Кузьмича — одной строкой).
 *
 * Ловушка JSX: перенос строки рядом с {выражением} съедает пробел — «под
 * брендом\n{brand}» рендерится «брендомВедар». Поэтому сторож требует, чтобы
 * выражение не стояло на краю строки без явного {' '}.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUISITES } from '@/lib/legal/requisites';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
// agent-agreement удалён 05.10 (оплата выключена, страница — 404).
const DOCS = ['offer', 'privacy', 'terms'].map((d) => `app/legal/${d}/page.tsx`);

describe('имя платформы в документах', () => {
  it('марка — Ведар', () => {
    expect(REQUISITES.brand).toBe('Ведар');
  });

  for (const f of DOCS) {
    it(`${f}: без TourHab, имя из REQUISITES.brand`, () => {
      const src = read(f);
      expect(src).not.toMatch(/TourHab/i);
      expect(src).toMatch(/\{REQUISITES\.brand\}/);
    });

    it(`${f}: пробелы вокруг {REQUISITES.brand} не съедены переносом`, () => {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        const t = line.trim();
        // Выражение в начале строки после текста — нужен {' '} в конце предыдущей.
        if (t.startsWith('{REQUISITES.brand}') && i > 0) {
          expect(lines[i - 1].trimEnd(), `${f}:${i}`).toMatch(/(\{' '\}|>)$/);
        }
        // Выражение в конце строки перед текстом — нужен {' '} сразу после него.
        if (t.endsWith('{REQUISITES.brand}') && i + 1 < lines.length) {
          expect(lines[i + 1].trim(), `${f}:${i + 2}`).toMatch(/^</);
        }
      });
    });
  }
});

describe('телефон — одним полем', () => {
  it('«О нас», «Контакты» и разметка берут REQUISITES.phone', () => {
    expect(read('app/about/page.tsx')).toMatch(/\{REQUISITES\.phone\}/);
    expect(read('app/contact/page.tsx')).toMatch(/\{REQUISITES\.phone\}/);
    expect(read('app/layout.tsx')).toMatch(/"telephone": REQUISITES\.phone/);
    for (const f of ['app/about/page.tsx', 'app/contact/page.tsx', 'app/layout.tsx']) {
      expect(read(f), f).not.toMatch(/782-22-22/);
    }
  });
});
