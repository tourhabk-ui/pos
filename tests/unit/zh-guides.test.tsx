// @vitest-environment node
/**
 * Китайские посадочные /zh/kamchatka-zimoj и /zh/safety: прямой ответ,
 * H2-вопросы, FAQ только из видимого текста, Article и хлебные крошки,
 * высоты KVERT, без цен, радар не убран под текст.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZhGuideView } from '@/components/zh/ZhGuide';
import { AVACHINSKY_HEIGHT_M, MCHS_REGISTRATION_LEAD, MUTNOVSKY_HEIGHT_M } from '@/lib/facts/kamchatka';
import { MCHS_LEAD_WORKING_DAYS } from '@/lib/safety/mchs-registration';
import { faqFromBlocks, parseArticleMarkdown } from '@/lib/articles/markdown';
import { ZH_PAGE_PATHS, safetyHreflang } from '@/lib/zh/pages';
import {
  formatZhGuideDate,
  ZH_GUIDE_AUTHOR,
  ZH_GUIDE_DATE,
  ZH_SAFETY_GUIDE,
  ZH_WINTER_GUIDE,
  zhGuideArticleJsonLd,
  zhGuideBreadcrumbJsonLd,
  zhGuideHreflang,
} from '@/lib/zh/guides';

const PRICE = /₽|руб|¥|\d+\s*元|卢布/;

describe('китайские гиды: зима и безопасность', () => {
  it('адреса в общем списке китайских страниц, описание не длиннее 160 знаков', () => {
    expect(ZH_PAGE_PATHS).toContain('/zh/kamchatka-zimoj');
    expect(ZH_PAGE_PATHS).toContain('/zh/safety');
    expect(ZH_WINTER_GUIDE.description.length).toBeLessThanOrEqual(160);
    expect(ZH_SAFETY_GUIDE.description.length).toBeLessThanOrEqual(160);
    expect(ZH_WINTER_GUIDE.ruPath).toBeNull();
    expect(ZH_SAFETY_GUIDE.ruPath).toBe('/safety');
    expect(zhGuideHreflang(ZH_SAFETY_GUIDE, 'https://vedarai.ru/')).toEqual(safetyHreflang('https://vedarai.ru/'));
    expect(zhGuideHreflang(ZH_WINTER_GUIDE, 'https://vedarai.ru')).toEqual({
      'zh-CN': 'https://vedarai.ru/zh/kamchatka-zimoj',
      'x-default': 'https://vedarai.ru/',
    });
  });

  it('зимняя страница: прямой ответ, высоты KVERT, русские имена мест, без цен', () => {
    const html = renderToStaticMarkup(<ZhGuideView guide={ZH_WINTER_GUIDE} />);
    expect(html).toContain(`>${ZH_WINTER_GUIDE.h1}<`);
    expect(html).toContain('简要。');
    expect(html).toContain(ZH_WINTER_GUIDE.lead.slice(0, 40));
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain(String(AVACHINSKY_HEIGHT_M.value));
    expect(html).toContain(String(MUTNOVSKY_HEIGHT_M.value));
    expect(html).toContain(AVACHINSKY_HEIGHT_M.sourceLabel);
    expect(html).toContain(MUTNOVSKY_HEIGHT_M.sourceLabel);
    expect(html).not.toContain('kvert.febras.net');
    expect(html).toContain('阿瓦恰火山（Авачинский вулкан）');
    expect(html).toContain('穆特诺夫斯基火山（Мутновский）');
    expect(html).toContain('帕拉通卡（Паратунка）');
    expect(html).toContain('彼得罗巴甫洛夫斯克-堪察加斯基（Петропавловск-Камчатский）');
    expect(html).toContain('href="/zh/harbin"');
    expect(html).toContain('href="/zh/safety"');
    expect(html).toContain('href="https://t.me/kuzmichai_bot"');
    expect(html).toContain('Кузьмич');
    expect(html).toContain(formatZhGuideDate(ZH_GUIDE_DATE));
    expect(html).toContain(ZH_GUIDE_AUTHOR);
    expect(html).not.toMatch(PRICE);
    const hrefHtml = html.replace(/&amp;/g, '&');
    for (const s of ZH_WINTER_GUIDE.sources) {
      expect(html).toContain(s.label);
      if (s.href) expect(hrefHtml).toContain(s.href);
    }
    for (const section of ZH_WINTER_GUIDE.sections) {
      expect(section.heading.endsWith('？') || section.heading.endsWith('?')).toBe(true);
      expect(html).toContain(section.heading);
    }
  });

  it('страница безопасности: радар сразу после лида, срок МЧС и 112, без цен', () => {
    const html = renderToStaticMarkup(<ZhGuideView guide={ZH_SAFETY_GUIDE} />);
    expect(html).toContain(`>${ZH_SAFETY_GUIDE.h1}<`);
    expect(html).toContain('简要。');
    expect(html).toContain(String(MCHS_LEAD_WORKING_DAYS));
    expect(html).toContain(MCHS_REGISTRATION_LEAD.order);
    expect(html).toContain('112');
    expect(html).toContain('href="/safety"');
    expect(html).toContain('打开实时雷达（俄文）');
    expect(html).toContain(MCHS_REGISTRATION_LEAD.formUrl);
    expect(html).not.toMatch(PRICE);
    const leadAt = html.indexOf('data-zh-guide-lead');
    const liveAt = html.indexOf('data-zh-guide-live');
    const mchsAt = html.indexOf('data-zh-guide-section="mchs"');
    expect(leadAt).toBeGreaterThan(0);
    expect(liveAt).toBeGreaterThan(leadAt);
    expect(mchsAt).toBeGreaterThan(liveAt);
  });

  it('FAQPage только из видимых вопросов, Article — Редакция Vedar и zh-CN', () => {
    for (const guide of [ZH_WINTER_GUIDE, ZH_SAFETY_GUIDE]) {
      const html = renderToStaticMarkup(<ZhGuideView guide={guide} />);
      const jsonld = zhGuideArticleJsonLd(guide, 'https://vedarai.ru');
      const graph = jsonld['@graph'] as Array<Record<string, unknown>>;
      const article = graph.find((n) => n['@type'] === 'Article')!;
      const faq = graph.find((n) => n['@type'] === 'FAQPage')!;
      expect(article.author).toEqual({ '@type': 'Organization', name: ZH_GUIDE_AUTHOR, url: 'https://vedarai.ru' });
      expect(article.inLanguage).toBe('zh-CN');
      expect(article.dateModified).toBeTruthy();
      const entities = faq.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>;
      expect(entities).toHaveLength(guide.faq.length);
      for (const item of guide.faq) {
        expect(html).toContain(item.question);
        expect(html).toContain(item.answer);
        expect(entities.some((e) => e.name === item.question && e.acceptedAnswer.text === item.answer)).toBe(true);
      }
      const crumbs = zhGuideBreadcrumbJsonLd(guide, 'https://vedarai.ru');
      const items = crumbs.itemListElement as Array<{ name: string; item: string }>;
      expect(items[0]).toMatchObject({ name: 'Vedar 堪察加', item: 'https://vedarai.ru/zh' });
      expect(items[1]).toMatchObject({ name: guide.h1, item: `https://vedarai.ru${guide.path}` });
    }
  });

  it('разбор markdown принимает китайский знак вопроса в FAQ', () => {
    const blocks = parseArticleMarkdown('## 常见问题\n\n**现在去堪察加安全吗？**\n请先看雷达。\n');
    expect(faqFromBlocks(blocks)).toEqual([{ q: '现在去堪察加安全吗？', a: '请先看雷达。' }]);
  });
});
