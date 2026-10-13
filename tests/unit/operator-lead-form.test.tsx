/**
 * «Написать оператору» на странице партнёра (владелец 13.10: «форму можно»).
 *
 * Что держит сторож:
 *  - заявка уходит в /api/leads с `partner_slug` НА ВЕРХНЕМ УРОВНЕ — так роут
 *    резолвит operator_id, и лид ложится в ящик этого оператора (29.09: slug
 *    только в source_data оставлял лид без оператора);
 *  - согласие на ПД обязательно и передаётся `pd_consent: true`;
 *  - без имени, телефона и согласия кнопка не активна;
 *  - источник заявки назван: source_data.source = operator_page;
 *  - успех не обещает срока ответа — его система не знает.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { OperatorLeadForm, LEAD_FORM_SOURCE } from '@/components/operators/OperatorLeadForm';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fill() {
  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'Анна' } });
  fireEvent.change(screen.getByLabelText('Телефон'), { target: { value: '+79990000000' } });
}

describe('OperatorLeadForm', () => {
  it('без имени, телефона и согласия кнопка не активна', () => {
    render(<OperatorLeadForm partnerSlug="mestechko" partnerName="Местечко Камчатка" />);
    const button = screen.getByRole('button', { name: /Отправить оператору/ });
    expect(button).toBeDisabled();
    fill();
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button).toBeEnabled();
  });

  it('заявка уходит в /api/leads с partner_slug сверху, согласием и источником operator_page', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<OperatorLeadForm partnerSlug="mestechko" partnerName="Местечко Камчатка" />);
    fill();
    fireEvent.change(screen.getByLabelText('Что интересует'), { target: { value: 'Толбачик, двое, август' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Отправить оператору/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe('/api/leads');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.partner_slug).toBe('mestechko');
    expect(body.pd_consent).toBe(true);
    expect(body.name).toBe('Анна');
    expect(body.phone).toBe('+79990000000');
    expect(body.comment).toBe('Толбачик, двое, август');
    expect(body.source_data).toEqual({ source: LEAD_FORM_SOURCE, partner_slug: 'mestechko' });
    expect(LEAD_FORM_SOURCE).toBe('operator_page');

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Заявка ушла оператору «Местечко Камчатка»');
    expect(status.textContent).not.toMatch(/в течение|за \d+ (минут|час)/);
  });

  it('отказ роута показывается словами роута, а не «успехом»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ success: false, error: 'Укажите телефон' }) })));
    render(<OperatorLeadForm partnerSlug="mestechko" partnerName="Местечко Камчатка" />);
    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Отправить оператору/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Укажите телефон');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
