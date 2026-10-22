/** Карточка «Туры сезона»: цена акцентом, длительность чипом на фото, без пустоты над кнопкой (владелец 20.10). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
const src = readFileSync('app/_home/_HomeV8Client.tsx', 'utf8');
describe('карточка тура на главной', () => {
  it('длительность — жёлтый бейдж на фото, тёмный текст', () => {
    expect(src).toMatch(/className="dur-chip"><Clock aria-hidden size=\{13\} \/>\{pf\.duration\}/);
    expect(src).toMatch(/\.v7 \.plate \.dur-chip\{position:absolute[^}]*background:var\(--badge\)[^}]*color:var\(--on-badge\)/);
  });
  it('цена — основным цветом текста, крупнее', () => {
    expect(src).toMatch(/\.v7 \.plate \.facts \.price\{font:800 22px[^}]*tabular-nums[^}]*color:var\(--text-primary\)\}/);
  });
  it('описание в 2 строки, дни в чипе жирно', () => {
    expect(src).toMatch(/\.v7 \.plate \.cap\{[^}]*-webkit-line-clamp:2/);
    expect(src).toMatch(/\.v7 \.plate \.dur-chip\{[^}]*font:800 14px[^}]*tabular-nums/);
  });
  it('карточки не растягиваются до самой высокой, кнопка сразу за текстом', () => {
    expect(src).toMatch(/\.v7 \.plates\{[^}]*align-items:flex-start/);
    expect(src).not.toMatch(/\.v7 \.plate \.buy\{margin-top:auto/);
  });
});
