/**
 * Каталожная карточка тура — фото-first со стеклом (референс владельца 02.08).
 *
 * Была карточка «фото сверху + белое тело». Владелец задал вид: фото на всю
 * карточку, поверх — стекло (рейл фич слева, нижняя панель с названием, ценой
 * и «Забронировать»), пропорции ~2:3, прозрачное стекло, сочное фото. Стекло —
 * только поверх фото (Ведар §5). Это сторож исходника, чтобы вид не откатился.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'components/marketplace/MarketplaceClient.tsx'), 'utf-8');

describe('каталожная карточка тура — стекло поверх фото', () => {
  it('фото на всю карточку, пропорции близки к 2:3', () => {
    expect(src.includes('aspect-[17/25]')).toBe(true);
  });
  it('стекло поверх фото (backdrop-blur) для панелей', () => {
    expect(src.match(/backdrop-blur/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
  it('рейл фич выводится детерминированно из тура (deriveFeatures)', () => {
    expect(src.includes('function deriveFeatures')).toBe(true);
    expect(src.includes('FEATURE_RULES')).toBe(true);
  });
  it('название и цена — Unbounded (шрифт платформы), не generic serif', () => {
    expect(src).toMatch(/font-unbounded/);
  });
  it('на карточке есть «Забронировать» и избранное', () => {
    expect(src.includes('Забронировать')).toBe(true);
    expect(src.includes('onToggleLike')).toBe(true);
  });
  it('фото делается сочнее фильтром (не вялые цвета)', () => {
    expect(src).toMatch(/saturate\(1\.\d+\)/);
  });
});
