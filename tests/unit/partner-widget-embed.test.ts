/**
 * Виджеты партнёра на чужом сайте: заявка доходит до оператора, форму можно
 * отправить, кнопки не закрывают чужие плашки (примерка на fishingkam.ru 29.09).
 *
 * Что было:
 *  - форма клала `partner_slug` только в `source_data`, а `/api/leads` искал
 *    его на верхнем уровне тела — лид вставал без оператора, уходил в общий
 *    пул и в рабочий чат платформы, Анатолий его не видел;
 *  - окно формы 440 px со scrolling="no" при форме 537 px — «Отправить
 *    заявку» за краем, кликом не отправить;
 *  - отступ кнопок снизу зашит (24 / 20 px) — на телефоне чат закрывал
 *    «Связаться с нами» и «Принять» на cookie-плашке партнёра;
 *  - окно чата на 390 px уезжало на 125 px за правый край;
 *  - скрипт в <head> без defer падал на document.body === null.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { widgetStyle } from '@/lib/embed/widget-style';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const { poolQuery, createLeadMock } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  createLeadMock: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/leads/create', () => ({ createLead: createLeadMock }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn(async () => null) } }));
vi.mock('@/lib/notifications/lead-notify', () => ({ notifyOperatorNewLead: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({ leadProcessor: { processLead: vi.fn(async () => null) } }));
vi.mock('@/lib/mcp/handoff', () => ({
  attachMcpAttribution: vi.fn(async () => null),
  MCP_ATTRIBUTION: { cookieName: 'mcp_h' },
}));

describe('форма заявки виджета → оператор партнёра', () => {
  it('форма шлёт partner_slug на верхнем уровне тела', () => {
    const page = read('app/widget/lead-form/[slug]/page.tsx');
    const body = page.slice(page.indexOf("fetch('/api/leads'"), page.indexOf('pd_consent: true'));
    // Верхний уровень — до вложенного source_data.
    expect(body).toMatch(/partner_slug: slug,\s*(\/\/[^\n]*\n\s*)*source_data: \{/);
  });

  describe('POST /api/leads', () => {
    beforeEach(() => {
      poolQuery.mockReset();
      createLeadMock.mockReset();
      poolQuery.mockImplementation(async (sql: string) =>
        /FROM partners WHERE slug/.test(sql) ? { rows: [{ id: 'op-fishingkam' }] } : { rows: [] });
      createLeadMock.mockResolvedValue('lead-1');
    });

    async function post(body: Record<string, unknown>, ip: string) {
      const { POST } = await import('@/app/api/leads/route');
      const req = new NextRequest('https://vedarai.ru/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ name: 'Иван', phone: '+79000000001', pd_consent: true, ...body }),
      });
      return POST(req);
    }

    it('partner_slug на верхнем уровне: лид получает оператора и источник согласия widget', async () => {
      const res = await post({ partner_slug: 'fishingkam', source_data: { source: 'partner_widget', partner_slug: 'fishingkam' } }, '10.0.0.1');
      expect(res.status).toBe(201);
      const slugQuery = poolQuery.mock.calls.find(c => /FROM partners WHERE slug/.test(String(c[0])));
      expect(slugQuery?.[1]).toEqual(['fishingkam']);
      const arg = createLeadMock.mock.calls[0][0];
      expect(arg.operator_id).toBe('op-fishingkam');
      expect(JSON.stringify(arg.pd_consent)).toMatch(/widget/);
    });

    it('старая форма (slug только в source_data) тоже доходит до оператора', async () => {
      const res = await post({ source_data: { source: 'partner_widget', partner_slug: 'fishingkam' } }, '10.0.0.2');
      expect(res.status).toBe(201);
      expect(createLeadMock.mock.calls[0][0].operator_id).toBe('op-fishingkam');
    });

    it('без slug оператор не выдумывается', async () => {
      const res = await post({ source_data: { source: 'sticky_cta' } }, '10.0.0.3');
      expect(res.status).toBe(201);
      expect(poolQuery.mock.calls.some(c => /FROM partners WHERE slug/.test(String(c[0])))).toBe(false);
      expect(createLeadMock.mock.calls[0][0].operator_id).toBeNull();
    });
  });
});

describe('widgetStyle — конфиг партнёра в скрипт только проверенным', () => {
  it('fishingkam: цвет лендинга, левый угол, отступ над плашками', () => {
    expect(widgetStyle({ accentColor: '#003466', position: 'left', bottom: 120, buttonText: 'Заявка на тур' }))
      .toEqual({ accent: '#003466', position: 'left', bottom: 120, buttonText: 'Заявка на тур' });
  });
  it('мусор в конфиге заменяется умолчаниями, а не уходит в чужой сайт', () => {
    const s = widgetStyle({ accentColor: 'red;background:url(x)', position: 'top', bottom: 'abc', buttonText: '   ' });
    expect(s).toEqual({ accent: '#D44A0C', position: 'right', bottom: 24, buttonText: 'Заявка на тур' });
  });
  it('отступ ограничен 0–400 и принимает строку-число', () => {
    expect(widgetStyle({ bottom: 9999 }).bottom).toBe(400);
    expect(widgetStyle({ bottom: -5 }).bottom).toBe(0);
    expect(widgetStyle({ bottom: '110' }).bottom).toBe(110);
  });
});

describe('GET /api/widget/lead.js — скрипт на сайте партнёра', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // Скрипт защищён от двойной вставки флагом на window — между тестами сбрасываем.
    delete (window as unknown as Record<string, unknown>).__th_widget_fishingkam;
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [{
      name: 'Камчатская рыбалка', slug: 'fishingkam',
      widget_config: { accentColor: '#003466', position: 'left', bottom: 120, buttonText: 'Заявка на тур' },
      widget_domains: ['fishingkam.ru'],
    }] });
  });
  afterEach(() => { document.body.innerHTML = ''; });

  async function script(): Promise<string> {
    const { GET } = await import('@/app/api/widget/lead.js/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/widget/lead.js?partner=fishingkam'));
    expect(res.status).toBe(200);
    return res.text();
  }

  it('кнопка в цвет партнёра и на его отступе', async () => {
    new Function(await script())();
    const btn = document.getElementById('__th_btn_fishingkam') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.style.bottom).toBe('120px');
    expect(btn.style.left).toBe('24px');
    expect(btn.style.background).toMatch(/rgb\(0, 52, 102\)|#003466/i);
  });

  it('окно формы подгоняется под высоту формы и прокрутку не запрещает', async () => {
    new Function(await script())();
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('scrolling')).toBeNull();
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://vedarai.ru',
      data: { type: 'th:height', height: 537 },
      source: iframe.contentWindow,
    }));
    expect(iframe.style.height).toBe('537px');
  });

  it('экран уменьшился (клавиатура, поворот) — окно пересчитывается от высоты формы', async () => {
    new Function(await script())();
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://vedarai.ru', data: { type: 'th:height', height: 537 }, source: iframe.contentWindow,
    }));
    expect(iframe.style.height).toBe('537px');
    const before = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(iframe.style.height).toBe('336px');
    Object.defineProperty(window, 'innerHeight', { value: before, configurable: true });
  });

  it('высоту от чужого источника не принимает', async () => {
    new Function(await script())();
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const before = iframe.style.height;
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', data: { type: 'th:height', height: 50 } }));
    expect(iframe.style.height).toBe(before);
  });

  it('без defer в <head> ждёт DOMContentLoaded, а не падает на body', async () => {
    expect(await script()).toMatch(/if \(document\.body\) mount\(\);\s*else document\.addEventListener\('DOMContentLoaded', mount\);/);
  });
});

describe('embed.js — чат на сайте партнёра', () => {
  const SRC = read('public/widget/embed.js');

  function run(attrs: Record<string, string>) {
    const s = document.createElement('script');
    s.src = 'https://vedarai.ru/widget/embed.js';
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true });
    new Function(SRC)();
  }
  const css = () => [...document.head.querySelectorAll('style')].map(s => s.textContent).join('\n');

  beforeEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });

  it('отступ и цвет из атрибутов попадают в стили', () => {
    run({ 'data-partner-id': 'fishingkam', 'data-color': '#003466', 'data-bottom': '120' });
    expect(css()).toMatch(/#tourhub-widget-root\{position:fixed;bottom:120px/);
    expect(css()).toMatch(/background:#003466/);
    // Верх окна чата не уходит за экран при большом отступе.
    expect(css()).toMatch(/max-height:calc\(100vh - 210px\)/);
  });

  it('произвольная строка в data-color в CSS не попадает', () => {
    run({ 'data-partner-id': 'x', 'data-color': 'red}body{display:none' });
    expect(css()).not.toMatch(/display:none/);
    expect(css()).toMatch(/background:#D44A0C/);
  });

  it('на телефоне окно чата привязано к краям экрана, а не к кнопке', () => {
    run({ 'data-partner-id': 'fishingkam', 'data-bottom': '120' });
    const mobile = css().match(/@media\(max-width:420px\)\{([^@]*)\}/)?.[1] ?? '';
    expect(mobile).toMatch(/position:fixed;left:16px;right:16px;width:calc\(100vw - 32px\);bottom:190px/);
    expect(mobile).not.toMatch(/left:50%/);
  });

  it('iframe чата грузится по первому открытию, а не на каждый просмотр страницы партнёра', () => {
    run({ 'data-partner-id': 'fishingkam' });
    const frame = document.getElementById('tourhub-widget-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBeNull();
    (document.getElementById('tourhub-widget-btn') as HTMLButtonElement).click();
    expect(frame.getAttribute('src')).toBe('https://vedarai.ru/widget/fishingkam?theme=light');
  });
});
