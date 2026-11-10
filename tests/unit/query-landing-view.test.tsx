// @vitest-environment node
/** Рендер посадочной: отказ базы ≠ пусто, CTA и MCP на месте, zh-название только из перевода. */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { landingByKey } from '@/lib/seo/query-landings';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';
import { OFFER_ORDER_NOTE } from '@/lib/tours/offer-order';

const row: LandingTourRow = {
  id: '7', slug: 'vulkan-gorelyy', title: 'Вулкан Горелый', base_price: '15000', price_unit: 'per_person',
  duration_hours: '10', operator_name: 'Компания', operator_slug: null, operator_public: false,
  season_start: null, season_end: null, next_open_date: null, title_zh: '戈雷利火山',
};

describe('QueryLandingView', () => {
  it('отказ базы — «не загрузился», пусто — «нет туров»', () => {
    const l = landingByKey('ru-bears');
    expect(renderToStaticMarkup(<QueryLandingView landing={l} tours={null} />)).toContain('Список не загрузился');
    expect(renderToStaticMarkup(<QueryLandingView landing={l} tours={[]} />)).toContain('нет опубликованных туров');
  });
  it('zh: переведённое имя ведёт на конспект, бронь — на русскую карточку; CTA и MCP', () => {
    const html = renderToStaticMarkup(<QueryLandingView landing={landingByKey('zh-volcano')} tours={[row]} />);
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('href="/zh/tours/vulkan-gorelyy"');
    expect(html).toContain('href="/catalog/tours/vulkan-gorelyy"');
    expect(html).toContain('15,000 卢布');
    expect(html).toContain('/api/mcp');
    expect(html).toContain('href="/request"');
    expect(html).toContain('"@type":"TouristTrip"');
  });
  it('zh: без перевода название — факт длительности, ссылка на китайскую страницу, бронь на русской', () => {
    const html = renderToStaticMarkup(<QueryLandingView landing={landingByKey('zh-volcano')} tours={[{ ...row, title_zh: null }]} />);
    expect(html).toContain('href="/zh/tours/vulkan-gorelyy"');
    expect(html).toContain('堪察加团队游，约 10 小时');
    expect(html).toContain('俄文原名');
    expect(html).not.toContain('>Вулкан Горелый</a>');
  });
  it('правило порядка 1в названо на языке страницы; без списка подписи нет', () => {
    const cases = [['ru-bears', OFFER_ORDER_NOTE.ru], ['en-booking', OFFER_ORDER_NOTE.en], ['zh-volcano', OFFER_ORDER_NOTE.zh]] as const;
    for (const [key, note] of cases) {
      expect(renderToStaticMarkup(<QueryLandingView landing={landingByKey(key)} tours={[row]} />), key).toContain(note);
      expect(renderToStaticMarkup(<QueryLandingView landing={landingByKey(key)} tours={null} />), key).not.toContain(note);
    }
    const ru = renderToStaticMarkup(<QueryLandingView landing={landingByKey('ru-bears')} tours={[row]} />);
    expect(ru).toContain('Место в списке не продаётся.');
    expect(ru).not.toContain('по названию компании');
  });
  it('трансфер: перевозчики с прайсом за машину и заявкой; отказ базы — «не загрузился», без туров', () => {
    const l = landingByKey('ru-transfer');
    const carrier = {
      partnerId: 'p1', slug: 'shatun', name: 'Шатун', shortDescription: null, logo: null, vehicles: [], seatClasses: [],
      destinations: [{ from: 'Петропавловск-Камчатский', to: 'Аэропорт Елизово', priceRub: 5000, note: null, conditions: null, validYear: null, place: null }],
      extraDay: null, rates: [], photos: [], clips: [], legal: null, video: null, phone: null, telegramHref: null, whatsappHref: null,
    };
    const html = renderToStaticMarkup(<QueryLandingView landing={l} tours={[]} charter={{ state: 'ok', carriers: [carrier] }} />);
    expect(html).toContain('href="/transfers/shatun"');
    expect(html).toContain('Аэропорт Елизово');
    expect(html).toContain('Заявка на машину');
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('за машину целиком');
    expect(html).not.toMatch(/₽[^<]{0,10}за место/);
    expect(html).not.toContain('Туры (');
    expect(html).not.toContain('href="/request"');
    const failed = renderToStaticMarkup(<QueryLandingView landing={l} tours={[]} charter={{ state: 'failed' }} />);
    expect(failed).toContain('Список не загрузился');
    expect(failed).not.toContain('ни один перевозчик');
    expect(renderToStaticMarkup(<QueryLandingView landing={l} tours={[]} charter={{ state: 'ok', carriers: [] }} />)).toContain('ни один перевозчик');
  });
  it('ссылки «по теме» видны: карточка Авачинского и страница обстановки', () => {
    const html = renderToStaticMarkup(<QueryLandingView landing={landingByKey('ru-avacha')} tours={[row]} />);
    expect(html).toContain('href="/places/vulkan-avachinskij"');
    expect(html).toContain('href="/safety"');
    expect(html).toContain('href="/catalog/tours/vulkan-gorelyy"');
  });
  it('en: без перевода — русское имя с lang="ru"', () => {
    const html = renderToStaticMarkup(<QueryLandingView landing={landingByKey('en-booking')} tours={[{ ...row, title_zh: undefined }]} />);
    expect(html).toContain('lang="ru"');
    expect(html).toContain('dates on request');
    expect(html).not.toContain('戈雷利火山');
  });
});
