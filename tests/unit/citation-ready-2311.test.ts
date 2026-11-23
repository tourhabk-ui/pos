/**
 * Видимость 23.11: ИИ не цитирует готовые /kogda-ehat-na-kamchatku
 * и /chto-vzyat-s-soboj-na-kamchatku; медведей берёт из /faq, не из
 * /medvedi-kamchatki. Этот набор проверяет прямой ответ, дату редакции,
 * входящие ссылки с хабов и миграции на статью зимы и FAQ.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURED_GUIDE_PATHS, landingBySlug } from '@/lib/landings/landings';
import {
  SAFETY_RELATED_LINKS,
  SAFETY_SECTIONS,
  SAFETY_SOURCES,
  SAFETY_TEXT_LINKS,
} from '@/lib/seo/safety-page';
import { buildPlansFaq } from '@/lib/plans/faq';

const when = () => landingBySlug('kogda-ehat-na-kamchatku');
const pack = () => landingBySlug('chto-vzyat-s-soboj-na-kamchatku');
const bears = () => landingBySlug('medvedi-kamchatki');

describe('посадочные «когда ехать» и «что взять»', () => {
  it('первый абзац сразу отвечает на запрос, дата редакции — 23.11', () => {
    const lead = when().before.split('\n\n')[0] ?? '';
    expect(lead).toMatch(/^\*\*Коротко\.\*\*/);
    expect(lead).toMatch(/июль, август или сентябрь/);
    expect(lead).toMatch(/Долин[еы] гейзеров/);
    expect(lead).toMatch(/\[1\]/);
    expect(when().date).toBe('2026-11-23');

    const packLead = pack().before.split('\n\n')[0] ?? '';
    expect(packLead).toMatch(/^\*\*Коротко\.\*\*/);
    expect(packLead).toMatch(/одежд/);
    expect(packLead).toMatch(/пуховик даже летом/);
    expect(packLead).toMatch(/\[1\]/);
    expect(pack().date).toBe('2026-11-23');
  });

  it('на «когда ехать» есть ссылка на «что взять», без цен в лиде', () => {
    const text = `${when().before}\n${when().after}`;
    expect(text).toContain('](/chto-vzyat-s-soboj-na-kamchatku)');
    expect((when().before.split('\n\n')[0] ?? '')).not.toMatch(/₽|руб/);
    expect((pack().before.split('\n\n')[0] ?? '')).not.toMatch(/₽|руб/);
  });

  it('блок «Гид по Камчатке» на главной уже держит оба адреса', () => {
    expect(FEATURED_GUIDE_PATHS).toContain('/kogda-ehat-na-kamchatku');
    expect(FEATURED_GUIDE_PATHS).toContain('/chto-vzyat-s-soboj-na-kamchatku');
  });
});

describe('/medvedi-kamchatki — канон для запросов про медведей', () => {
  it('лид начинается с места и сезона наблюдения', () => {
    const lead = bears().before.split('\n\n')[0] ?? '';
    expect(lead).toMatch(/^\*\*Коротко\.\*\* Смотреть медведей на Камчатке лучше всего на Курильском озере/);
    expect(lead).toMatch(/июля по сентябрь/);
    expect(lead).toMatch(/\[2\]/);
    expect(bears().date).toBe('2026-11-23');
    const whenSection = bears().before;
    expect(whenSection).toContain('](/kogda-ehat-na-kamchatku)');
  });
});

describe('входящие ссылки с хабов', () => {
  it('/safety: связанные ссылки, текст и источники, радарный раздел на месте', () => {
    expect(SAFETY_RELATED_LINKS.some((l) => l.href === '/kogda-ehat-na-kamchatku')).toBe(true);
    expect(SAFETY_RELATED_LINKS.some((l) => l.href === '/chto-vzyat-s-soboj-na-kamchatku')).toBe(true);
    expect(SAFETY_TEXT_LINKS.some((l) => l.href === '/kogda-ehat-na-kamchatku')).toBe(true);
    expect(SAFETY_TEXT_LINKS.some((l) => l.href === '/chto-vzyat-s-soboj-na-kamchatku')).toBe(true);
    expect(SAFETY_SOURCES.some((s) => s.href === 'https://vedarai.ru/kogda-ehat-na-kamchatku')).toBe(true);
    expect(SAFETY_SOURCES.some((s) => s.href === 'https://vedarai.ru/chto-vzyat-s-soboj-na-kamchatku')).toBe(true);
    const weather = SAFETY_SECTIONS.find((s) => s.id === 'pogoda');
    expect(weather?.paragraphs.join(' ')).toMatch(/Когда ехать на Камчатку/);
    const svyaz = SAFETY_SECTIONS.find((s) => s.id === 'svyaz');
    expect(svyaz?.paragraphs.join(' ')).toMatch(/Что взять с собой на Камчатку/);
    expect(SAFETY_SECTIONS[0]?.id).toBe('medvedi');
  });

  it('месячные страницы и самостоятельная поездка ссылаются на список вещей', () => {
    for (const slug of ['kamchatka-v-iyule', 'kamchatka-v-dekabre', 'kamchatka-v-yanvare', 'kamchatka-samostoyatelno']) {
      const landing = landingBySlug(slug);
      const text = `${landing.before}\n${landing.after}`;
      expect(text, slug).toContain('](/chto-vzyat-s-soboj-na-kamchatku)');
    }
  });

  it('хаб /plans даёт обе ссылки в видимом FAQ', () => {
    const answers = buildPlansFaq().map((f) => f.answer).join('\n');
    expect(answers).toContain('Когда ехать на Камчатку');
    expect(answers).toContain('Что взять с собой на Камчатку');
    const page = readFileSync('app/plans/page.tsx', 'utf8');
    expect(page).toContain("href: '/kogda-ehat-na-kamchatku'");
    expect(page).toContain("href: '/chto-vzyat-s-soboj-na-kamchatku'");
  });
});

describe('миграция 1504: зима и FAQ', () => {
  const sql = readFileSync('migrations/1504_citation_ready_zima_faq.sql', 'utf8');

  it('добавляет в /articles/zima контекстные ссылки идемпотентно', () => {
    expect(sql).toContain("WHERE slug = 'zima'");
    expect(sql).toContain('](/kogda-ehat-na-kamchatku)');
    expect(sql).toContain('](/chto-vzyat-s-soboj-na-kamchatku)');
    expect(sql).toContain('AND body NOT LIKE \'%/chto-vzyat-s-soboj-na-kamchatku%\'');
    expect(sql).not.toMatch(/₽|руб/);
  });

  it('в ответах FAQ про медведей появляется канонический URL', () => {
    expect(sql).toContain('Где на Камчатке можно увидеть медведей?');
    expect(sql).toContain('Как вести себя при встрече с медведем на Камчатке?');
    expect(sql).toContain('https://vedarai.ru/medvedi-kamchatki');
    expect(sql).toContain('AND answer NOT LIKE \'%/medvedi-kamchatki%\'');
    expect(sql).toContain('https://vedarai.ru/kogda-ehat-na-kamchatku');
    expect(sql).toContain('https://vedarai.ru/chto-vzyat-s-soboj-na-kamchatku');
  });
});
