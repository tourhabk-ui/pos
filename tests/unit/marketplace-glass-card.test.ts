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
  it('фото на всю карточку, пропорции близки к 2:3 (с sm; на телефоне короче — тур с ценой на первом экране)', () => {
    expect(src.includes('sm:aspect-[17/25]')).toBe(true);
  });
  it('стекло поверх фото (backdrop-blur) для панелей', () => {
    expect(src.match(/backdrop-blur/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
  it('рейл фич выводится детерминированно из тура (deriveFeatures)', () => {
    expect(src.includes('function deriveFeatures')).toBe(true);
    expect(src.includes('FEATURE_RULES')).toBe(true);
  });
  // Переписано осознанно 24.09 (решение владельца, развилка 7 аудита П5).
  // Прежде здесь требовался Unbounded как «шрифт платформы» — но §3 CLAUDE.md
  // разрешает только Playfair (заголовки) и Outfit (остальное), и сторож
  // карточки тура держит то же. Сторож закреплял нарушение правила, а не вид:
  // один тур звучал двумя голосами на главной и в каталоге (#133).
  it('название — Playfair, остальное — Outfit; Unbounded и JetBrains Mono на карточке нет', () => {
    expect(src).not.toMatch(/font-unbounded/);
    expect(src).not.toMatch(/font-jetbrains/);
    const card = src.slice(src.indexOf('function TourCard('), src.indexOf('/* ─── Planner Banner'));
    expect(card).toMatch(/fontFamily: 'var\(--font-playfair\)'/);
    expect(card).toMatch(/fontFamily: 'var\(--font-outfit\)'/);
  });
  it('«Забронировать» — непрозрачная ds-btn-primary, не стекло (§2: непрозрачность — для действия)', () => {
    const card = src.slice(src.indexOf('function TourCard('), src.indexOf('/* ─── Planner Banner'));
    const cta = card.slice(card.indexOf('href={`${href}#booking`}'), card.indexOf("'Забронировать'"));
    expect(cta).toMatch(/className="ds-btn ds-btn-primary/);
    expect(cta).not.toMatch(/bg-white\/\d+|backdrop-blur/);
  });
  it('нижняя панель — bg-black/60 с фолбэком при prefers-reduced-transparency', () => {
    expect(src).toMatch(/backdrop-blur-md bg-black\/60/);
    expect(src).toMatch(/\[@media\(prefers-reduced-transparency:reduce\)\]:bg-\[var\(--bg-card\)\]/);
    expect(src).toMatch(/\[@media\(prefers-reduced-transparency:reduce\)\]:backdrop-blur-none/);
  });
  it('на карточке есть «Забронировать» и избранное', () => {
    expect(src.includes('Забронировать')).toBe(true);
    expect(src.includes('onToggleLike')).toBe(true);
  });
  it('фото делается сочнее фильтром (не вялые цвета)', () => {
    expect(src).toMatch(/saturate\(1\.\d+\)/);
  });
});
