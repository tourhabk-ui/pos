// @vitest-environment jsdom
/**
 * «Мессенджеры администратора» на обзоре админки — рендером.
 *
 * MAX (слово владельца 23.10, «1а») и Telegram (24.10: «нет привязки админа
 * к Telegram») — один блок, две кнопки, два статуса. Непрочитанное —
 * «не загрузилось», а не «не подключён» (§4.0), и у каждого мессенджера
 * отдельно. Имя бота Telegram, которое не подтвердил getMe, так и сказано.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Reply = { status?: number; body: unknown };
type Method = 'GET' | 'POST' | 'DELETE';

/** fetch по адресу и методу. Незаданный GET — «не подключён», чтобы второй ряд не врал отказом. */
function stub(replies: { max?: Partial<Record<Method, Reply[]>>; telegram?: Partial<Record<Method, Reply[]>> }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    const method = (init?.method ?? 'GET') as Method;
    const which = String(url).includes('telegram-link') ? 'telegram' : 'max';
    calls.push(`${which} ${method}`);
    const next = replies[which]?.[method]?.shift()
      ?? (method === 'GET'
        ? { status: 200, body: { success: true, data: { bound: false, bound_at: null } } }
        : { status: 500, body: { success: false, error: 'нет ответа' } });
    const status = next.status ?? 200;
    return { ok: status < 400, status, json: async () => next.body };
  }));
  return calls;
}

async function show() {
  const { default: Panel } = await import('@/app/hub/admin/_AdminMessengers');
  render(React.createElement(Panel));
  const region = within(screen.getByRole('region', { name: 'Мессенджеры администратора' }));
  return {
    region,
    max: within(region.getByRole('group', { name: 'MAX' })),
    telegram: within(region.getByRole('group', { name: 'Telegram' })),
  };
}

const LINK = 'https://max.ru/vedar_bot?start=adm_AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const TG_LINK = 'https://t.me/kuzmichai_bot?start=adt_AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('обзор админки — мессенджеры администратора', () => {
  it('MAX не подключён → ссылка на 10 минут, открывается и копируется', async () => {
    stub({
      max: {
        GET: [{ body: { success: true, data: { bound: false, bound_at: null } } }],
        POST: [{ body: { success: true, data: { link: LINK, expires_at: '2026-10-23T10:10:00.000Z' } } }],
      },
    });
    const { max: panel } = await show();
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

  it('MAX подключён → дата подключения, «Отключить» спрашивает и отключает', async () => {
    const calls = stub({
      max: {
        GET: [{ body: { success: true, data: { bound: true, bound_at: '2026-10-23T09:00:00.000Z' } } }],
        DELETE: [{ body: { success: true, data: { unbound: true } } }],
      },
    });
    const { max: panel } = await show();
    expect(await panel.findByText('подключён 23 октября в 21:00')).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Подключить заново' })).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Отключить' }));
    expect(calls).not.toContain('max DELETE');
    fireEvent.click(panel.getByRole('button', { name: 'Да, отключить' }));
    expect(await panel.findByText('не подключён')).toBeTruthy();
    expect(calls).toContain('max DELETE');
  });

  it('отключение MAX не удалось — остаётся «подключён», сказано «не отключено», повтор на месте', async () => {
    stub({
      max: {
        GET: [{ body: { success: true, data: { bound: true, bound_at: '2026-10-23T09:00:00.000Z' } } }],
        DELETE: [
          { status: 500, body: { success: false, error: 'База не ответила, попробуйте позже' } },
          { body: { success: true, data: { unbound: true } } },
        ],
      },
    });
    const { max: panel } = await show();
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
    stub({ max: { GET: [{ body: { success: true, data: { bound: true, bound_at: 'не дата' } } }] } });
    const { max: panel } = await show();
    expect(await panel.findByText('подключён')).toBeTruthy();
    expect(panel.queryByText(/Invalid/)).toBeNull();
  });

  it('состояние MAX не прочиталось — «не загрузилось», а не «не подключён»; Telegram при этом свой', async () => {
    stub({
      max: { GET: [{ status: 500, body: { success: false, error: 'База не ответила, попробуйте позже' } }] },
      telegram: { GET: [{ body: { success: true, data: { bound: false, bound_at: null } } }] },
    });
    const { max: panel, telegram } = await show();
    expect(await panel.findByText(/не загрузилось: База не ответила/)).toBeTruthy();
    expect(panel.queryByText('не подключён')).toBeNull();
    expect(await telegram.findByText('не подключён')).toBeTruthy();
    expect(telegram.queryByText(/не загрузилось/)).toBeNull();
  });

  it('ссылку MAX не выдали — причина словами, ссылки нет', async () => {
    stub({
      max: {
        GET: [{ body: { success: true, data: { bound: false, bound_at: null } } }],
        POST: [{ status: 403, body: { success: false, error: 'У аккаунта больше нет роли администратора' } }],
      },
    });
    const { max: panel } = await show();
    await panel.findByText('не подключён');
    fireEvent.click(panel.getByRole('button', { name: 'Подключить MAX администратора' }));
    expect(await panel.findByRole('alert')).toBeTruthy();
    expect(panel.getByText('У аккаунта больше нет роли администратора')).toBeTruthy();
    expect(panel.queryByRole('link')).toBeNull();
  });

  it('Telegram: ссылка adt_, а имя бота без getMe названо непроверенным', async () => {
    const calls = stub({
      telegram: {
        GET: [{ body: { success: true, data: { bound: false, bound_at: null } } }],
        POST: [{ body: { success: true, data: {
          link: TG_LINK,
          expires_at: '2026-10-23T10:10:00.000Z',
          bot_source: 'env',
          bot_reason: 'getMe не ответил',
        } } }],
      },
    });
    const { telegram } = await show();
    fireEvent.click(await telegram.findByRole('button', { name: 'Подключить Telegram администратора' }));
    const a = await telegram.findByRole('link', { name: TG_LINK });
    expect(a.getAttribute('href')).toBe(TG_LINK);
    expect(telegram.getByText(/Имя бота не проверено у Telegram: getMe не ответил/)).toBeTruthy();
    expect(calls).toContain('telegram POST');
    expect(calls.some((c) => c.startsWith('max '))).toBe(true);
  });

  it('Telegram подключён отдельно от MAX', async () => {
    stub({
      max: { GET: [{ body: { success: true, data: { bound: false, bound_at: null } } }] },
      telegram: { GET: [{ body: { success: true, data: { bound: true, bound_at: '2026-10-23T09:00:00.000Z' } } }] },
    });
    const { max, telegram } = await show();
    expect(await telegram.findByText('подключён 23 октября в 21:00')).toBeTruthy();
    expect(await max.findByText('не подключён')).toBeTruthy();
    expect(telegram.getByRole('button', { name: 'Подключить заново' })).toBeTruthy();
  });
});
