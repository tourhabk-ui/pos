/**
 * Текст на заливке --accent — один токен --on-accent (24.09).
 *
 * До него текст на лаве брали тремя способами: #0D1117 у ds-btn-primary,
 * #fff у кнопок главной, var(--bg-primary) у чипов каталога. Каждый проваливал
 * контраст в одной из тем: белый на лаве тёмной темы ≈3:1, тёмный на лаве
 * светлой ≈4:1, кремовый ≈3.9:1. Токен даёт тёмный в тёмной теме и белый в
 * светлой — выше 4.5:1 в обеих.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('--on-accent', () => {
  const CSS = read('app/globals.css');

  it('объявлен при каждом объявлении --accent', () => {
    const accents = CSS.match(/^\s*--accent:/gm)?.length ?? 0;
    const onAccents = CSS.match(/^\s*--on-accent:/gm)?.length ?? 0;
    expect(accents).toBeGreaterThan(0);
    expect(onAccents, 'тема объявляет --accent без --on-accent').toBe(accents);
  });

  it('ds-btn-primary берёт текст из токена', () => {
    expect(CSS).toMatch(/\.ds-btn-primary\s*\{[^}]*color:\s*var\(--on-accent\)/);
  });

  it('кнопки главной и чипы каталога — тоже', () => {
    const home = read('app/_home/_HomeV8Client.tsx');
    expect(home).not.toMatch(/background:var\(--accent\);color:(?!var\(--on-accent\))/);
    expect(read('components/marketplace/MarketplaceClient.tsx')).toMatch(/CHIP_ON = '[^']*text-\[var\(--on-accent\)\]/);
  });
});
