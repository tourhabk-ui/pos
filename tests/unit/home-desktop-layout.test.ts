/**
 * Десктоп-раскладка главной (перенос одобренного макета, 02.08).
 *
 * Отзыв Ярослава: на компе главная была 480px-полоской посреди пустого экрана
 * (мобильный layout без десктоп-брейкпоинта). Добавлен @media ≥1024px: широкий
 * каркас + сетки. Сторож держит инвариант — чтобы правку не откатили молча и
 * колонка снова не схлопнулась в телефонную полоску.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');

describe('главная: десктоп-брейкпоинт есть и расширяет каркас', () => {
  it('есть @media ≥1024px', () => {
    expect(src).toMatch(/@media\s*\(min-width:\s*1024px\)/);
  });
  it('каркас .wrap на десктопе шире 480px (не телефонная полоска)', () => {
    // Базовое правило — 480px; десктоп обязан переопределить на широкое.
    expect(src).toMatch(/\.v7 \.wrap\{max-width:1080px/);
    expect(src).toMatch(/max-width:1160px/); // ещё шире на ≥1280px
  });
  it('сетки используют ширину: стихии в 3 колонки на десктопе', () => {
    expect(src).toMatch(/\.v7 \.elements\{grid-template-columns:repeat\(3,1fr\)\}/);
  });
  it('мобильная база не тронута: .wrap по умолчанию всё ещё 480px', () => {
    // Правка обязана быть аддитивной — базовое мобильное правило на месте.
    expect(src).toMatch(/\.v7 \.wrap\{max-width:480px/);
  });
});
