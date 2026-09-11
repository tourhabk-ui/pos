/**
 * Внутренняя ссылка ведёт на существующий раздел.
 *
 * Повод (#1777): «Спросить Кузьмича» на карточке места вела на /chat —
 * страницы с таким путём не было никогда, турист получал 404 там, где ждал
 * помощи. Сторож берёт первый сегмент каждого литерального href="/..." в
 * app/ и components/ и требует, чтобы ему отвечало одно из трёх: каталог
 * app/<сегмент>, файл в public/, либо редирект в next.config.js.
 *
 * Проверяется только первый сегмент: глубже пути динамические, и судить их
 * статикой — выдумывать. Этого достаточно, чтобы поймать выдуманный раздел.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '_archive']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(full)) out.push(full);
  }
  return out;
}

const nextConfig = readFileSync(join(ROOT, 'next.config.js'), 'utf-8');
const REDIRECTED = new Set(
  [...nextConfig.matchAll(/source:\s*'\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
);

function resolvable(seg: string): boolean {
  // app/<seg> либо файловый роут app/<seg>.<ext> (llms.txt, sitemap.xml).
  if (readdirSync(join(ROOT, 'app')).some((f) => f === seg || f.startsWith(`${seg}.`))) return true;
  if (REDIRECTED.has(seg)) return true;
  const pub = join(ROOT, 'public');
  if (existsSync(pub) && readdirSync(pub).some((f) => f === seg || f.startsWith(`${seg}.`))) return true;
  return false;
}

describe('литеральные внутренние ссылки', () => {
  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))];
  const broken = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/href=(?:"|'|\{`)\/([A-Za-z0-9_-]+)/g)) {
      const seg = m[1];
      if (!resolvable(seg)) {
        const list = broken.get(seg) ?? [];
        list.push(relative(ROOT, f));
        broken.set(seg, list);
      }
    }
  }

  it('нашлись вообще — иначе сторож охраняет пустоту', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('каждая ведёт в существующий раздел', () => {
    expect(Object.fromEntries(broken), 'ссылка на раздел, которого нет').toEqual({});
  });

  it('карточка места зовёт Кузьмича по живому адресу', () => {
    const src = readFileSync(join(ROOT, 'components/places/PlaceKuzmich.tsx'), 'utf-8');
    expect(src).toMatch(/`\/kuzmich\?context=place/);
    expect(src).not.toMatch(/\/chat\?/);
  });
});
