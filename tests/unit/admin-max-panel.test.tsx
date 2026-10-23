// @vitest-environment jsdom
/**
 * «MAX администратора» на обзоре админки (слово владельца 23.10, «1а») —
 * рендером: состояние подключения, ссылка после нажатия, отключение с
 * подтверждением. Непрочитанное состояние — «не загрузилось», а не «не
 * подключён» (§4.0). Роут и SQL — tests/unit/admin-max-chat.test.ts и
 * tests/integration/max-login-confirm.pg.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Reply = { status?: number; body: unknown };

/** fetch по методу: GET / POST / DELETE — свои ответы по очереди. */
function stub(replies: Partial<Record<'GET' | 'POST' | 'DELETE', Reply[]>>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
    const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE';
    calls.push(method);
    const next = replies[method]?.shift() ?? { status: 500, body: { success: false } };
    const status = next.status ?? 200;
    return { ok: status < 400, status, json: async () => next.body };
  }));
  return calls;
}

async function show() {
  const { default: Panel } = await import('@/app/hub/admin/_AdminMaxLink');
  render(React.createElement(Panel));
  return within(screen.getByRole('region', { name: 'MAX администратора' }));
}

const LINK = 'https://max.ru/vedar_bot?start=adm_AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('обзор админки — MAX администратора', () => {
  it('не подключён → ссылка на 10 минут, открывается и копируется', async () => {
    stub({
      GET: [{ body: { success: true, data: { bound: false, bound_at: null } } }],
      POST: [{ body: { success: true, data: { link: LINK, expires_at: '2026-10-23T10:10:00.000Z' } } }],
    });
    const panel = await show();
    expect(await panel.findByText('не подключён')).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Подключить MAX администратора' }));
    const a = await panel.findByRole('link', { name: LINK });
    expect(a.getAttribute('href')).toBe(LINK);
    expect(a.getAttribute('rel')).toContain('noopener');
    // 10:10 UTC — 22:10 по Камчатке.
    expect(panel.getByText(/действует до 22:10 по Камчатке/)).toBeTruthy();
    expect(panel.getByText(/Никому её не пересылайте/)).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Скопировать ссылку' })).toBeTruthy();
  });

  it('подключён → дата подключения, «Отключить» спрашивает и отключает', async () => {
    const calls = stub({
      GET: [{ body: { success: true, data: { bound: true, bound_at: '2026-10-23T09:00:00.000Z' } } }],
      DELETE: [{ body: { success: true, data: { unbound: true } } }],
    });
    const panel = await show();
    expect(await panel.findByText('подключён 23 октября в 21:00')).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Подключить заново' })).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Отключить' }));
    expect(calls).not.toContain('DELETE');
    fireEvent.click(panel.getByRole('button', { name: 'Да, отключить' }));
    expect(await panel.findByText('не подключён')).toBeTruthy();
    expect(calls).toContain('DELETE');
  });

  it('отключение не удалось — остаётся «подключён», сказано «не отключено», повтор на месте', async () => {
    stub({
      GET: [{ body: { success: true, data: { bound: true, bound_at: '2026-10-23T09:00:00.000Z' } } }],
      DELETE: [
        { status: 500, body: { success: false, error: 'База не ответила, попробуйте позже' } },
        { body: { success: true, data: { unbound: true } } },
      ],
    });
    const panel = await show();
    await panel.findByText('подключён 23 октября в 21:00');
    fireEvent.click(panel.getByRole('button', { name: 'Отключить' }));
    fireEvent.click(panel.getByRole('button', { name: 'Да, отключить' }));
    expect((await panel.findByRole('alert')).textContent).toContain('Не отключено: База не ответила');
    expect(panel.getByText('подключён 23 октября в 21:00')).toBeTruthy();
    expect(panel.queryByText(/не загрузилось/)).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Да, отключить' }));
    expect(await panel.findByText('не подключён')).toBeTruthy();
  });

  it('дату, которую браузер не разобрал, не показывает как «Invalid Date»', async () => {
    stub({ GET: [{ body: { success: true, data: { bound: true, bound_at: 'не дата' } } }] });
    const panel = await show();
    expect(await panel.findByText('подключён')).toBeTruthy();
    expect(panel.queryByText(/Invalid/)).toBeNull();
  });

  it('состояние не прочиталось — «не загрузилось», а не «не подключён»', async () => {
    stub({ GET: [{ status: 500, body: { success: false, error: 'База не ответила, попробуйте позже' } }] });
    const panel = await show();
    expect(await panel.findByText(/не загрузилось: База не ответила/)).toBeTruthy();
    expect(panel.queryByText('не подключён')).toBeNull();
  });

  it('ссылку не выдали — причина словами, ссылки нет', async () => {
    stub({
      GET: [{ body: { success: true, data: { bound: false, bound_at: null } } }],
      POST: [{ status: 403, body: { success: false, error: 'У аккаунта больше нет роли администратора' } }],
    });
    const panel = await show();
    await panel.findByText('не подключён');
    fireEvent.click(panel.getByRole('button', { name: 'Подключить MAX администратора' }));
    expect(await panel.findByRole('alert')).toBeTruthy();
    expect(panel.getByText('У аккаунта больше нет роли администратора')).toBeTruthy();
    expect(panel.queryByRole('link')).toBeNull();
  });
});
