/**
 * WebMCP, декларативная часть: формы Ведара как инструменты агента в браузере
 * (слово владельца 20.11 «Сделай WebMCP»). Судится рендером (CLAUDE.md §4).
 *
 *  - форма заявки на тур — инструмент БЕЗ `toolautosubmit`: агент заполняет,
 *    отправляет человек; у галочки согласия на ПД нет `name`, и агенту её не
 *    заполнить; дату агенту тоже не отдаём — её выбирают в календаре;
 *  - поиск каталога — инструмент с автоотправкой: он только читает;
 *    отправка, нажатая человеком, страницу не перезагружает (живой отбор);
 *  - то, что агент вписал в поля мимо React, перечитывается по
 *    `toolactivated` и уходит в заявку — иначе человек видел бы заполненную
 *    форму, а сервер получил бы пустую;
 *  - нет API в браузере — форма ведёт себя как раньше;
 *  - ключ пробного запуска выводится только заданный и похожий на ключ.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/catalog' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
}));
vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => React.createElement('img', { src: p.src, alt: p.alt }),
}));
vi.mock('@/lib/auth/session-state', () => ({ sessionState: () => Promise.resolve(false) }));

import BookingFormClient from '@/components/marketplace/BookingFormClient';
import MarketplaceClient from '@/components/marketplace/MarketplaceClient';
import { WebMcpTools } from '@/components/shared/WebMcpTools';
import { WEBMCP_ORIGIN_TRIAL_ENV, webmcpOriginTrialToken } from '@/lib/webmcp/origin-trial';
import { isAgentInvokedSubmit } from '@/lib/webmcp/form-attrs';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

/** Подставной `document.modelContext`: агент браузера. */
function installModelContext() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const registerTool = vi.fn();
  const ctx = {
    registerTool,
    addEventListener: (type: string, l: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(l);
    },
    removeEventListener: (type: string, l: (e: Event) => void) => { listeners.get(type)?.delete(l); },
  };
  Object.defineProperty(document, 'modelContext', { value: ctx, configurable: true });
  return {
    ctx,
    registerTool,
    fire: (type: string) => { for (const l of listeners.get(type) ?? []) l(new Event(type)); },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

function removeModelContext() {
  delete (document as unknown as { modelContext?: unknown }).modelContext;
}

/** Значение легло в поле мимо React — так, как его мог бы вписать браузер. */
function setDomValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  removeModelContext();
});

describe('форма заявки на тур — инструмент без автоотправки', () => {
  function mockSlots(slotDate: string) {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/slots')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, slots: [{ date: slotDate, free_slots: 5 }] }) });
      if (u.includes('/price')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      if (u.includes('/api/hub/bookings/create')) return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: 'тест' }) });
      return Promise.reject(new Error('unexpected fetch: ' + u));
    });
  }

  it('имя инструмента и описание есть, toolautosubmit нет; описание говорит, что отправляет человек', () => {
    mockSlots(futureDate(10));
    const { container } = render(<BookingFormClient tourId={27} basePrice={13000} />);
    const form = container.querySelector('form');
    expect(form?.getAttribute('toolname')).toBe('vedar_tour_request');
    expect(form?.hasAttribute('toolautosubmit')).toBe(false);
    expect(form?.getAttribute('tooldescription')).toContain('Форма не отправляется сама');
    expect(form?.getAttribute('tooldescription')).toContain('не бронь');
  });

  it('параметры агенту — участники, имя, телефон, почта, пожелания; согласия и даты среди них нет', () => {
    mockSlots(futureDate(10));
    const { container } = render(<BookingFormClient tourId={27} basePrice={13000} />);
    const params = [...container.querySelectorAll('[toolparamdescription]')].map((el) => el.getAttribute('name'));
    expect(params.sort()).toEqual(['participants_count', 'special_requests', 'tourist_email', 'tourist_name', 'tourist_phone']);
    const consent = screen.getByRole('checkbox', { name: /обработку персональных данных/i });
    expect(consent.getAttribute('name')).toBeNull();
    expect(consent.hasAttribute('toolparamdescription')).toBe(false);
  });

  it('вписанное агентом мимо React перечитывается по toolactivated и уходит в заявку; галочку ставит человек', async () => {
    const d = futureDate(10);
    mockSlots(d);
    const agent = installModelContext();
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    expect(agent.count('toolactivated')).toBe(1);

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${Number(d.slice(8, 10))} \\S+, свободно мест: \\d+$`) }));
    setDomValue(screen.getByLabelText('Имя *') as HTMLInputElement, 'Анна Агентова');
    setDomValue(screen.getByLabelText('Телефон *') as HTMLInputElement, '8 900 123-45-67');
    setDomValue(screen.getByLabelText(/Email/) as HTMLInputElement, 'anna@example.com');
    setDomValue(screen.getByPlaceholderText(/Особые пожелания/) as HTMLTextAreaElement, 'Едем вдвоём');
    act(() => agent.fire('toolactivated'));

    // Агент не отправил: кнопка без галочки согласия не активна.
    const submit = screen.getByRole('button', { name: /Оставить заявку/ });
    expect(submit).toBeDisabled();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/hub/bookings/create'))).toBe(false);

    fireEvent.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
    fireEvent.click(submit);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/hub/bookings/create'))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/hub/bookings/create'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body).toMatchObject({ tourist_name: 'Анна Агентова', tourist_email: 'anna@example.com', tourist_phone: '+79001234567', special_requests: 'Едем вдвоём', pd_consent: true, booking_date: d });
  });

  it('пустое поле агента не стирает введённое человеком', async () => {
    mockSlots(futureDate(10));
    const agent = installModelContext();
    render(<BookingFormClient tourId={27} basePrice={13000} />);
    const name = screen.getByLabelText('Имя *') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Пётр' } });
    setDomValue(screen.getByPlaceholderText(/Особые пожелания/) as HTMLTextAreaElement, '');
    act(() => agent.fire('toolactivated'));
    expect(name.value).toBe('Пётр');
  });

  it('уход со страницы снимает подписку', () => {
    mockSlots(futureDate(10));
    const agent = installModelContext();
    const { unmount } = render(<BookingFormClient tourId={27} basePrice={13000} />);
    expect(agent.count('toolactivated')).toBe(1);
    unmount();
    expect(agent.count('toolactivated')).toBe(0);
  });
});

describe('поиск каталога — инструмент с автоотправкой', () => {
  const KEY = JSON.stringify({ search: '', activityFilter: '', sort: 'recommended', difficulty: '', priceRange: '', durationType: '' });

  it('форма поиска ведёт на /catalog с параметром search, агенту можно отправлять самому', () => {
    render(<MarketplaceClient initialTours={[]} initialTotal={0} initialKey={KEY} summary={null} />);
    const form = screen.getByRole('search') as HTMLFormElement;
    expect(form.getAttribute('toolname')).toBe('vedar_catalog_search');
    expect(form.hasAttribute('toolautosubmit')).toBe(true);
    expect(form.getAttribute('action')).toBe('/catalog');
    expect(form.getAttribute('method')).toBe('get');
    const input = form.querySelector('input[name="search"]');
    expect(input?.getAttribute('toolparamdescription')).toContain('Слова из названия тура');
  });

  it('Enter человека не перезагружает страницу: живой отбор остаётся', () => {
    render(<MarketplaceClient initialTours={[]} initialTotal={0} initialKey={KEY} summary={null} />);
    const form = screen.getByRole('search');
    const human = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(human);
    expect(human.defaultPrevented).toBe(true);
  });

  it('отправку агента не перехватывает: браузер открывает каталог с отбором', () => {
    render(<MarketplaceClient initialTours={[]} initialTotal={0} initialKey={KEY} summary={null} />);
    const form = screen.getByRole('search');
    const byAgent = Object.assign(new Event('submit', { bubbles: true, cancelable: true }), { agentInvoked: true });
    form.dispatchEvent(byAgent);
    expect(byAgent.defaultPrevented).toBe(false);
  });

  it('признак агента — только agentInvoked === true', () => {
    expect(isAgentInvokedSubmit(new Event('submit'))).toBe(false);
    expect(isAgentInvokedSubmit(Object.assign(new Event('submit'), { agentInvoked: 'true' }))).toBe(false);
    expect(isAgentInvokedSubmit(Object.assign(new Event('submit'), { agentInvoked: true }))).toBe(true);
  });
});

describe('инструменты страницы в корневом макете', () => {
  it('нет API — ни запроса, ни ошибки', () => {
    render(<WebMcpTools />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('есть API — список инструментов читается с /api/mcp того же сайта', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [
      { name: 'get_weather', description: 'Погода', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'create_lead', description: 'Заявка', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    ] } }), { status: 200 }));
    const agent = installModelContext();
    render(<WebMcpTools />);
    await waitFor(() => expect(agent.registerTool).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/mcp');
    expect(agent.registerTool.mock.calls[0][0]).toMatchObject({ name: 'get_weather', annotations: { readOnlyHint: true } });
  });

  it('виджет в iframe и сайт партнёра — витрина партнёра: инструментов Ведара нет', async () => {
    const agent = installModelContext();
    for (const path of ['/widget/fishingkam', '/partner-site']) {
      nav.pathname = path;
      try {
        render(<WebMcpTools />);
        await act(async () => { await Promise.resolve(); });
      } finally {
        nav.pathname = '/catalog';
        cleanup();
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agent.registerTool).not.toHaveBeenCalled();
  });

  it('список не прочитался — причина в лог, страница работает дальше', async () => {
    fetchMock.mockResolvedValue(new Response('нет', { status: 502 }));
    const agent = installModelContext();
    render(<WebMcpTools />);
    await waitFor(() => expect(console.error).toHaveBeenCalledWith('[webmcp] инструменты страницы не зарегистрированы:', expect.stringContaining('HTTP 502')));
    expect(agent.registerTool).not.toHaveBeenCalled();
  });
});

describe('ключ пробного запуска', () => {
  const TOKEN = 'A'.repeat(300) + '==';
  it('не задан или пуст — тега нет', () => {
    expect(webmcpOriginTrialToken({})).toBeNull();
    expect(webmcpOriginTrialToken({ [WEBMCP_ORIGIN_TRIAL_ENV]: '   ' })).toBeNull();
  });

  it('похож на ключ — выводится как есть (пробелы по краям сняты)', () => {
    expect(webmcpOriginTrialToken({ [WEBMCP_ORIGIN_TRIAL_ENV]: ` ${TOKEN}\n` })).toBe(TOKEN);
  });

  it('не похож на ключ — тега нет, причина в лог (без самого значения)', () => {
    const bad = '"><script>alert(1)</script>';
    expect(webmcpOriginTrialToken({ [WEBMCP_ORIGIN_TRIAL_ENV]: bad })).toBeNull();
    expect(webmcpOriginTrialToken({ [WEBMCP_ORIGIN_TRIAL_ENV]: 'короткий' })).toBeNull();
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(' ');
    expect(logged).not.toContain('script');
  });
});
