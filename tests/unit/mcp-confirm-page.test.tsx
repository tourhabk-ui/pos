// @vitest-environment jsdom
/**
 * Заявку внешнего ИИ-агента отправляет сам человек на /confirm (#3399, п. 4;
 * слово владельца 15.11 «Делай»).
 *
 * Сторож держит: хранилище не кладёт в базу сам токен и стирает имя и телефон
 * при отправке; страница не отдаёт телефон целиком; без галочки отправки нет;
 * отправка — один раз; план поправили после черновика — отправки нет; база не
 * ответила — «заявка ещё ждёт», а не «отправлено»; согласие записывается как
 * данное человеком на странице.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ query: vi.fn(), runPublicTool: vi.fn(), planRevisionOf: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => h.query(...a) } }));
vi.mock('@/app/api/mcp/route', () => ({
  runPublicTool: (...a: unknown[]) => h.runPublicTool(...a),
  planRevisionOf: (...a: unknown[]) => h.planRevisionOf(...a),
}));

import { createPendingRequest, readPendingRequest, claimPendingRequest, maskedPhone, confirmPageUrl, fromVedarPage } from '@/lib/mcp/pending-request';
import { sendPendingRequest, consentPurposesForTool } from '@/lib/mcp/pending-confirm';
import { POST as readRoute } from '@/app/api/requests/pending/route';
import { POST as sendRoute } from '@/app/api/requests/pending/send/route';
import { ConfirmClient, expiresAtLabel } from '@/app/confirm/_ConfirmClient';

const TOKEN = 'A'.repeat(32);
const BOOKED = 'Заявка оператору принята: "Мутновский вулкан", 2099-11-09. Это заявка, не оплата. Человеку дайте ссылку https://vedarai.ru/request-status#k1.';

beforeEach(() => {
  h.query.mockReset();
  h.runPublicTool.mockReset();
  h.planRevisionOf.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('хранилище отложенных заявок', () => {
  it('в базу — sha256 токена, не сам токен; ссылка — с токеном во фрагменте', async () => {
    h.query.mockResolvedValue({ rows: [] });
    const token = await createPendingRequest({ tool: 'create_lead', args: { name: 'Тест', phone: '+70000000000' }, draftText: 'черновик', consentPurposes: ['stay', 'operators'], planRevision: null, via: 'mcp' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const insert = h.query.mock.calls.find((c) => /INSERT INTO mcp_pending_requests/.test(String(c[0])))!;
    expect(insert[1][0]).toBe(createHash('sha256').update(token!).digest('hex'));
    expect(JSON.stringify(insert[1])).not.toContain(token);
    // Тексты согласия — те, что дал проход исполнителя, хранятся при заявке.
    expect(insert[1]).toContainEqual(['stay', 'operators']);
    // Просроченные заявки уносят ПД с собой — удаляются перед записью новой.
    expect(String(h.query.mock.calls[0]![0])).toMatch(/DELETE FROM mcp_pending_requests WHERE expires_at < NOW\(\)/);
    expect(confirmPageUrl(token!)).toBe(`https://vedarai.ru/confirm#${token}`);
  });

  it('база не ответила — токена нет (вызывающий не скажет «готово»)', async () => {
    h.query.mockRejectedValue(Object.assign(new Error('down'), { code: '57P01' }));
    expect(await createPendingRequest({ tool: 'create_lead', args: {}, draftText: 'ч', consentPurposes: [], planRevision: null, via: 'mcp' })).toBeNull();
  });

  it('забрать — один запрос, который отмечает отправку и стирает аргументы', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ tool: 'create_lead', args: { name: 'Тест' }, plan_revision: null, via: 'a2a' }] });
    const c = await claimPendingRequest(TOKEN);
    expect(c).toEqual({ kind: 'claimed', tool: 'create_lead', args: { name: 'Тест' }, planRevision: null, via: 'a2a' });
    const sql = String(h.query.mock.calls[0]![0]);
    expect(sql).toMatch(/SET sent_at = NOW\(\), args = '\{\}'::jsonb/);
    expect(sql).toMatch(/sent_at IS NULL AND expires_at > NOW\(\)/);
    h.query.mockResolvedValueOnce({ rows: [] });
    expect(await claimPendingRequest(TOKEN)).toEqual({ kind: 'gone' });
  });

  it('прочитать: отправленная — без данных, просроченная — «истекла», сбой — «не прочиталась»', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ tool: 'create_lead', args: {}, draft_text: 'ч', expires_at: new Date(), sent_at: new Date(), expired: false }] });
    expect(await readPendingRequest(TOKEN)).toEqual({ kind: 'sent' });
    h.query.mockResolvedValueOnce({ rows: [{ tool: 'create_lead', args: { name: 'Тест' }, draft_text: 'ч', expires_at: new Date(), sent_at: null, expired: true }] });
    expect(await readPendingRequest(TOKEN)).toEqual({ kind: 'expired' });
    h.query.mockRejectedValueOnce(new Error('down'));
    expect(await readPendingRequest(TOKEN)).toEqual({ kind: 'failed' });
  });

  it('телефон на странице — с замаскированными цифрами', () => {
    expect(maskedPhone('+79001234567')).toBe('+7 *** ***-45-67');
    expect(maskedPhone('+79001234567')).not.toMatch(/900|123/);
  });
});

describe('отправка человеком', () => {
  const claimed = (args: Record<string, unknown>, planRevision: string | null = null, via = 'mcp') =>
    h.query.mockResolvedValueOnce({ rows: [{ tool: 'create_booking_request', args, plan_revision: planRevision, via }] });

  it('уходит тем же исполнителем с согласием человека, не агента; вход заявки — откуда пришла', async () => {
    claimed({ tour: '36', date: '2099-11-09', participants: 2, name: 'Тест', phone: '+70000000000' }, null, 'a2a');
    h.runPublicTool.mockResolvedValue({ kind: 'ok', text: BOOKED, handoffUrl: null });
    const out = await sendPendingRequest(TOKEN, { ip: '10.1.1.1', consentIp: '10.1.1.1', userAgent: 'Mozilla' });
    expect(out).toMatchObject({ kind: 'sent', created: true });
    expect(h.runPublicTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'create_booking_request',
      rawArguments: expect.objectContaining({ consent: true, tour: '36' }),
      sentByHuman: { ip: '10.1.1.1' },
      via: 'a2a',
    }));
  });

  it('план поправили после черновика — отправки нет', async () => {
    claimed({ tour: '36', plan_id: 'p-1', name: 'Тест', phone: '+70000000000' }, 'r1');
    h.planRevisionOf.mockResolvedValue('r2');
    expect(await sendPendingRequest(TOKEN, { ip: '10.1.1.1', consentIp: '10.1.1.1', userAgent: '' })).toEqual({ kind: 'plan_changed' });
    expect(h.runPublicTool).not.toHaveBeenCalled();
  });

  it('лимит заявок с адреса — заявка возвращается в ожидание, человек нажмёт позже', async () => {
    claimed({ tour: '36', name: 'Тест', phone: '+70000000000' });
    h.runPublicTool.mockResolvedValue({ kind: 'rate_limited', text: 'Слишком много заявок' });
    h.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const out = await sendPendingRequest(TOKEN, { ip: '10.1.1.1', consentIp: '10.1.1.1', userAgent: '' });
    expect(out).toMatchObject({ kind: 'retry' });
    const release = h.query.mock.calls.at(-1)!;
    expect(String(release[0])).toMatch(/SET sent_at = NULL, args = \$2::jsonb/);
    expect(JSON.parse(String(release[1][1]))).toMatchObject({ tour: '36', phone: '+70000000000' });
  });

  it('сбой исполнителя — заявка в ожидание НЕ возвращается: дошла ли запись, неизвестно', async () => {
    claimed({ tour: '36', name: 'Тест', phone: '+70000000000' });
    h.runPublicTool.mockResolvedValue({ kind: 'failed', text: 'Инструмент сейчас не смог получить данные' });
    const out = await sendPendingRequest(TOKEN, { ip: '10.1.1.1', consentIp: '10.1.1.1', userAgent: '' });
    expect(out).toMatchObject({ kind: 'sent', created: false });
    expect(h.query.mock.calls.some((c) => /SET sent_at = NULL/.test(String(c[0])))).toBe(false);
  });

  it('адрес согласия — какой прислал прокси; не прислал — null, без выдуманного 127.0.0.1', async () => {
    claimed({ tour: '36', name: 'Тест', phone: '+70000000000' });
    h.runPublicTool.mockResolvedValue({ kind: 'ok', text: BOOKED, handoffUrl: null });
    await sendPendingRequest(TOKEN, { ip: '127.0.0.1', consentIp: null, userAgent: '' });
    expect(h.runPublicTool).toHaveBeenCalledWith(expect.objectContaining({ sentByHuman: { ip: null } }));
  });

  it('исполнитель упал после того, как заявка забрана, — «не могу подтвердить», а не «отправлено»', async () => {
    claimed({ tour: '36', name: 'Тест', phone: '+70000000000' });
    h.runPublicTool.mockRejectedValue(new Error('pool'));
    const out = await sendPendingRequest(TOKEN, { ip: '10.1.1.1', consentIp: '10.1.1.1', userAgent: '' });
    expect(out).toMatchObject({ kind: 'sent', created: false });
    expect(out.kind === 'sent' && out.text).toMatch(/Не могу подтвердить/);
  });
});

describe('тексты согласия — тех адресатов, кому уйдут данные', () => {
  it('у поездки целиком — по части', () => {
    expect(consentPurposesForTool('create_booking_request', {})).toEqual(['operator']);
    expect(consentPurposesForTool('create_lead', {})).toEqual(['operators']);
    expect(consentPurposesForTool('create_car_rental_request', {})).toEqual(['rental']);
    expect(consentPurposesForTool('create_trip_request', { tour: '36', stay: 'Кутха', transfer_destination: 'аэропорт', carrier: 'Шатун' }))
      .toEqual(['operator', 'stay', 'carrier']);
    expect(consentPurposesForTool('create_trip_request', { stay_wanted: true })).toEqual(['operators']);
  });
});

const PAGE = { origin: 'https://vedarai.ru', 'sec-fetch-site': 'same-origin' };
const post = (body: unknown, from: Record<string, string> = PAGE) => new NextRequest('http://localhost/api/requests/pending', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.2.2.2', ...from }, body: JSON.stringify(body),
});

describe('открыть и отправить — только из браузера со страницы Ведара', () => {
  it('Origin сайта и same-origin — да; без Origin, чужой сайт, cross-site — нет', () => {
    const hd = (o: Record<string, string>) => new Headers(o);
    expect(fromVedarPage(hd(PAGE))).toBe(true);
    // Старый браузер без Sec-Fetch-Site: судит Origin.
    expect(fromVedarPage(hd({ origin: 'https://vedarai.ru' }))).toBe(true);
    expect(fromVedarPage(hd({ origin: 'https://www.vedarai.ru.evil.example', host: 'vedarai.ru' }))).toBe(false);
    expect(fromVedarPage(hd({}))).toBe(false);
    expect(fromVedarPage(hd({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(fromVedarPage(hd({ origin: 'https://vedarai.ru', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(fromVedarPage(hd({ origin: 'null' }))).toBe(false);
  });

  it('серверный запрос агента без Origin — 403 на обоих роутах, база не тронута', async () => {
    expect((await readRoute(post({ token: TOKEN }, {}))).status).toBe(403);
    expect((await sendRoute(post({ token: TOKEN, pd_consent: true }, {}))).status).toBe(403);
    expect((await sendRoute(post({ token: TOKEN, pd_consent: true }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.runPublicTool).not.toHaveBeenCalled();
  });
});

describe('роуты страницы', () => {
  it('прочитать: телефон замаскирован, целиком в ответе его нет; комментарий — как уйдёт', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ tool: 'create_booking_request', args: { tour: '36', name: 'Тест', phone: '+79001234567', comment: 'с ребёнком 7 лет' }, draft_text: 'Черновик заявки', consent_purposes: [], expires_at: new Date(), sent_at: null, expired: false }] });
    const res = await readRoute(post({ token: TOKEN }));
    const j = await res.json();
    expect(j.data).toMatchObject({ state: 'pending', draft: 'Черновик заявки', name: 'Тест', phone: '+7 *** ***-45-67', comment: 'с ребёнком 7 лет', consent_purposes: ['operator'] });
    expect(JSON.stringify(j)).not.toContain('9001234567');
  });

  it('прочитать: тексты согласия — записанные при черновике, а не догадка по аргументам', async () => {
    // Жильё названо алиасом (accommodation): догадка по аргументам его не видит, проход исполнителя — видел.
    h.query.mockResolvedValueOnce({ rows: [{ tool: 'create_trip_request', args: { tour: '36', accommodation: 'Кутха', name: 'Тест', phone: '+79001234567' }, draft_text: 'ч', consent_purposes: ['operator', 'stay', 'bogus'], expires_at: new Date(), sent_at: null, expired: false }] });
    const j = await (await readRoute(post({ token: TOKEN }))).json();
    expect(j.data.consent_purposes).toEqual(['operator', 'stay']);
  });

  it('прочитать: база не ответила — 503, а не «ссылка недействительна»', async () => {
    h.query.mockRejectedValueOnce(new Error('down'));
    expect((await readRoute(post({ token: TOKEN }))).status).toBe(503);
  });

  it('отправить без галочки — 400, заявка не трогается', async () => {
    const res = await sendRoute(post({ token: TOKEN, pd_consent: false }));
    expect(res.status).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('отправить: второй раз — 410; сбой базы — 503', async () => {
    h.query.mockResolvedValueOnce({ rows: [] });
    expect((await sendRoute(post({ token: TOKEN, pd_consent: true }))).status).toBe(410);
    h.query.mockRejectedValueOnce(new Error('down'));
    expect((await sendRoute(post({ token: TOKEN, pd_consent: true }))).status).toBe(503);
  });
});

describe('страница /confirm', () => {
  it('черновик, имя и замаскированный телефон; «Отправить» — только с галочкой; исход — словами сервера', async () => {
    window.location.hash = `#${TOKEN}`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/requests/pending') {
        return new Response(JSON.stringify({ success: true, data: { state: 'pending', draft: 'Черновик заявки: тур «Мутновский вулкан»', name: 'Тест', phone: '+7 *** ***-45-67', consent_purposes: ['operator'], expires_at: new Date().toISOString() } }));
      }
      return new Response(JSON.stringify({ success: true, data: { created: true, text: 'Заявка создана.' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ConfirmClient />);
    await screen.findByText('Черновик заявки: тур «Мутновский вулкан»');
    expect(screen.getByText('+7 *** ***-45-67')).toBeTruthy();
    const button = screen.getByRole('button', { name: /Отправить/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('Заявка отправлена')).toBeTruthy());
    const sent = fetchMock.mock.calls.find((c) => c[0] === '/api/requests/pending/send')!;
    expect(JSON.parse(String((sent[1] as RequestInit).body))).toEqual({ token: TOKEN, pd_consent: true });
    vi.unstubAllGlobals();
  });

  it('комментарий виден; временный отказ — форма остаётся, нажать можно снова', async () => {
    window.location.hash = `#${TOKEN}`;
    let sends = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/requests/pending') {
        return new Response(JSON.stringify({ success: true, data: { state: 'pending', draft: 'Черновик', name: 'Тест', phone: '+7 *** ***-45-67', comment: 'с ребёнком 7 лет', consent_purposes: ['operator'], expires_at: new Date().toISOString() } }));
      }
      sends += 1;
      return sends === 1
        ? new Response(JSON.stringify({ success: false, error: 'Слишком много заявок с этого адреса за час — эта заявка не отправлена, но ещё ждёт.' }), { status: 503 })
        : new Response(JSON.stringify({ success: true, data: { created: true, text: 'Заявка создана.' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ConfirmClient />);
    await screen.findByText('с ребёнком 7 лет');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Отправить/ }));
    await screen.findByText(/ещё ждёт/);
    expect(screen.queryByText('Заявка не отправлена')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Отправить/ }));
    await waitFor(() => expect(screen.getByText('Заявка отправлена')).toBeTruthy());
    vi.unstubAllGlobals();
  });

  it('на телефоне понятно, почему кнопка не жмётся и до какого времени ссылка; после отправки фокус — на итоге (проход 25.11)', async () => {
    window.location.hash = `#${TOKEN}`;
    const expires = new Date(Date.now() + 60 * 60_000).toISOString();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/requests/pending') {
        return new Response(JSON.stringify({ success: true, data: { state: 'pending', draft: 'Черновик', name: 'Тест', phone: '+7 *** ***-45-67', consent_purposes: ['operator'], expires_at: expires } }));
      }
      return new Response(JSON.stringify({ success: true, data: { created: true, text: 'Заявка создана.' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ConfirmClient />);
    await screen.findByText('Черновик');
    const button = screen.getByRole('button', { name: /Отправить/ });
    const hint = screen.getByText('Отметьте согласие выше, чтобы отправить.');
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);
    expect(screen.getByText(new RegExp(`Ссылка действует до ${expiresAtLabel(expires)!}`))).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByText('Отметьте согласие выше, чтобы отправить.')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(button);
    await screen.findByText('Заявка отправлена');
    // Фокус ставит эффект после отрисовки (useEffect в _ConfirmClient): текст
    // в документе раньше, чем фокус на итоге. Проверка сразу после текста
    // гонялась с эффектом и под нагрузкой падала — CI на main 26.11 (#3852).
    // Ждём сам фокус; не перейдёт вовсе — waitFor падает по сроку.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Заявка отправлена').closest('section')));
    vi.unstubAllGlobals();
  });

  it('время ссылки: «ЧЧ:ММ»; дата не разобралась — строки нет', () => {
    expect(expiresAtLabel('2099-01-01T10:05:00Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(expiresAtLabel('')).toBeNull();
    expect(expiresAtLabel('не дата')).toBeNull();
  });

  it('неполная ссылка — объяснение, а не запрос к серверу', async () => {
    window.location.hash = '#abc';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ConfirmClient />);
    await screen.findByText(/Ссылка неполная/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
