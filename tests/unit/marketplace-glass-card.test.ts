/**
 * Каталожная карточка тура — фото сверху, текст под ним (решение владельца 29.09).
 *
 * История. 02.08 владелец задал вид «фото на всю карточку, поверх — стекло с
 * названием, ценой и кнопкой». К 29.09 на стекле собрались ещё описание,
 * «что входит», оператор и длительность, и на телефоне панель закрывала фото
 * почти целиком. Владелец: «описание тура закрывает фото тура, это не
 * профессионально» — и выбрал раскладку «фото сверху, текст под ним».
 *
 * Сторож держит главное: на фото — только рейл фич и избранное (стекло), текст
 * и цена стоят сплошным блоком на --bg-card, стеклянной текстовой панели
 * поверх фото нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'components/marketplace/MarketplaceClient.tsx'), 'utf-8');
const card = src.slice(src.indexOf('function TourCard('), src.indexOf('/* ─── Planner Banner'));
const photo = card.slice(card.indexOf('aspect-[4/3]'), card.indexOf('Текст — сплошным блоком под фото'));
const body = card.slice(card.indexOf('Текст — сплошным блоком под фото'));

describe('каталожная карточка тура — фото сверху, текст под ним', () => {
  it('фото — отдельный блок 4:3 сверху, не на всю карточку', () => {
    expect(card).toContain('aspect-[4/3]');
    expect(card).not.toMatch(/aspect-\[17\/25\]|aspect-\[5\/6\]/);
  });

  it('на фото только рейл фич и избранное — стекло, текста тура нет', () => {
    // Третье стекло — подпись автора чужого кадра-заглушки («Фото: Сладченко
    // В. Л.», решение владельца 09.10): это подпись снимка, а не текст тура,
    // и она есть только у заглушки — свой снимок тура подписи не получает.
    const credit = photo.includes('{placeholderCredit && (') ? 1 : 0;
    expect(photo.match(/backdrop-blur/g)?.length).toBe(2 + credit);
    if (credit) expect(photo).toMatch(/Фото: \{shortCredit\(placeholderCredit\)\}/);
    expect(photo).not.toContain('<h3');
    expect(photo).not.toContain('tour.short_description');
    expect(photo).not.toContain('rub(basePrice)');
  });

  it('текстовый блок сплошной, на --bg-card, без стекла (§2: на сплошном фоне стекла нет)', () => {
    expect(card).toMatch(/bg-\[var\(--bg-card\)\]/);
    expect(body).not.toMatch(/backdrop-blur|bg-black\/\d+|text-white/);
    expect(body).toContain('{tour.title}');
    expect(body).toContain('tour.short_description ?? tour.description');
    expect(body).toContain('rub(basePrice)');
  });

  it('рейл фич выводится детерминированно из тура (deriveFeatures)', () => {
    expect(src.includes('function deriveFeatures')).toBe(true);
    expect(src.includes('FEATURE_RULES')).toBe(true);
  });

  it('название — Playfair, остальное — Outfit; Unbounded и JetBrains Mono на карточке нет', () => {
    expect(src).not.toMatch(/font-unbounded/);
    expect(src).not.toMatch(/font-jetbrains/);
    expect(card).toMatch(/fontFamily: 'var\(--font-playfair\)'/);
    expect(card).toMatch(/fontFamily: 'var\(--font-outfit\)'/);
  });

  it('«Отправить заявку» — непрозрачная ds-btn-primary, не стекло', () => {
    const cta = card.slice(card.indexOf('href={`${href}#booking`}'), card.indexOf("'Отправить заявку'"));
    expect(cta).toMatch(/className="ds-btn ds-btn-primary/);
    expect(cta).not.toMatch(/bg-white\/\d+|backdrop-blur/);
  });

  it('на карточке есть «Отправить заявку» и избранное', () => {
    expect(card.includes('Отправить заявку')).toBe(true);
    expect(card.includes('onToggleLike')).toBe(true);
  });

  it('фото делается сочнее фильтром (не вялые цвета)', () => {
    expect(card).toMatch(/saturate\(1\.\d+\)/);
  });
});
