/** Карточка «Туры сезона»: цена акцентом, длительность чипом на фото, без пустоты над кнопкой (владелец 20.10). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
const src = readFileSync('app/_home/_HomeV8Client.tsx', 'utf8');
describe('карточка тура на главной', () => {
  it('длительность — чип на фото', () => {
    expect(src).toMatch(/className="dur-chip"><Clock aria-hidden size=\{13\} \/>\{pf\.duration\}/);
    expect(src).toMatch(/\.v7 \.plate \.dur-chip\{position:absolute[^}]*backdrop-filter/);
  });
  it('цена — цветом бренда, крупнее', () => {
    expect(src).toMatch(/\.v7 \.plate \.facts \.price\{font:700 19px[^}]*color:var\(--accent\)\}/);
  });
  it('карточки не растягиваются до самой высокой, кнопка сразу за текстом', () => {
    expect(src).toMatch(/\.v7 \.plates\{[^}]*align-items:flex-start/);
    expect(src).not.toMatch(/\.v7 \.plate \.buy\{margin-top:auto/);
  });
});
