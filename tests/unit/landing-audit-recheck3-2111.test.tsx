/**
 * Третий заход аудита 21.11.2026 (сверка Гло на проде 1b4e3804):
 * «Местечко» в текстах и планах, лосось в таблице «По месяцам»,
 * оставшиеся превосходные степени и сломанные фразы про Командоры.
 */
import { describe, it, expect } from 'vitest';
import { parseArticleMarkdown } from '@/lib/articles/markdown';
import { landingBySlug, LANDINGS } from '@/lib/landings/landings';
import { fishByMonth } from '@/lib/seo/trip-cost';
import { FISH_SPECIES } from '@/lib/fish-species';

const body = (slug: string) => {
  const l = landingBySlug(slug);
  expect(l, slug).toBeTruthy();
  return `${l.before}\n${l.after}`;
};

const hrefsOf = (slug: string) => {
  const blocks = parseArticleMarkdown(body(slug));
  const hrefs: string[] = [];
  const walk = (nodes: { t: string; href?: string; c?: unknown }[]) => {
    for (const n of nodes) {
      if (n.t === 'link' && n.href) hrefs.push(n.href);
      if (Array.isArray((n as { c?: unknown }).c)) walk((n as { c: { t: string; href?: string }[] }).c);
    }
  };
  for (const b of blocks) {
    if ('c' in b && Array.isArray(b.c)) walk(b.c as never);
    if ('items' in b) for (const it of b.items) walk(it as never);
    if ('head' in b) {
      for (const c of b.head) walk(c as never);
      for (const r of b.rows) for (const c of r) walk(c as never);
    }
  }
  return hrefs;
};

const MESTECKO_SLUGS = [
  'kamchatka-v-yanvare',
  'kamchatka-v-iyune',
  'kamchatka-v-sentyabre',
  'kamchatka-v-dekabre',
  'medvedi-kamchatki',
  'heli-ski-kamchatka',
  'kakie-tury-vybrat-na-kamchatke',
  'voshozhdeniya-na-vulkany-kamchatki',
  'vulkan-mutnovskij-zakryt',
] as const;

describe('«Местечко» убрано из текстов страниц и планов', () => {
  it('в названных статьях нет оператора «Местечко», карточек mestechko-* и mestechkokam.ru', () => {
    for (const slug of MESTECKO_SLUGS) {
      const text = body(slug);
      expect(text, slug).not.toMatch(/Местечко/);
      expect(text, slug).not.toMatch(/mestechko/i);
      expect(text, slug).not.toMatch(/mestechkokam\.ru/i);
      const hrefs = hrefsOf(slug).filter((h) => /mestechko|mestechkokam/i.test(h));
      expect(hrefs, slug).toEqual([]);
    }
  });

  it('во всех посадочных текстах (включая планы) нет «Местечка» и mestechko', () => {
    const dirty = LANDINGS.filter((l) =>
      /Местечко|mestechko|mestechkokam/i.test(`${l.before}\n${l.after}`),
    ).map((l) => l.slug);
    expect(dirty).toEqual([]);
  });

  it('/heli-ski-kamchatka опирается на «Снежную Долину» и портал, без 6–13 спусков «Местечка»', () => {
    const text = body('heli-ski-kamchatka');
    expect(text).toMatch(/Снежная Долина/);
    expect(text).toMatch(/snow-valley\.ru/);
    expect(text).toMatch(/с января по май/);
    expect(text).not.toMatch(/6–13/);
    expect(text).toMatch(/Число спусков зависит от пакета/);
  });
});

describe('лосось в таблице «По месяцам»', () => {
  it('справочник рыб не попадает в таблицу видом «Лосось» с мая по октябрь', () => {
    const fish = fishByMonth(FISH_SPECIES);
    for (const m of [5, 6, 7, 8, 9, 10]) {
      expect(fish.get(m), `месяц ${m}`).not.toContain('Лосось');
    }
    expect(fish.get(6)).toContain('Чавыча');
  });
});

describe('превосходные степени и сломанные фразы', () => {
  it('/kamchatka-v-iyule: крупная группировка; тёплый месяц с цифрами августа', () => {
    const text = body('kamchatka-v-iyule');
    expect(text).toMatch(/крупная группировка медведей/);
    expect(text).not.toMatch(/самая крупная группировка медведей/);
    expect(text).toMatch(/чуть теплее только август, \+13,7 °C/);
    expect(text).not.toMatch(/один из двух самых тёплых месяцев на Камчатке/);
    expect(text).toContain('pogodaiklimat.ru/climate/32583.htm');
  });

  it('/stoit-li-ekhat-na-kamchatku: лид без «самая крупная», список китов без поломки', () => {
    const text = body('stoit-li-ekhat-na-kamchatku');
    expect(text).toMatch(/крупная группировка бурых медведей в Южно-Камчатском заказнике/);
    expect(text).not.toMatch(/самая крупная в Южно-Камчатском заказнике/);
    expect(text).toMatch(
      /по данным регионального портала, в заповеднике «Командорский» китов наблюдают круглый год/,
    );
    expect(text).not.toMatch(/Киты \| в заповеднике «Командорский», по данным регионального портала, китов наблюдают/);
  });

  it('/nepogoda-otmenili-vertolet FAQ атрибутирует «Вулканариум» порталу', () => {
    const text = body('nepogoda-otmenili-vertolet');
    const faq = text.split('Чем заняться в Петропавловске-Камчатском в дождь?')[1] ?? '';
    expect(faq).toMatch(/портал называет самым популярным интерактивный «Вулканариум»/);
    expect(faq).not.toMatch(/самый популярный — интерактивный «Вулканариум»/);
  });

  it('/chto-posmotret-na-kamchatke без удвоенной оговорки портала', () => {
    const text = body('chto-posmotret-na-kamchatke');
    expect(text).toMatch(
      /По данным регионального портала, в заповеднике «Командорский» китов наблюдают круглый год/,
    );
    expect(text).not.toMatch(
      /По данным регионального портала, в заповеднике «Командорский», по данным регионального портала/,
    );
  });
});
