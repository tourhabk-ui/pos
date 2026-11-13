// @vitest-environment jsdom
/**
 * Сохранённый перевод сообщения переписки — в админке (13.11, миграция 1440).
 *
 * Перевод делается один раз, при отправке сообщения, и лежит в строке
 * `request_messages`. Администратор читает переписку в карточке лида и в
 * разделе «Заявки гостей»: слова клиента не по-русски он понимает по тому же
 * переводу, который получил адресат, а у ответа адресата видит, что ушло
 * клиенту на его языке.
 *
 * Здесь — что видит человек (рендер). Что двери админки отдают перевод из
 * базы, держит сцена «админка: обе двери…» в
 * tests/integration/request-chat.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

import { MessageTranslation, adminTranslationLabel } from '@/components/admin/shared/MessageTranslation';
import { LeadConversation } from '@/app/hub/admin/leads/_LeadConversation';
import { StayRequestsSection } from '@/app/hub/admin/accommodations/_StayRequestsSection';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

function answerOnce(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('строка перевода под сообщением', () => {
  it('слова клиента: «Перевод (машинный)» и текст перевода', () => {
    const { container } = render(<MessageTranslation author="guest" translation="Можно начать в 9 утра?" />);
    expect(container.textContent).toBe('Перевод (машинный): Можно начать в 9 утра?');
  });

  it('слова адресата: сказано, что перевод ушёл клиенту', () => {
    const { container } = render(<MessageTranslation author="owner" translation="Yes, we start at 9:00." />);
    expect(container.textContent).toBe('Клиенту ушёл перевод (машинный): Yes, we start at 9:00.');
    expect(adminTranslationLabel('owner')).not.toBe(adminTranslationLabel('guest'));
  });

  it('в заявках на жильё обратившийся назван гостем — как во всей секции', () => {
    const { container } = render(<MessageTranslation author="owner" translation="Yes, parking is in the yard." to="Гостю" />);
    expect(container.textContent).toBe('Гостю ушёл перевод (машинный): Yes, parking is in the yard.');
    // У слов самого гостя подпись от этого не меняется.
    expect(adminTranslationLabel('guest', 'Гостю')).toBe('Перевод (машинный)');
  });

  it('перевода нет — строки нет: ни подписи, ни слов «не получен»', () => {
    for (const translation of [null, undefined, '', '   \n']) {
      const { container } = render(<MessageTranslation author="guest" translation={translation} />);
      expect(container.innerHTML).toBe('');
      cleanup();
    }
  });

  it('текст перевода — под той же обёрткой ПД, что и исходник', () => {
    const { container } = render(<MessageTranslation author="guest" translation="Мой телефон +86 138 0013 8000" />);
    expect(container.querySelector('.sensitive-value')?.textContent).toBe('Мой телефон +86 138 0013 8000');
  });
});

describe('карточка лида: переписка с адресатом', () => {
  const messages = [
    { author: 'guest', door: 'page', body: 'Can we start at 9 am?', delivery_channel: 'max', delivery_reason: null,
      created_at: '2026-11-13T01:00:00.000Z', translation: 'Можно начать в 9 утра?' },
    { author: 'owner', door: 'max', body: 'Да, начнём в 9:00.', delivery_channel: 'max', delivery_reason: null,
      created_at: '2026-11-13T01:05:00.000Z', translation: 'Yes, we start at 9:00.' },
    { author: 'guest', door: 'page', body: 'Спасибо!', delivery_channel: 'max', delivery_reason: null,
      created_at: '2026-11-13T01:06:00.000Z', translation: null },
  ];

  it('перевод стоит под своим сообщением и исходник не заменяет', async () => {
    const fetchMock = answerOnce({ success: true, data: messages });
    render(<LeadConversation leadId="11111111-1111-4111-8111-111111111111" />);
    const list = await screen.findByRole('list', { name: 'Переписка' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    // Слова клиента: сначала исходник, под ним перевод на русский.
    const first = items[0].textContent ?? '';
    expect(first).toContain('Can we start at 9 am?');
    expect(first).toContain('Перевод (машинный): Можно начать в 9 утра?');
    expect(first.indexOf('Can we start at 9 am?')).toBeLessThan(first.indexOf('Перевод (машинный)'));

    // Слова адресата: под ними то, что ушло клиенту на его языке.
    const second = items[1].textContent ?? '';
    expect(second).toContain('Да, начнём в 9:00.');
    expect(second).toContain('Клиенту ушёл перевод (машинный): Yes, we start at 9:00.');
    expect(second).not.toContain('Можно начать');

    // Русское сообщение без перевода — без строки перевода.
    expect(items[2].textContent).toContain('Спасибо!');
    expect(items[2].textContent).not.toMatch(/[Пп]еревод/);
  });

  it('дверь без поля перевода (старый ответ) — переписка читается, строки перевода нет', async () => {
    answerOnce({ success: true, data: [{ ...messages[0], translation: undefined }] });
    render(<LeadConversation leadId="11111111-1111-4111-8111-111111111111" />);
    const list = await screen.findByRole('list', { name: 'Переписка' });
    expect(list.textContent).toContain('Can we start at 9 am?');
    expect(list.textContent).not.toMatch(/[Пп]еревод/);
  });
});

describe('«Заявки гостей»: переписка хозяина и гостя', () => {
  const request = {
    id: 'r1', createdAt: '2026-11-13T00:00:00.000Z', accommodationId: 'a1', accommodationName: 'Гостевой дом',
    partnerName: 'Гостевой дом', ownerOnMax: true, ownerOnTelegram: false,
    checkIn: '2027-07-10', checkOut: '2027-07-12', guests: 2, guestName: 'Li Wei', guestPhone: '+8613800138000',
    comment: null, door: 'form', ownerChannel: 'max', ownerReason: null, platformChannel: null, platformReason: null,
    deliveryRecordedAt: null, guestOnMax: false,
    messages: [
      { author: 'guest', door: 'page', body: 'Is there parking near the house?', delivery: 'max', deliveryReason: null,
        translation: 'Есть ли парковка у дома?', at: '2026-11-13T01:00:00.000Z' },
      { author: 'owner', door: 'max', body: 'Да, парковка во дворе.', delivery: 'max', deliveryReason: null,
        translation: 'Yes, parking is in the yard.', at: '2026-11-13T01:05:00.000Z' },
      { author: 'owner', door: 'max', body: 'Ждём вас.', delivery: 'max', deliveryReason: null,
        translation: null, at: '2026-11-13T01:06:00.000Z' },
    ],
  };

  it('под словами гостя — перевод на русский, под словами хозяина — что ушло гостю', async () => {
    answerOnce({ success: true, data: { total: 1, requests: [request] } });
    render(<StayRequestsSection />);
    const list = await screen.findByRole('list', { name: 'Переписка' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const first = items[0].textContent ?? '';
    expect(first.indexOf('Is there parking near the house?')).toBeGreaterThanOrEqual(0);
    expect(first.indexOf('Is there parking near the house?')).toBeLessThan(first.indexOf('Перевод (машинный): Есть ли парковка у дома?'));
    expect(items[1].textContent).toContain('Гостю ушёл перевод (машинный): Yes, parking is in the yard.');
    expect(items[1].textContent).not.toContain('Клиенту');
    expect(items[2].textContent).toContain('Ждём вас.');
    expect(items[2].textContent).not.toMatch(/[Пп]еревод/);
  });
});
