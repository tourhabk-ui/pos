// @vitest-environment jsdom
/**
 * Отчёт очередей партнёрского контура у администратора (план готовности
 * 23.11, этап 6).
 *
 * Этапы 3–5 завели очереди: заявка ждёт одобрения, одобренного нельзя
 * поставить на витрину без канала, тур ждёт проверки, оферта не принята.
 * Отчёт называет их числами — без названий и контактов.
 *
 * Здесь — слова и экран: что видит администратор в каждом исходе чтения.
 * Числа на настоящей базе — tests/integration/request-cycle.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';

const h = vi.hoisted(() => ({ admin: vi.fn(), read: vi.fn() }));

vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: h.admin }));
vi.mock('@/lib/admin/partner-queues', () => ({ readPartnerQueues: h.read }));
vi.mock('@/components/auth/Protected', () => ({ Protected: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/admin/TildaPanel', () => ({ default: () => null }));

import { PartnerQueuesReport } from '@/components/admin/PartnerQueuesReport';
import { queueLines, type PartnerQueues } from '@/lib/admin/partner-queue-lines';

const QUIET: PartnerQueues = {
  awaitingApproval: { total: 0, byCategory: [] },
  storefrontNoChannel: 0, approvedNoChannel: 0, testProfiles: 0,
  tourEdits: { newTours: 0, edits: 0 }, offerNotAccepted: 0,
};
const BUSY: PartnerQueues = {
  awaitingApproval: { total: 5, byCategory: [{ category: 'guide', count: 2 }, { category: 'operator', count: 3 }] },
  storefrontNoChannel: 1, approvedNoChannel: 4, testProfiles: 2,
  tourEdits: { newTours: 6, edits: 7 }, offerNotAccepted: 9,
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  h.admin.mockReset();
  h.read.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const line = (key: string) => document.querySelector(`[data-key="${key}"]`) as HTMLElement;

describe('слова отчёта', () => {
  const byKey = (q: PartnerQueues) => Object.fromEntries(queueLines(q).map((l) => [l.key, l]));

  it('семь строк в одном порядке: сначала то, что ждёт администратора', () => {
    expect(queueLines(BUSY).map((l) => l.key)).toEqual([
      'awaiting', 'storefront_no_channel', 'approved_no_channel', 'tour_new', 'tour_edits', 'offer', 'test',
    ]);
    expect(queueLines(BUSY).map((l) => l.value)).toEqual(['5', '1', '4', '6', '7', '9', '2']);
  });

  it('заявки на одобрении названы по ролям словами', () => {
    expect(byKey(BUSY).awaiting.hint).toBe('По ролям: гиды — 2, операторы — 3.');
    expect(byKey(QUIET).awaiting.hint).toBe('Заявки партнёров на проверке.');
    // Роль, которой в словаре нет, не теряется.
    const odd = { ...BUSY, awaitingApproval: { total: 1, byCategory: [{ category: 'new_role', count: 1 }] } };
    expect(byKey(odd).awaiting.hint).toBe('По ролям: new_role — 1.');
  });

  it('ноль — спокойно; число — внимание; «не прочитано» — отдельный тон, не ноль', () => {
    for (const l of queueLines(QUIET)) expect(l.tone, l.key).toBe('calm');
    const busy = byKey(BUSY);
    for (const key of ['awaiting', 'storefront_no_channel', 'approved_no_channel', 'tour_new', 'tour_edits']) {
      expect(busy[key].tone, key).toBe('attention');
    }
    const unknown = byKey({
      awaitingApproval: { total: 'unknown', byCategory: [] }, storefrontNoChannel: 'unknown', approvedNoChannel: 'unknown',
      testProfiles: 'unknown', tourEdits: { newTours: 'unknown', edits: 'unknown' }, offerNotAccepted: 'unknown',
    });
    for (const l of Object.values(unknown)) {
      expect(l.value, l.key).toBe('не прочитано');
      expect(l.tone, l.key).toBe('unknown');
    }
  });

  it('оферта без отметки и тестовые профили тревогой не красятся: работе они не мешают', () => {
    const busy = byKey(BUSY);
    expect(busy.offer.tone).toBe('calm');
    expect(busy.test.tone).toBe('calm');
    expect(busy.offer.hint).toContain('Работе не мешает');
  });

  it('на проверку туров ведёт ссылка в модерацию; у остальных строк ссылки нет', () => {
    const lines = byKey(BUSY);
    expect(lines.tour_new.href).toBe('/hub/admin/moderation');
    expect(lines.tour_edits.href).toBe('/hub/admin/moderation');
    for (const key of ['awaiting', 'storefront_no_channel', 'approved_no_channel', 'offer', 'test']) {
      expect(lines[key].href, key).toBeUndefined();
    }
  });

  it('в словах нет обещаний и условий: ни сроков, ни ставок, ни выплат', () => {
    for (const q of [QUIET, BUSY]) {
      for (const l of queueLines(q)) {
        expect(`${l.label} ${l.hint}`, l.key).not.toMatch(/комисси|тариф|выплат|бесплатн|в течение|рабочих дн|час(а|ов)\b/i);
      }
    }
  });
});

describe('блок «Очереди партнёров»', () => {
  it('числа прочитаны: каждая строка — подпись, число и что оно значит', async () => {
    fetchMock.mockResolvedValue(answer(200, { success: true, data: BUSY }));
    render(<PartnerQueuesReport />);
    await waitFor(() => expect(line('awaiting')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/partners/queues');
    expect(screen.getByRole('heading', { name: 'Очереди партнёров' })).toBeTruthy();

    const awaiting = within(line('awaiting'));
    expect(awaiting.getByText('Ждут одобрения')).toBeTruthy();
    expect(awaiting.getByText('5')).toBeTruthy();
    expect(awaiting.getByText('По ролям: гиды — 2, операторы — 3.')).toBeTruthy();
    expect(line('awaiting').getAttribute('data-tone')).toBe('attention');

    expect(within(line('storefront_no_channel')).getByText('1')).toBeTruthy();
    expect(within(line('approved_no_channel')).getByText('4')).toBeTruthy();
    expect(within(line('tour_new')).getByRole('link', { name: 'Новые туры на проверке' }).getAttribute('href')).toBe('/hub/admin/moderation');
    expect(within(line('tour_edits')).getByText('7')).toBeTruthy();
    expect(within(line('offer')).getByText('9')).toBeTruthy();
    expect(line('offer').getAttribute('data-tone')).toBe('calm');
    expect(within(line('test')).getByText('2')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('одно число не прочитано: у него «не прочитано», а не ноль; остальные числа на месте', async () => {
    fetchMock.mockResolvedValue(answer(200, { success: true, data: { ...BUSY, tourEdits: { newTours: 'unknown', edits: 'unknown' } } }));
    render(<PartnerQueuesReport />);
    await waitFor(() => expect(line('tour_new')).toBeTruthy());
    expect(within(line('tour_new')).getByText('не прочитано')).toBeTruthy();
    expect(within(line('tour_new')).queryByText('0')).toBeNull();
    expect(line('tour_new').getAttribute('data-tone')).toBe('unknown');
    expect(within(line('awaiting')).getByText('5')).toBeTruthy();
  });

  it('пока читается — заглушка, а не нули', () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    render(<PartnerQueuesReport />);
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(line('awaiting')).toBeNull();
  });

  it.each([
    ['отказ двери словами сервера', () => answer(503, { success: false, error: 'База не ответила' }), 'База не ответила'],
    ['отказ без слов — код ответа', () => answer(500, null), 'Отчёт очередей не загрузился (код 500)'],
    ['ответ без данных', () => answer(200, { success: true }), 'Отчёт очередей не загрузился (код 200)'],
  ])('%s: блок говорит, что отчёт не загрузился, и чисел не рисует', async (_name, reply, text) => {
    fetchMock.mockResolvedValue(reply());
    render(<PartnerQueuesReport />);
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    expect(line('awaiting')).toBeNull();
  });

  it('сеть оборвалась — тоже «не загрузился», а не пустой блок', async () => {
    fetchMock.mockRejectedValue(new Error('обрыв'));
    render(<PartnerQueuesReport />);
    expect((await screen.findByRole('alert')).textContent).toBe('Отчёт очередей не загрузился');
  });
});

describe('экран «Операторы»', () => {
  it('блок очередей стоит на экране над списком партнёров', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === '/api/admin/partners/queues') return answer(200, { success: true, data: BUSY });
      if (String(url).startsWith('/api/admin/operators?')) {
        return answer(200, { success: true, data: [], meta: { total: 0, group_counts: { partners: 0, potential: 0 } } });
      }
      return answer(200, { success: true, data: [] });
    });
    const { default: OperatorsClient } = await import('@/app/hub/admin/operators/_OperatorsClient');
    render(<OperatorsClient />);
    const block = await screen.findByTestId('partner-queues');
    await waitFor(() => expect(within(block).getByText('Ждут одобрения')).toBeTruthy());
    const title = screen.getByRole('heading', { name: 'Операторы' });
    // Заголовок экрана — выше блока очередей.
    expect(title.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('GET /api/admin/partners/queues', () => {
  const get = async () => {
    const { GET } = await import('@/app/api/admin/partners/queues/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/partners/queues'));
    return { status: res.status, body: await res.json() };
  };

  it('администратору — числа, как их прочитал отчёт', async () => {
    h.admin.mockResolvedValue({ userId: 'a1', role: 'admin' });
    h.read.mockResolvedValue(BUSY);
    expect(await get()).toEqual({ status: 200, body: { success: true, data: BUSY } });
  });

  it('не администратору — отказ входа, отчёт не читается', async () => {
    h.admin.mockResolvedValue(NextResponse.json({ success: false, error: 'Нет доступа' }, { status: 403 }));
    const r = await get();
    expect(r.status).toBe(403);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('«не прочитано» доходит до экрана как есть, а не нулём', async () => {
    h.admin.mockResolvedValue({ userId: 'a1', role: 'admin' });
    h.read.mockResolvedValue({ ...QUIET, storefrontNoChannel: 'unknown' });
    expect((await get()).body.data.storefrontNoChannel).toBe('unknown');
  });
});
