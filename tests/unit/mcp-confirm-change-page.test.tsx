// @vitest-environment jsdom
/**
 * Отмена и перенос заявки, подготовленные ИИ-агентом (change_request), — только
 * нажатием человека на /confirm/change (слово владельца 20.11 «1 для всех
 * агентов», #3573: каталог плагинов Алисы не допускает изменения заявки внутри
 * чата).
 *
 * Судится вызовом роутов и рендером страницы; база подменена, правило отмены —
 * подменённый applyPendingChange (его исполнение — tests/unit/mcp-change-request
 * и сцена на настоящей базе в tests/integration/request-chat.pg.test.ts).
 *
 * Что держится:
 *   - черновик изменения забирает только своя дверь, а дверь заявки — нет;
 *   - чтение черновика изменения не отдаёт ни имени, ни телефона, ни согласия;
 *   - подтверждение — один раз; сбой до записи возвращает черновик в ожидание,
 *     после записи — «не могу подтвердить», а не «изменено»;
 *   - страница называет исход словами сервера: изменена / просьба передана / не изменена.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ query: vi.fn(), apply: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => h.query(...a) } }));
vi.mock('@/lib/mcp/change-request', () => ({ applyPendingChange: (...a: unknown[]) => h.apply(...a) }));

import { claimPendingRequest, PENDING_CHANGE_TOOL, confirmChangePageUrl } from '@/lib/mcp/pending-request';
import { POST as readRoute } from '@/app/api/requests/pending/route';
import { POST as changeRoute } from '@/app/api/requests/pending/change/route';
import { ChangeConfirmClient } from '@/app/confirm/change/_ChangeConfirmClient';

const TOKEN = 'C'.repeat(32);
const PAGE = { origin: 'https://vedarai.ru', 'sec-fetch-site': 'same-origin' };
const post = (body: unknown, from: Record<string, string> = PAGE) => new NextRequest('http://localhost/api/requests/pending/change', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.3.3.3', ...from }, body: JSON.stringify(body),
});
const CLAIMED = { rows: [{ tool: PENDING_CHANGE_TOOL, args: { key_hash: 'a'.repeat(64), action: 'cancel' }, plan_revision: null, via: 'a2a' }] };

beforeEach(() => {
  h.query.mockReset();
  h.apply.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('хранилище: черновик изменения — своей двери', () => {
  it('дверь заявки и дверь изменения различает сам запрос; ссылка — /confirm/change с токеном во фрагменте', async () => {
    h.query.mockResolvedValue({ rows: [] });
    await claimPendingRequest(TOKEN);
    await claimPendingRequest(TOKEN, 'change');
    const [req, chg] = h.query.mock.calls as Array<[string, unknown[]]>;
    expect(req[0]).toMatch(/AND \(tool = \$3\) = \$2::boolean/);
    expect(req[1].slice(1)).toEqual([false, PENDING_CHANGE_TOOL]);
    expect(chg[1].slice(1)).toEqual([true, PENDING_CHANGE_TOOL]);
    expect(confirmChangePageUrl(TOKEN)).toBe(`https://vedarai.ru/confirm/change#${TOKEN}`);
  });
});

describe('роуты', () => {
  it('прочитать черновик изменения: слова, срок — и ни имени, ни телефона, ни согласия', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ tool: PENDING_CHANGE_TOOL, args: { key_hash: 'a'.repeat(64), action: 'cancel' }, draft_text: 'Отменить заявку. После подтверждения: …', consent_purposes: [], expires_at: new Date(), sent_at: null, expired: false }] });
    const j = await (await readRoute(post({ token: TOKEN }))).json();
    expect(j.data).toMatchObject({ state: 'pending', kind: 'change', draft: 'Отменить заявку. После подтверждения: …' });
    expect(Object.keys(j.data).sort()).toEqual(['draft', 'expires_at', 'kind', 'state']);
  });

  it('без Origin сайта — 403; неполная ссылка — 400; база не тронута', async () => {
    expect((await changeRoute(post({ token: TOKEN }, {}))).status).toBe(403);
    expect((await changeRoute(post({ token: 'abc' }))).status).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('подтвердить: забирается своей дверью и исполняется с дверью агента; исход — словами', async () => {
    h.query.mockResolvedValueOnce(CLAIMED);
    h.apply.mockResolvedValueOnce({ kind: 'done', result: { changed: true, outcome: 'cancelled', human: 'Заявка отменена: тур «Мутновский». Оператору ушло сообщение.' } });
    const res = await changeRoute(post({ token: TOKEN }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ changed: true, outcome: 'cancelled', text: 'Заявка отменена: тур «Мутновский». Оператору ушло сообщение.' });
    expect((h.query.mock.calls[0] as [string, unknown[]])[1].slice(1)).toEqual([true, PENDING_CHANGE_TOOL]);
    expect(h.apply).toHaveBeenCalledWith(CLAIMED.rows[0]!.args, 'a2a');
  });

  it('второй раз или истекла — 410; сбой базы при заборе — 503', async () => {
    h.query.mockResolvedValueOnce({ rows: [] });
    expect((await changeRoute(post({ token: TOKEN }))).status).toBe(410);
    h.query.mockRejectedValueOnce(new Error('down'));
    expect((await changeRoute(post({ token: TOKEN }))).status).toBe(503);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('изменить нельзя (ключ истёк, заявку закрыли) — 200 с объяснением, «не изменена»', async () => {
    h.query.mockResolvedValueOnce(CLAIMED);
    h.apply.mockResolvedValueOnce({ kind: 'refused', text: 'Ключ не найден или истёк.' });
    expect((await (await changeRoute(post({ token: TOKEN }))).json()).data).toEqual({ changed: false, text: 'Ключ не найден или истёк.' });
  });

  it('сбой до записи — черновик снова ждёт (503); после записи — «не могу подтвердить», не «изменено»', async () => {
    h.query.mockResolvedValueOnce(CLAIMED).mockResolvedValueOnce({ rowCount: 1 });
    h.apply.mockResolvedValueOnce({ kind: 'failed', beforeWrite: true });
    const retry = await changeRoute(post({ token: TOKEN }));
    expect(retry.status).toBe(503);
    expect(String((h.query.mock.calls[1] as [string])[0])).toMatch(/UPDATE mcp_pending_requests SET sent_at = NULL/);
    h.query.mockReset().mockResolvedValueOnce(CLAIMED);
    h.apply.mockResolvedValueOnce({ kind: 'failed', beforeWrite: false });
    const unknown = await changeRoute(post({ token: TOKEN }));
    expect(unknown.status).toBe(200);
    const j = await unknown.json();
    expect(j.data.changed).toBe(false);
    expect(j.data.text).toMatch(/Не удалось подтвердить, изменилась ли заявка/);
    // В ожидание после записи не возвращаем: второе нажатие могло бы задвоить.
    expect(h.query).toHaveBeenCalledTimes(1);
  });
});

describe('страница /confirm/change', () => {
  const page = (send: (n: number) => Response) => {
    let n = 0;
    return vi.fn(async (url: string) => {
      if (url === '/api/requests/pending') {
        return new Response(JSON.stringify({ success: true, data: { state: 'pending', kind: 'change', draft: 'Отменить заявку. После подтверждения: оператор ещё не ответил — она отменится сразу.', expires_at: new Date().toISOString() } }));
      }
      n += 1;
      return send(n);
    });
  };

  it('что произойдёт — словами; без галочки согласия; «Подтвердить» шлёт токен; итог — «Заявка изменена»', async () => {
    window.location.hash = `#${TOKEN}`;
    const fetchMock = page(() => new Response(JSON.stringify({ success: true, data: { changed: true, outcome: 'cancelled', text: 'Заявка отменена.' } })));
    vi.stubGlobal('fetch', fetchMock);
    render(<ChangeConfirmClient />);
    await screen.findByText(/^Отменить заявку\. После подтверждения/);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/Заявка — не бронь/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(screen.getByText('Заявка изменена')).toBeTruthy());
    expect(screen.getByText('Заявка отменена.')).toBeTruthy();
    const sent = fetchMock.mock.calls.find((c) => c[0] === '/api/requests/pending/change')!;
    expect(JSON.parse(String((sent[1] as RequestInit).body))).toEqual({ token: TOKEN });
    vi.unstubAllGlobals();
  });

  it('просьба оператору — «Просьба передана», не «изменена» и не «не вышло»; отказ — «Заявка не изменена»', async () => {
    window.location.hash = `#${TOKEN}`;
    vi.stubGlobal('fetch', page(() => new Response(JSON.stringify({ success: true, data: { changed: false, outcome: 'cancel_requested', text: 'Оператор уже ответил — просьба ему отправлена.' } }))));
    render(<ChangeConfirmClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(screen.getByText('Просьба передана')).toBeTruthy());
    expect(screen.queryByText('Заявка изменена')).toBeNull();
    cleanup();
    vi.stubGlobal('fetch', page(() => new Response(JSON.stringify({ success: true, data: { changed: false, text: 'Ключ не найден или истёк.' } }))));
    render(<ChangeConfirmClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(screen.getByText('Заявка не изменена')).toBeTruthy());
    vi.unstubAllGlobals();
  });

  it('временный сбой — кнопка остаётся, нажать можно снова', async () => {
    window.location.hash = `#${TOKEN}`;
    vi.stubGlobal('fetch', page((n) => (n === 1
      ? new Response(JSON.stringify({ success: false, error: 'Не удалось подтвердить: база Ведара не ответила.' }), { status: 503 })
      : new Response(JSON.stringify({ success: true, data: { changed: true, outcome: 'date_changed', text: 'Дата изменена.' } })))));
    render(<ChangeConfirmClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    await screen.findByText(/база Ведара не ответила/);
    expect(screen.queryByText('Заявка не изменена')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(screen.getByText('Заявка изменена')).toBeTruthy());
    vi.unstubAllGlobals();
  });
});

describe('ссылка не на ту страницу — подсказка с верной, без отправки', () => {
  it('/confirm с токеном изменения — ссылка на /confirm/change; формы заявки и согласия нет', async () => {
    const { ConfirmClient } = await import('@/app/confirm/_ConfirmClient');
    window.location.hash = `#${TOKEN}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { state: 'pending', kind: 'change', draft: 'Отменить заявку.', expires_at: new Date().toISOString() } })));
    vi.stubGlobal('fetch', fetchMock);
    render(<ConfirmClient />);
    const link = await screen.findByRole('link', { name: 'Открыть страницу подтверждения изменения' });
    expect(link.getAttribute('href')).toBe(`/confirm/change#${TOKEN}`);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Отправить/ })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('/confirm/change с токеном заявки — ссылка на /confirm; кнопки «Подтвердить» нет', async () => {
    window.location.hash = `#${TOKEN}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { state: 'pending', draft: 'Черновик заявки', name: 'Тест', phone: '+7 *** ***-45-67', consent_purposes: ['operator'] } }))));
    render(<ChangeConfirmClient />);
    const link = await screen.findByRole('link', { name: 'Открыть страницу отправки заявки' });
    expect(link.getAttribute('href')).toBe(`/confirm#${TOKEN}`);
    expect(screen.queryByRole('button', { name: 'Подтвердить' })).toBeNull();
    // Имя и телефон заявки здесь не показываются.
    expect(screen.queryByText('Тест')).toBeNull();
    vi.unstubAllGlobals();
  });
});
