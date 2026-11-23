// @vitest-environment node
/**
 * Справочник /fish отвечает «где и когда ловить» в первом абзаце;
 * с путёвки, гида «когда ехать», туров на рыбалку и хаба — явная ссылка.
 * FAQPage только из видимого текста (это уже проверяет fish-page-2211).
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { landingBySlug } from '@/lib/landings/landings';
import { FishingGuide } from '@/app/hub/fishing/_FishingGuide';
import { harbinHreflang, HARBIN_PATH } from '@/lib/zh/harbin';
import { ZH_WINTER_GUIDE, zhGuideHreflang } from '@/lib/zh/guides';

describe('явные ссылки на справочник /fish', () => {
  it('путёвка через Госуслуги41 ведёт в справочник в тексте и в «Куда дальше»', () => {
    const l = landingBySlug('putevka-na-rybalku-gosuslugi41');
    const text = `${l.before}\n${l.after}`;
    expect(text).toMatch(/\[«Рыбалка на Камчатке»\]\(\/fish\)/);
    expect(l.after).toMatch(/\[Рыбалка на Камчатке: где и когда ловить\]\(\/fish\)/);
  });

  it('«Когда ехать» в разделе про рыбалку ссылается на справочник', () => {
    const l = landingBySlug('kogda-ehat-na-kamchatku');
    const start = l.before.indexOf('Когда ехать на рыбалку?');
    const end = l.before.indexOf('## ', start + 10);
    const section = l.before.slice(start, end);
    expect(section).toMatch(/\[«Рыбалка на Камчатке»\]\(\/fish\)/);
  });

  it('посадочная туров на рыбалку ссылается на справочник в лиде и в «Куда дальше»', () => {
    const l = landingBySlug('rybalka-na-kamchatke-gde-i-kogda-lovit');
    const text = `${l.before}\n${l.after}`;
    expect(l.before).toMatch(/\[«Рыбалка на Камчатке»\]\(\/fish\)/);
    expect(text).toMatch(/\[Рыбалка на Камчатке: где и когда ловить\]\(\/fish\)/);
  });

  it('хаб /hub/fishing ведёт в справочник из блока сезонов', () => {
    const html = renderToStaticMarkup(<FishingGuide />);
    expect(html).toContain('href="/fish"');
    expect(html).toContain('Рыбалка на Камчатке');
  });
});

describe('EN/ZH: мелкие технические правки hreflang', () => {
  it('/zh/harbin объявляет язык самоссылкой: русской пары нет', () => {
    expect(harbinHreflang('https://vedarai.ru/')).toEqual({
      'zh-CN': `https://vedarai.ru${HARBIN_PATH}`,
      'x-default': `https://vedarai.ru${HARBIN_PATH}`,
    });
  });

  it('зимний китайский гид без ruPath: /articles/zima не пара — там цены каталога', () => {
    expect(ZH_WINTER_GUIDE.ruPath).toBeNull();
    expect(zhGuideHreflang(ZH_WINTER_GUIDE, 'https://vedarai.ru')).toEqual({
      'zh-CN': 'https://vedarai.ru/zh/kamchatka-zimoj',
      'x-default': 'https://vedarai.ru/zh/kamchatka-zimoj',
    });
  });
});
