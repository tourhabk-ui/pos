// @vitest-environment jsdom
/**
 * Откуда пришёл человек, открывший виджет партнёра (аудит 15.10, находка
 * WID-measure, W5). Судится поведением — исполнением скриптов в DOM и вызовом
 * роутов, не текстом исходника.
 *
 * Что было: домен партнёра не записывался нигде. Форма заявки не слала ни
 * адреса, ни реферера, чат писал Origin запроса — а это всегда vedarai.ru,
 * потому что запрос идёт из iframe. Белый список `widget_domains` сверялся
 * только в заголовке CORS, от которого ничего не зависит.
 *
 * Что держит этот файл:
 *  - embed.js и lead.js кладут в адрес окна хост и путь страницы партнёра —
 *    БЕЗ query и hash (там бывают телефон, почта, ключи);
 *  - /api/leads сам ставит исход listed / unlisted / not_sent и не верит
 *    исходу, присланному клиентом;
 *  - форма заявки отправляет хост и путь из адреса своего окна (их кладёт
 *    lead.js, а форме из окна чата — само окно чата: это держит
 *    widget-chat-page.test.tsx); своих нет — запасом из адреса чата по
 *    document.referrer.
 *
 * Хост подделывается — это сигнал для счёта, а не замок; поэтому ни приём
 * заявки, ни её адресат от исхода не зависят (проверено ниже).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { NextRequest } from 'next/server';
import {
  normalizeWidgetHost, normalizeWidgetPath, widgetOrigin, readWidgetOriginParams,
} from '@/lib/embed/widget-origin';

const ROOT = process.cwd();

const { poolQuery, createLeadMock } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  createLeadMock: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/leads/create', () => ({ createLead: createLeadMock }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn(async () => null) } }));
vi.mock('@/lib/notifications/lead-notify', () => ({
  notifyOperatorNewLead: vi.fn(async () => ({ ok: true })),
  notifyPartnerNewLeadPersonally: vi.fn(async () => ({ state: 'no_channel' })),
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn(async () => ({ delivered: true })) }));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({ leadProcessor: { process: vi.fn(async () => { throw new Error('не в этом тесте'); }) } }));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: vi.fn(async () => undefined) }));
vi.mock('@/lib/mcp/handoff', () => ({
  attachMcpAttribution: vi.fn(async () => null),
  MCP_ATTRIBUTION: { cookieName: 'mcp_h' },
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ slug: 'mestechko' }) }));

/** Страница партнёра: путь с query и hash, где лежат ПД. */
const PARTNER_PAGE = '/tury/vertolet/?phone=79001234567&email=a@b.ru#kontakty';

function onPartnerPage(path = PARTNER_PAGE) {
  window.history.replaceState({}, '', path);
}

let beacons: Array<{ url: string; body: string }> = [];

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  beacons = [];
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: vi.fn((url: string, body: string) => { beacons.push({ url, body }); return true; }),
  });
  poolQuery.mockReset();
  createLeadMock.mockReset();
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

function expectNoPd(s: string) {
  expect(s).not.toMatch(/79001234567|a@b\.ru|a%40b\.ru|kontakty|phone|email/);
}

describe('embed.js (чат): адрес окна и маяк', () => {
  const SRC = readFileSync(join(ROOT, 'public/widget/embed.js'), 'utf-8');
  function run(partnerId = 'mestechko') {
    const s = document.createElement('script');
    s.src = 'https://vedarai.ru/widget/embed.js';
    s.setAttribute('data-partner-id', partnerId);
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true });
    new Function(SRC)();
  }

  it('хост и путь страницы партнёра — в адресе окна, без query и hash', () => {
    onPartnerPage();
    run();
    (document.getElementById('tourhub-widget-btn') as HTMLButtonElement).click();
    const src = new URL((document.getElementById('tourhub-widget-frame') as HTMLIFrameElement).getAttribute('src')!);
    expect(src.origin + src.pathname).toBe('https://vedarai.ru/widget/mestechko');
    expect(src.searchParams.get('host')).toBe(location.hostname);
    expect(src.searchParams.get('path')).toBe('/tury/vertolet/');
    expectNoPd(src.href);
  });

  it('маяк открытия — один на просмотр, только партнёр, род и хост', () => {
    onPartnerPage();
    run();
    const btn = document.getElementById('tourhub-widget-btn') as HTMLButtonElement;
    expect(beacons).toHaveLength(0);
    btn.click(); // открыть
    btn.click(); // закрыть
    btn.click(); // открыть снова
    expect(beacons).toHaveLength(1);
    expect(beacons[0].url).toBe('https://vedarai.ru/api/widget/event');
    expect(JSON.parse(beacons[0].body)).toEqual({ partner: 'mestechko', kind: 'open', widget: 'chat', host: location.hostname });
    expectNoPd(beacons[0].body);
  });

  it('браузер без sendBeacon — чат открывается, счёта нет', () => {
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: undefined });
    run();
    (document.getElementById('tourhub-widget-btn') as HTMLButtonElement).click();
    expect(document.getElementById('tourhub-widget-frame')!.classList.contains('open')).toBe(true);
  });
});

describe('lead.js (форма): адрес окна, маяк, счёт выдачи', () => {
  const PARTNER = {
    id: '11111111-1111-1111-1111-111111111111', name: 'Местечко Камчатка', slug: 'mestechko',
    widget_config: {}, widget_domains: ['mestechkokam.ru'],
  };
  const BROWSER = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36';

  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__th_widget_mestechko;
    poolQuery.mockImplementation(async (sql: string) =>
      /FROM partners/.test(sql) ? { rows: [PARTNER] } : { rows: [], rowCount: 1 });
  });

  async function leadJs(headers: Record<string, string> = {}) {
    const { GET } = await import('@/app/api/widget/lead.js/route');
    return GET(new NextRequest('https://vedarai.ru/api/widget/lead.js?partner=mestechko', { headers }));
  }
  const servedCalls = () => poolQuery.mock.calls.filter((c) => /INSERT INTO widget_daily/.test(String(c[0])));

  it('хост и путь страницы — в адресе окна формы, без query и hash; маяк по первому открытию', async () => {
    onPartnerPage();
    const res = await leadJs();
    new Function(await res.text())();
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const src = new URL(iframe.getAttribute('src')!);
    expect(src.origin + src.pathname).toBe('https://vedarai.ru/widget/lead-form/mestechko');
    expect(src.searchParams.get('host')).toBe(location.hostname);
    expect(src.searchParams.get('path')).toBe('/tury/vertolet/');
    expectNoPd(src.href);

    const btn = document.getElementById('__th_btn_mestechko') as HTMLButtonElement;
    btn.click();
    btn.click();
    expect(beacons).toHaveLength(1);
    expect(JSON.parse(beacons[0].body)).toEqual({ partner: 'mestechko', kind: 'open', widget: 'form', host: location.hostname });
  });

  it('выдача считается по хосту из Referer; путь и query страницы в счёт не идут', async () => {
    const res = await leadJs({ referer: 'https://www.mestechkokam.ru/tury/?phone=79001234567', 'user-agent': BROWSER });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(servedCalls()).toHaveLength(1));
    expect(servedCalls()[0][1]).toEqual([PARTNER.id, 'www.mestechkokam.ru']);
  });

  it('без Referer — выдача считается с хостом null (исход not_sent), а не теряется', async () => {
    await leadJs({ 'user-agent': BROWSER });
    await vi.waitFor(() => expect(servedCalls()).toHaveLength(1));
    expect(servedCalls()[0][1]).toEqual([PARTNER.id, null]);
  });

  it('бот, исполнивший скрипт при обходе, не считается', async () => {
    await leadJs({ referer: 'https://mestechkokam.ru/', 'user-agent': 'Mozilla/5.0 (compatible; YandexBot/3.0)' });
    await new Promise((r) => setTimeout(r, 0));
    expect(servedCalls()).toHaveLength(0);
  });

  it('запись счёта зависла — скрипт выдан, не дожидаясь её', async () => {
    poolQuery.mockImplementation((sql: string) =>
      /FROM partners/.test(sql) ? Promise.resolve({ rows: [PARTNER] }) : new Promise(() => undefined));
    const res = await Promise.race([
      leadJs({ referer: 'https://mestechkokam.ru/', 'user-agent': BROWSER }),
      new Promise<'ждёт базу'>((r) => setTimeout(() => r('ждёт базу'), 300)),
    ]);
    expect(res).not.toBe('ждёт базу');
    expect((res as Response).status).toBe(200);
  });

  it('счёт не записался — скрипт всё равно выдан, отказ в логе с SQLSTATE', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (/FROM partners/.test(sql)) return { rows: [PARTNER] };
      throw Object.assign(new Error('relation "widget_daily" does not exist'), { code: '42P01' });
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await leadJs({ referer: 'https://mestechkokam.ru/', 'user-agent': BROWSER });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/__th_widget_mestechko/);
    await vi.waitFor(() => expect(err.mock.calls.flat().join(' ')).toMatch(/SQLSTATE=42P01/));
    err.mockRestore();
  });
});

describe('/api/leads: исход сверки хоста ставит сервер', () => {
  const MESTECHKO = { id: 'op-mestechko', name: 'Местечко Камчатка', widget_domains: ['mestechkokam.ru'] };

  beforeEach(() => {
    poolQuery.mockImplementation(async (sql: string) =>
      /FROM partners WHERE slug/.test(sql) ? { rows: [MESTECHKO] } : { rows: [] });
    createLeadMock.mockResolvedValue('lead-1');
  });

  let ipSeq = 0;
  async function post(sourceData: Record<string, unknown>) {
    const { POST } = await import('@/app/api/leads/route');
    ipSeq += 1;
    const res = await POST(new NextRequest('https://vedarai.ru/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.0.${ipSeq}` },
      body: JSON.stringify({
        name: 'Иван', phone: '+79000000001', pd_consent: true, partner_slug: 'mestechko',
        source_data: sourceData,
      }),
    }));
    expect(res.status).toBe(201);
    return createLeadMock.mock.calls.at(-1)![0] as { source_data: Record<string, unknown>; operator_id: string | null };
  }

  it('хост из списка партнёра (и его поддомен) — listed', async () => {
    const a = await post({ source: 'partner_widget', partner_slug: 'mestechko', widget_origin: { host: 'www.mestechkokam.ru', path: '/tury/?phone=79001234567' } });
    expect(a.source_data.widget_origin).toEqual({ host: 'www.mestechkokam.ru', path: '/tury/', host_check: 'listed' });
    expect(a.operator_id).toBe('op-mestechko');
  });

  it('телефон с разделителями в пути — в source_data метка, а не номер (аудит 15.10, R-path)', async () => {
    const a = await post({ source: 'partner_widget', partner_slug: 'mestechko', widget_origin: { host: 'mestechkokam.ru', path: '/spasibo/8-914-123-45-67' } });
    expect(a.source_data.widget_origin).toEqual({ host: 'mestechkokam.ru', path: '/spasibo/{digits}', host_check: 'listed' });
    expect(JSON.stringify(a.source_data)).not.toMatch(/914/);
  });

  it('путь-портянка из одних «+» (ревью R-path, ReDoS) — заявка принята быстро, путь не записан, хост записан', async () => {
    await import('@/app/api/leads/route'); // загрузка модуля — не в счёт времени разбора
    const t0 = performance.now();
    const a = await post({ source: 'partner_widget', partner_slug: 'mestechko', widget_origin: { host: 'mestechkokam.ru', path: '/' + '+'.repeat(100_000) } });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(a.source_data.widget_origin).toEqual({ host: 'mestechkokam.ru', path: null, host_check: 'listed' });
    expect(a.operator_id).toBe('op-mestechko');
  });

  it('чужой хост — unlisted, а заявка всё равно принята и адресована партнёру (сигнал, не замок)', async () => {
    const a = await post({ source: 'partner_widget', partner_slug: 'mestechko', widget_origin: { host: 'mestechkokam.ru.evil.example', path: '/' } });
    expect(a.source_data.widget_origin).toMatchObject({ host: 'mestechkokam.ru.evil.example', host_check: 'unlisted' });
    expect(a.operator_id).toBe('op-mestechko');
  });

  it('хоста нет (старая форма из кэша) — not_sent, а не пропуск записи', async () => {
    const a = await post({ source: 'partner_widget', partner_slug: 'mestechko' });
    expect(a.source_data.widget_origin).toEqual({ host: null, path: null, host_check: 'not_sent' });
  });

  it('исход, присланный клиентом, не принимается', async () => {
    const a = await post({ source: 'partner_widget', partner_slug: 'mestechko', widget_origin: { host: 'evil.example', path: '/', host_check: 'listed' } });
    expect(a.source_data.widget_origin).toMatchObject({ host: 'evil.example', host_check: 'unlisted' });
  });

  it('не форма виджета — запись «откуда» не берётся у клиента вовсе', async () => {
    const a = await post({ source: 'operator_page', partner_slug: 'mestechko', widget_origin: { host: 'mestechkokam.ru', host_check: 'listed' } });
    expect(a.source_data).not.toHaveProperty('widget_origin');
  });

  it('мусор вместо хоста (не имя хоста) — not_sent, строка в базу не идёт', async () => {
    const a = await post({ source: 'partner_widget', partner_slug: 'mestechko', widget_origin: { host: 'ivan@mail.ru', path: '/x' } });
    expect(a.source_data.widget_origin).toEqual({ host: null, path: null, host_check: 'not_sent' });
  });
});

describe('форма заявки шлёт хост и путь из адреса своего окна', () => {
  // Форма говорит на языке браузера посетителя (аудит 15.10, WID-lang), а у
  // jsdom он английский; подписи ниже — русские, значит и браузер русский.
  let language: { mockRestore: () => void };
  beforeEach(() => { language = vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ru-RU'); });
  afterEach(() => { language.mockRestore(); });

  async function submitForm() {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/widget/partner/')) {
        return new Response(JSON.stringify({ success: true, data: { name: 'Местечко Камчатка', greeting: '', accentColor: '#C2410A', logo: null } }));
      }
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true, id: 'lead-1' }), { status: 201 });
    }));
    const { default: LeadFormPage } = await import('@/app/widget/lead-form/[slug]/page');
    render(React.createElement(LeadFormPage));
    await waitFor(() => expect(screen.getByText('Местечко Камчатка')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('Иван Иванов'), { target: { value: 'Иван' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79000000001' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Отправить заявку/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/leads')).toBe(true));
    return calls.find((c) => c.url === '/api/leads')!.body;
  }

  it('окно открыто скриптом lead.js — хост и путь из своих параметров', async () => {
    onPartnerPage('/widget/lead-form/mestechko?host=mestechkokam.ru&path=%2Ftury%2F');
    const body = await submitForm();
    expect((body.source_data as Record<string, unknown>).widget_origin).toEqual({ host: 'mestechkokam.ru', path: '/tury/' });
  });

  it('запас: окно чата не передало параметры — хост и путь из адреса чата по рефереру', async () => {
    onPartnerPage('/widget/lead-form/mestechko');
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: `${location.origin}/widget/mestechko?theme=light&host=mestechkokam.ru&path=%2Fkontakty%2F`,
    });
    const body = await submitForm();
    expect((body.source_data as Record<string, unknown>).widget_origin).toEqual({ host: 'mestechkokam.ru', path: '/kontakty/' });
    Object.defineProperty(document, 'referrer', { configurable: true, value: '' });
  });
});

describe('правила чистки — граничные данные', () => {
  it('хост: только имя хоста, в нижнем регистре', () => {
    expect(normalizeWidgetHost('WWW.Mestechkokam.RU.')).toBe('www.mestechkokam.ru');
    for (const bad of ['', 'https://x.ru', 'x.ru:8080', 'ivan@mail.ru', 'a b.ru', '-x.ru', 'x'.repeat(254), 42, null]) {
      expect(normalizeWidgetHost(bad)).toBeNull();
    }
  });

  it('путь: без query и hash, телефоны и почта в сегментах заменены, длина ограничена', () => {
    expect(normalizeWidgetPath('/tury/?phone=1#x')).toBe('/tury/');
    expect(normalizeWidgetPath('/zakaz/79001234567/')).toBe('/zakaz/{digits}/');
    expect(normalizeWidgetPath('/u/ivan@mail.ru/')).toBe('/u/{email}/');
    expect(normalizeWidgetPath('/u/ivan%40mail.ru/')).toBe('/u/{email}/');
    expect(normalizeWidgetPath('tury')).toBeNull();
    expect(normalizeWidgetPath('/' + 'a'.repeat(500))!.length).toBe(200);
  });

  it('три исхода и только три', () => {
    const d = ['mestechkokam.ru'];
    expect(widgetOrigin('mestechkokam.ru', '/', d).host_check).toBe('listed');
    expect(widgetOrigin('shop.mestechkokam.ru', '/', d).host_check).toBe('listed');
    expect(widgetOrigin('notmestechkokam.ru', '/', d).host_check).toBe('unlisted');
    expect(widgetOrigin('mestechkokam.ru', '/', null).host_check).toBe('unlisted');
    expect(widgetOrigin(undefined, '/tury/', d)).toEqual({ host: null, path: null, host_check: 'not_sent' });
  });

  it('реферер другого источника или не окна виджета — не родитель', () => {
    const own = 'https://vedarai.ru';
    expect(readWidgetOriginParams('', 'https://evil.example/widget/x?host=mestechkokam.ru', own).host).toBeNull();
    expect(readWidgetOriginParams('', 'https://vedarai.ru/tours?host=mestechkokam.ru', own).host).toBeNull();
    expect(readWidgetOriginParams('', 'не адрес', own).host).toBeNull();
    expect(readWidgetOriginParams('?host=a.ru&path=%2Fb', 'https://vedarai.ru/widget/x?host=c.ru', own)).toEqual({ host: 'a.ru', path: '/b' });
  });
});
