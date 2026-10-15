// @vitest-environment jsdom
/**
 * Виджет Ведара на сайте «Местечка Камчатка» (владелец 15.10: «вставь в сайт
 * местечка наш виджет»), судится поведением — тем, что увидит турист.
 *
 * Находка аудита 15.10 WID-config: на проде lead.js?partner=mestechko рисовал
 * кнопку «Чат», хотя она открывает ФОРМУ заявки, — подпись была заготовкой
 * DEFAULT колонки из 142, а не выбором партнёра. Форма же ставила над полями
 * имени и телефона приветствие ЧАТА из 1260 («Я Кузьмич… спрашивайте»).
 *
 * Прежняя редакция этого файла проверяла текст миграции и заголовок CORS
 * ответа lead.js. От заголовка не зависит ничего: классический <script src>
 * в CORS не нуждается, а форма ходит со своего источника. Теперь — вызов:
 *   - скрипт lead.js исполняется в DOM, и кнопка подписана по смыслу —
 *     при заготовке 142 (состояние прода до 1280), после 1280 и при своей
 *     подписи партнёра;
 *   - форма, отрисованная по ответу настоящего /api/widget/partner, показывает
 *     вступление формы, а не приветствие чата.
 * Что миграция 1280 пишет в базу и чего не перетирает — на настоящем
 * PostgreSQL: tests/integration/operators-list.pg.test.ts, блок «виджет
 * партнёра».
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({ query: vi.fn() }));
// lead.js читает пул, /api/widget/partner — обёртку query: обе — одна строка партнёра.
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/database', () => ({ query: m.query }));
vi.mock('next/navigation', () => ({ useParams: () => ({ slug: 'mestechko' }) }));

import { GET as leadJs } from '@/app/api/widget/lead.js/route';
import { GET as partnerApi } from '@/app/api/widget/partner/[partnerId]/route';
import LeadFormPage from '@/app/widget/lead-form/[slug]/page';
import { LEAD_FORM_INTRO_DEFAULT } from '@/lib/embed/widget-style';

/** Приветствие чата из 1260 — для чата, не для формы. */
const GREETING_1260 = 'Здравствуйте! Я Кузьмич, помощник платформы Ведар. Подскажу по турам «Местечка Камчатка», сезону и безопасности на маршрутах — спрашивайте.';
/** Строка «Местечка» на проде 15.10: заготовка 142 + приветствие 1260. */
const PROD_BEFORE_1280 = { greeting: GREETING_1260, accentColor: '#D44A0C', buttonText: 'Чат', position: 'right' };
const FORM_INTRO = 'Оставьте заявку — «Местечко Камчатка» свяжется с вами по указанному телефону.';
const AFTER_1280 = { ...PROD_BEFORE_1280, buttonText: 'Заявка на тур', formIntro: FORM_INTRO };

function partnerRow(widgetConfig: Record<string, unknown> | null) {
  return {
    name: 'Местечко Камчатка', slug: 'mestechko', category: 'operator', short_description: null,
    logo_image: '/images/mestechko/logo.png', widget_config: widgetConfig, widget_domains: ['mestechkokam.ru'],
  };
}

/** Исполняет выданный lead.js в DOM и возвращает плавающую кнопку. */
async function mountLeadJs(): Promise<HTMLButtonElement> {
  const res = await leadJs(new NextRequest('https://vedarai.ru/api/widget/lead.js?partner=mestechko'));
  expect(res.status).toBe(200);
  new Function(await res.text())();
  const btn = document.getElementById('__th_btn_mestechko') as HTMLButtonElement | null;
  expect(btn).not.toBeNull();
  return btn!;
}

beforeEach(() => {
  m.query.mockReset();
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__th_widget_mestechko;
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('кнопка lead.js на сайте «Местечка»', () => {
  it('заготовка 142 (прод до 1280): кнопка формы не подписана «Чат»', async () => {
    m.query.mockResolvedValue({ rows: [partnerRow(PROD_BEFORE_1280)] });
    const btn = await mountLeadJs();
    expect(btn.textContent).toBe('Заявка на тур');
  });

  it('после 1280 — «Заявка на тур», и клик открывает окно с формой заявки партнёра', async () => {
    m.query.mockResolvedValue({ rows: [partnerRow(AFTER_1280)] });
    const btn = await mountLeadJs();
    expect(btn.textContent).toBe('Заявка на тур');
    const overlay = document.getElementById('__th_overlay_mestechko') as HTMLDivElement;
    expect(overlay.style.display).toBe('none');
    btn.click();
    expect(overlay.style.display).toBe('flex');
    // Адрес формы партнёра; хост и путь страницы, где стоит кнопка, скрипт
    // кладёт в параметры (WID-measure) — здесь это адрес документа jsdom.
    const src = new URL(overlay.querySelector('iframe')?.getAttribute('src') ?? '');
    expect(`${src.origin}${src.pathname}`).toBe('https://vedarai.ru/widget/lead-form/mestechko');
    expect(src.searchParams.get('host')).toBe(window.location.hostname);
    expect(src.searchParams.get('path')).toBe(window.location.pathname);
  });

  it('свою подпись партнёра скрипт не подменяет', async () => {
    m.query.mockResolvedValue({ rows: [partnerRow({ ...AFTER_1280, buttonText: 'Записаться на вертолёт' })] });
    const btn = await mountLeadJs();
    expect(btn.textContent).toBe('Записаться на вертолёт');
  });

  it('виджет выключен — скрипт не выдаётся', async () => {
    m.query.mockResolvedValue({ rows: [] });
    const res = await leadJs(new NextRequest('https://vedarai.ru/api/widget/lead.js?partner=mestechko'));
    expect(res.status).toBe(404);
  });
});

describe('форма заявки /widget/lead-form/mestechko', () => {
  /** Форма грузит конфиг из настоящего роута /api/widget/partner. */
  function serveFormConfig(widgetConfig: Record<string, unknown> | null) {
    m.query.mockResolvedValue({ rows: [partnerRow(widgetConfig)] });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('/api/widget/partner/mestechko');
      return partnerApi(new NextRequest('https://vedarai.ru/api/widget/partner/mestechko'),
        { params: Promise.resolve({ partnerId: 'mestechko' }) });
    }));
  }

  it('над полями — вступление формы, а не приветствие чата', async () => {
    serveFormConfig(AFTER_1280);
    render(React.createElement(LeadFormPage));
    expect(await screen.findByText(FORM_INTRO)).toBeTruthy();
    // Имя партнёра в шапке — значит, конфиг загружен, и приветствия нет не
    // потому, что форма его не дождалась.
    await waitFor(() => expect(screen.getByText('Местечко Камчатка')).toBeTruthy());
    expect(screen.queryByText(GREETING_1260)).toBeNull();
    expect(document.body.textContent).not.toMatch(/спрашивайте/);
  });

  it('вступление не задано — нейтральный текст без обещания срока, приветствия чата нет', async () => {
    serveFormConfig(PROD_BEFORE_1280);
    render(React.createElement(LeadFormPage));
    await waitFor(() => expect(screen.getByText('Местечко Камчатка')).toBeTruthy());
    expect(screen.getByText(LEAD_FORM_INTRO_DEFAULT)).toBeTruthy();
    expect(LEAD_FORM_INTRO_DEFAULT).not.toMatch(/сегодня|в течение|минут|час/);
    expect(screen.queryByText(GREETING_1260)).toBeNull();
  });
});
