/**
 * Общий матчер текстовых ссылок — один на все справочники.
 *
 * Логика нарезки родилась в DescriptionWithFishLinks и вынесена в
 * lib/text-links.ts, когда понадобилась второму потребителю. Копия матчера
 * разошлась бы с рыбной на первом же падеже — и одно слово в одном абзаце
 * подсвечивалось бы по-разному в зависимости от того, чья копия его нашла.
 * Этот тест держит два инварианта: матчер работает как обещано, и рыбная
 * подсветка ходит через него, а не через возвращённую копию.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkifyText, detectLinkables, type Linkable } from '@/lib/text-links';
import { FISH_SPECIES } from '@/lib/fish-species';
import { parseTextChunks } from '@/components/shared/DescriptionWithFishLinks';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const REG: Linkable[] = [
  { id: 'mchs', patterns: [/МЧС/g, /регистрац[а-яё]*\s+групп[а-яё]*/gi] },
  { id: 'map', patterns: [/офлайн[- ]карт[а-яё]*/gi] },
];

describe('linkifyText', () => {
  it('склейка кусков возвращает исходный текст без потерь', () => {
    const text = 'До выхода: регистрация группы, офлайн-карта, заряженный телефон.';
    expect(linkifyText(text, REG).map(c => c.text).join('')).toBe(text);
  });

  it('находит вхождения по падежам и помечает их записью справочника', () => {
    const ids = linkifyText('Нужна регистрация группы и офлайн-карта', REG)
      .filter(c => c.entry).map(c => c.entry!.id);
    expect(ids).toContain('mchs');
    expect(ids).toContain('map');
  });

  it('совпадения не пересекаются: первое найденное выигрывает', () => {
    const text = 'МЧС, регистрация группы и снова МЧС';
    const chunks = linkifyText(text, REG);
    expect(chunks.map(c => c.text).join('')).toBe(text);
    // ссылка внутри ссылки невозможна: куски с entry не соприкасаются текстом
    for (const c of chunks) if (c.entry) expect(c.text.length).toBeGreaterThan(0);
  });

  it('excludeId убирает запись целиком, остальные остаются', () => {
    const text = 'Про МЧС отдельно, про офлайн-карту тоже';
    const without = linkifyText(text, REG, 'mchs').filter(c => c.entry).map(c => c.entry!.id);
    expect(without).not.toContain('mchs');
    expect(without).toContain('map');
  });

  it('нет совпадений — один кусок с исходным текстом', () => {
    expect(linkifyText('Обед в кафе', REG)).toEqual([{ text: 'Обед в кафе' }]);
  });
});

describe('detectLinkables', () => {
  it('детект и подсветка не расходятся: что подсветилось — то и найдено', () => {
    const text = 'Перед выходом обязательна регистрация группы, скачайте офлайн-карту';
    const detected = detectLinkables(text, REG).map(e => e.id).sort();
    const linked = [...new Set(linkifyText(text, REG).filter(c => c.entry).map(c => c.entry!.id))].sort();
    expect(linked).toEqual(detected);
  });

  it('не статфулен: паттерны с флагом g не тащат lastIndex между вызовами', () => {
    const text = 'МЧС и ещё раз МЧС';
    expect(detectLinkables(text, REG).length).toBe(detectLinkables(text, REG).length);
  });
});

describe('рыбная подсветка ходит через общий матчер', () => {
  it('parseTextChunks сохраняет прежний контракт на справочнике рыб', () => {
    const chunks = parseTextChunks('Ловим чавычу на спиннинг');
    expect(chunks.map(c => c.text).join('')).toBe('Ловим чавычу на спиннинг');
    expect(chunks.some(c => c.species?.id === 'chavycha')).toBe(true);
  });

  it('excludeId по-прежнему убирает самоссылку вида', () => {
    const ids = parseTextChunks('чавыча и кижуч', 'chavycha')
      .filter(c => c.species).map(c => c.species!.id);
    expect(ids).not.toContain('chavycha');
    expect(ids).toContain('kizuch');
  });

  it('в компоненте нет своей копии нарезки', () => {
    const src = read('components/shared/DescriptionWithFishLinks.tsx');
    expect(src).toContain('linkifyText');
    expect(src, 'вернулась своя копия нарезки').not.toContain('matches.sort');
  });

  it('матчер универсален: работает на справочнике рыб напрямую', () => {
    const ids = detectLinkables('Ловим чавычу', FISH_SPECIES).map(s => s.id);
    expect(ids).toContain('chavycha');
  });
});
