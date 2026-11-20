/**
 * Очерки «О виде» (21.11, пачка 4): по источникам, без цен и сезонов лова,
 * не противоречат карточке; правки микижи и краба (1480) учтены в форели.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FISH_SPECIES, FISH_BY_ID } from '@/lib/fish-species';
import { FishAbout } from '@/components/fish/FishAbout';

const WITH_ABOUT = ['forel', 'golets', 'gorbuscha', 'kharius', 'kizuch', 'kundzha', 'losos', 'navaga', 'nerka', 'paltus', 'treska'];

describe('очерки о видах рыб', () => {
  it('есть у 11 видов пачки 4, у каждого есть источники', () => {
    expect(FISH_SPECIES.filter((f) => f.about).map((f) => f.id).sort()).toEqual([...WITH_ABOUT].sort());
    for (const id of WITH_ABOUT) {
      const a = FISH_BY_ID[id].about!;
      expect(a.paragraphs.length, id).toBeGreaterThan(0);
      expect(a.sources.length, id).toBeGreaterThan(0);
      for (const s of a.sources) expect(s.url, id).toMatch(/^https:\/\//);
      for (const p of a.paragraphs) {
        expect(p, id).not.toMatch(/₽|руб|цена|стоимост|Википеди|черновик|\bмы\b|Ведар/i);
      }
    }
  });

  it('форель не противоречит микиже: не эндемик, до 6,5 кг, без кумжи', () => {
    const forel = FISH_BY_ID.forel;
    expect(forel.recordKg).toContain('6,5');
    expect(forel.shortDesc).not.toMatch(/кумж/i);
    expect(JSON.stringify(forel.about)).not.toMatch(/эндеми|кумж/i);
  });

  it('карточки сведены с очерками по числам', () => {
    expect(FISH_BY_ID.treska.recordKg).toBe('до 22,7 кг');
    expect(FISH_BY_ID.navaga.recordKg).toBe('до 1,3 кг');
    expect(FISH_BY_ID.kundzha.recordKg).toBe('около 11 кг');
    expect(FISH_BY_ID.paltus.shortDesc).not.toContain('20–900');
    expect(FISH_BY_ID.losos.shortDesc).not.toMatch(/Пять видов/);
    expect(FISH_BY_ID.treska.funFact).not.toMatch(/Зимой треска подходит/);
  });

  it('рисует абзацы и ссылки на источники; без очерка — ничего', () => {
    const html = renderToStaticMarkup(<FishAbout species={FISH_BY_ID.kundzha} />);
    expect(html).toContain('О виде');
    expect(html).toContain('ru.wikipedia.org');
    expect(renderToStaticMarkup(<FishAbout species={FISH_BY_ID.keta} />)).toBe('');
  });
});
