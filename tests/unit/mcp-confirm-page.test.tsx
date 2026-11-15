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

import { createPendingRequest, readPendingRequest, claimPendingRequest, maskedPhone, confirmPageUrl } from '@/lib/mcp/pending-request';
import { sendPendingRequest, consentPurposesForTool } from '@/lib/mcp/pending-confirm';
import { POST as readRoute } from '@/app/api/requests/pending/route';
import { POST as sendRoute } from '@/app/api/requests/pending/send/route';
import { ConfirmClient } from '@/app/confirm/_ConfirmClient';

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
    const token = await createPendingRequest({ tool: 'create_lead', args: { name: 'Тест', phone: '+70000000000' }, draftText: 'черновик', planRevision: null, via: 'mcp' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const insert = h.query.mock.calls.find((c) => /INSERT INTO mcp_pending_requests/.test(String(c[0])))!;
    expect(insert[1][0]).toBe(createHash('sha256').update(token!).digest('hex'));
    expect(JSON.stringify(insert[1])).not.toContain(token);
    // Просроченные заявки уносят ПД с собой — удаляются перед записью новой.
    expect(String(h.query.mock.calls[0]![0])).toMatch(/DELETE FROM mcp_pending_requests WHERE expires_at < NOW\(\)/);
    expect(confirmPageUrl(token!)).toBe(`https://vedarai.ru/confirm#${token}`);
  });

  it('база не ответила — токена нет (вызывающий не скажет «готово»)', async () => {
    h.query.mockRejectedValue(Object.assign(new Error('down'), { code: '57P01' }));
    expect(await createPendingRequest({ tool: 'create_lead', args: {}, draftText: 'ч', planRevision: null, via: 'mcp' })).toBeNull();
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
    const out = await sendPendingRequest(TOKEN, { ip: '10.1.1.1', userAgent: 'Mozilla' });
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
    expect(await sendPendingRequest(TOKEN, { ip: '10.1.1.1', userAgent: '' })).toEqual({ kind: 'plan_changed' });
    expect(h.runPublicTool).not.toHaveBeenCalled();
  });

  it('лимит заявок с адреса или сбой исполнителя до записи — заявка возвращается в ожидание, человек нажмёт позже', async () => {
    claimed({ tour: '36', name: 'Тест', phone: '+70000000000' });
    h.runPublicTool.mockResolvedValue({ kind: 'rate_limited', text: 'Слишком много заявок' });
    h.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const out = await sendPendingRequest(TOKEN, { ip: '10.1.1.1', userAgent: '' });
    expect(out).toMatchObject({ kind: 'retry' });
    const release = h.query.mock.calls.at(-1)!;
    expect(String(release[0])).toMatch(/SET sent_at = NULL, args = \$2::jsonb/);
    expect(JSON.parse(String(release[1][1]))).toMatchObject({ tour: '36', phone: '+70000000000' });
  });

  it('исполнитель упал после того, как заявка забрана, — «не могу подтвердить», а не «отправлено»', async () => {
    claimed({ tour: '36', name: 'Тест', phone: '+70000000000' });
    h.runPublicTool.mockRejectedValue(new Error('pool'));
    const out = await sendPendingRequest(TOKEN, { ip: '10.1.1.1', userAgent: '' });
    expect(out).toMatchObject({ kind: 'sent', created: false });
    expect(out.kind === 'sent' && out.text).toMatch(/Не могу подтвердить/);
  });
});

describe('тексты согласия — тех адресатов, кому уйдут данные', () => {
  it('у поездки целиком — по части', () => {
    expect(consentPurposesForTool('create_booking_request', {})).toEqual(['operator']);
    expect(consentPurposesForTool('create_lead', {})).toEqual(['operators']);
    expect(consentPurposesForTool('create_trip_request', { tour: '36', stay: 'Кутха', transfer_destination: 'аэропорт', carrier: 'Шатун' }))
      .toEqual(['operator', 'stay', 'carrier']);
    expect(consentPurposesForTool('create_trip_request', { stay_wanted: true })).toEqual(['operators']);
  });
});

const post = (body: unknown) => new NextRequest('http://localhost/api/requests/pending', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.2.2.2' }, body: JSON.stringify(body),
});

describe('роуты страницы', () => {
  it('прочитать: телефон замаскирован, целиком в ответе его нет', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ tool: 'create_booking_request', args: { tour: '36', name: 'Тест', phone: '+79001234567' }, draft_text: 'Черновик заявки', expires_at: new Date(), sent_at: null, expired: false }] });
    const res = await readRoute(post({ token: TOKEN }));
    const j = await res.json();
    expect(j.data).toMatchObject({ state: 'pending', draft: 'Черновик заявки', name: 'Тест', phone: '+7 *** ***-45-67', consent_purposes: ['operator'] });
    expect(JSON.stringify(j)).not.toContain('9001234567');
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
