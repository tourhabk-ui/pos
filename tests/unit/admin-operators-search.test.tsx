/**
 * Экран «Операторы» в админке: поиск, обрезка списка и отказ (16.10).
 *
 * Владелец: «где Камчатская рыбалка?» — поиск по «Камч» находил только
 * «Местечко Камчатка». Экран загружал первые 100 партнёров и искал среди них
 * в браузере, а давняя карточка стояла за сотней новых. Об обрезке экран не
 * говорил, а неудачную загрузку показывал как «Ничего не найдено».
 *
 * Сторож рендерит экран с подменённым ответом сервера и проверяет то, что
 * видит администратор (правило 13.10): поиск уходит на сервер, обрезка
 * названа и дозагружается, отказ назван словами.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@/components/auth/Protected', () => ({
  Protected: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import OperatorsClient from '@/app/hub/admin/operators/_OperatorsClient';

function row(id: string, name: string) {
  return {
    id, company_name: name, category: 'operator', description: '', profile_status: 'approved',
    applied_at: null, is_verified: false, is_public: true, profile_review_comment: null,
    email: null, contact_name: null, registered_at: null, has_account: false, external_source: null,
    application_id: null, contact_phone: null, contact_email: null, inn: null, application_status: null,
    reviewed_at: null, telegram_chat_id: null, has_telegram: false, has_max: false, slug: null,
    widget_enabled: false, widget_domains: [],
  };
}

type Answer = { status?: number; data?: ReturnType<typeof row>[]; total?: number };

/** Сервер на подмене: список отвечает по параметрам запроса, прочее — пусто. */
function serve(answer: (p: URLSearchParams) => Answer) {
  const calls: URLSearchParams[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://vedarai.ru');
    if (url.pathname === '/api/admin/operators') {
      const p = url.searchParams;
      calls.push(p);
      if (p.get('limit') === '1') {
        return new Response(JSON.stringify({ success: true, data: [], meta: { total: 0, limit: 1, offset: 0 } }));
      }
      const a = answer(p);
      if (a.status && a.status !== 200) return new Response('{"error":"x"}', { status: a.status });
      return new Response(JSON.stringify({
        success: true, data: a.data ?? [], meta: { total: a.total ?? (a.data ?? []).length, limit: 100, offset: 0 },
      }));
    }
    return new Response(JSON.stringify({ success: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const listCalls = (calls: URLSearchParams[]) => calls.filter((p) => p.get('limit') !== '1');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('админка «Операторы»: поиск — на сервере', () => {
  it('набранный текст уходит запросом q, и найденная карточка показана', async () => {
    const calls = serve((p) =>
      p.get('q') === 'Камч'
        ? { data: [row('a1', 'Камчатская рыбалка'), row('a2', 'Местечко Камчатка')] }
        : { data: [row('a2', 'Местечко Камчатка')], total: 140 });
    render(<OperatorsClient />);
    fireEvent.change(await screen.findByPlaceholderText(/Поиск по названию/), { target: { value: 'Камч' } });
    expect(await screen.findByText('Камчатская рыбалка')).toBeTruthy();
    const last = listCalls(calls).at(-1)!;
    expect(last.get('q')).toBe('Камч');
    expect(last.get('limit')).toBe('100');
  });

  it('ничего не нашлось — сказано, по какому запросу', async () => {
    serve((p) => (p.get('q') ? { data: [] } : { data: [row('a2', 'Местечко Камчатка')] }));
    render(<OperatorsClient />);
    fireEvent.change(await screen.findByPlaceholderText(/Поиск по названию/), { target: { value: 'Чавыча' } });
    expect(await screen.findByText('Ничего не найдено по «Чавыча»')).toBeTruthy();
  });
});

describe('обрезка списка названа и дозагружается', () => {
  it('«Показаны 3 из 5» и «Показать ещё» догружает следующую страницу', async () => {
    const first = [row('p1', 'Первый'), row('p2', 'Второй'), row('p3', 'Третий')];
    const rest = [row('p4', 'Четвёртый'), row('p5', 'Пятый')];
    const calls = serve((p) => (p.get('offset') === '3' ? { data: rest, total: 5 } : { data: first, total: 5 }));
    render(<OperatorsClient />);
    expect(await screen.findByText(/Показаны 3 из 5/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Пятый')).toBeTruthy();
    expect(screen.getByText('Первый')).toBeTruthy();
    expect(listCalls(calls).at(-1)!.get('offset')).toBe('3');
    await waitFor(() => expect(screen.queryByText(/Показаны/)).toBeNull());
  });
});

describe('отказ загрузки — словами, а не «ничего не найдено» (§4.0)', () => {
  it('сервер ответил 500 — «Список не загрузился», и есть повтор', async () => {
    serve(() => ({ status: 500 }));
    render(<OperatorsClient />);
    expect(await screen.findByText('Список не загрузился: сервер ответил 500.')).toBeTruthy();
    expect(screen.queryByText(/Нет заявок на проверке|Ничего не найдено/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Попробовать ещё раз' })).toBeTruthy();
  });
});
