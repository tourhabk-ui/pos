/**
 * Английские версии политики и соглашения (17.11) — перевод, а не новый документ.
 *
 * Что держится:
 *  - /en/legal/privacy и /en/legal/terms рендерятся, честно называют себя
 *    переводом и ссылаются на русский оригинал;
 *  - редакция (дата) и число разделов совпадают с русским оригиналом — правка
 *    русского текста без перевода краснеет здесь;
 *  - реквизиты — из lib/legal/requisites, не вписаны руками;
 *  - hreflang-пара ru/en и видимый переключатель есть у обеих сторон;
 *  - обе английские страницы в sitemap.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/db-pool', () => ({ pool: { query: () => Promise.resolve({ rows: [] }) } }));

import PrivacyRu, { metadata as privacyRuMeta } from '@/app/legal/privacy/page';
import TermsRu, { metadata as termsRuMeta } from '@/app/legal/terms/page';
import PrivacyEn, { metadata as privacyEnMeta } from '@/app/en/legal/privacy/page';
import TermsEn, { metadata as termsEnMeta } from '@/app/en/legal/terms/page';
import { REQUISITES } from '@/lib/legal/requisites';
import { THIRD_PARTIES } from '@/lib/legal/third-party-registry';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

const RU_MONTHS: Record<string, string> = {
  января: 'January', февраля: 'February', марта: 'March', апреля: 'April', мая: 'May', июня: 'June',
  июля: 'July', августа: 'August', сентября: 'September', октября: 'October', ноября: 'November', декабря: 'December',
};

const DOCS = [
  { doc: 'privacy', Ru: PrivacyRu, En: PrivacyEn, ruMeta: privacyRuMeta, enMeta: privacyEnMeta },
  { doc: 'terms', Ru: TermsRu, En: TermsEn, ruMeta: termsRuMeta, enMeta: termsEnMeta },
] as const;

describe.each(DOCS)('/en/legal/$doc', ({ doc, Ru, En, ruMeta, enMeta }) => {
  it('рендерится, называет себя переводом и ссылается на оригинал', () => {
    const { container } = render(<En />);
    const note = container.querySelector('[data-testid="legal-translation-note"]');
    expect(note?.textContent).toMatch(/translation of the Russian original/);
    expect(note?.querySelector(`a[href="/legal/${doc}"]`)).not.toBeNull();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('редакция и число разделов совпадают с русским оригиналом', () => {
    const ru = render(<Ru />).container;
    const en = render(<En />).container;
    const ruDate = (ru.textContent ?? '').match(/Редакция от (\d+) (\S+) (\d{4})/);
    expect(ruDate).not.toBeNull();
    const [, d, m, y] = ruDate!;
    expect(en.textContent).toContain(`Version of ${d} ${RU_MONTHS[m]} ${y}`);
    expect(en.querySelectorAll('section h2').length).toBe(ru.querySelectorAll('section h2').length);
  });

  it('реквизиты — из lib/legal/requisites, ИНН/ОГРН не вписаны руками', () => {
    const src = strip(read(`app/en/legal/${doc}/page.tsx`));
    expect(src).toMatch(/from '@\/lib\/legal\/requisites'/);
    expect(src).not.toContain(REQUISITES.inn);
    expect(src).not.toContain(REQUISITES.ogrn);
    const text = render(<En />).container.textContent ?? '';
    for (const v of [REQUISITES.shortName, REQUISITES.inn, REQUISITES.ogrn, REQUISITES.address, REQUISITES.director]) {
      expect(text).toContain(v);
    }
  });

  it('hreflang-пара ru/en у обеих сторон, canonical — своя', () => {
    const languages = { ru: `/legal/${doc}`, en: `/en/legal/${doc}`, 'x-default': `/legal/${doc}` };
    expect(ruMeta.alternates).toEqual({ canonical: `/legal/${doc}`, languages });
    expect(enMeta.alternates).toEqual({ canonical: `/en/legal/${doc}`, languages });
  });

  it('видимый переключатель RU/EN ведёт на парную страницу', () => {
    const ru = render(<Ru />).container.querySelector('[data-testid="legal-lang-switch"]');
    expect(ru?.querySelector(`a[href="/en/legal/${doc}"]`)).not.toBeNull();
    const en = render(<En />).container.querySelector('[data-testid="legal-lang-switch"]');
    expect(en?.querySelector(`a[href="/legal/${doc}"]`)).not.toBeNull();
    expect(en?.querySelector('[aria-current="page"]')?.textContent).toBe('EN');
  });
});

describe('перевод политики не теряет получателей', () => {
  it('у каждой третьей стороны есть английские поля, страница берёт их из реестра', () => {
    for (const tp of THIRD_PARTIES) {
      expect(tp.en.title, tp.id).toBeTruthy();
      expect(tp.en.purpose, tp.id).toBeTruthy();
    }
    const src = read('app/en/legal/privacy/page.tsx');
    expect(src).toMatch(/THIRD_PARTIES\.map/);
    expect(src).toMatch(/crossBorderRecipients\(\)/);
  });
});

describe('sitemap', () => {
  it('английские версии в sitemap рядом с русскими', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { entries } = await collectSitemapEntriesWithStatus();
    const urls = entries.map((e) => e.url);
    for (const u of ['/legal/privacy', '/legal/terms', '/en/legal/privacy', '/en/legal/terms']) {
      expect(urls).toContain(`https://vedarai.ru${u}`);
    }
  });
});
