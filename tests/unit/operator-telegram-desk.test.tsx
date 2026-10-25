/**
 * Кабинет туроператора в Telegram и MAX.
 * Код из профиля пишет чат в карточку партнёра. Кнопки ответа не подтверждают бронь.
 * Слово «Помощь» тикет не создаёт — его создаёт отдельная кнопка.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MessengerConnectCard } from '@/components/operator/MessengerConnectCard';
import { normalizeBindCode, bindCodeMissedText, mintBindCode } from '@/lib/partners/bind-code';
import { channelBoundText } from '@/lib/partners/bind-channel';
import { operatorBoundText, operatorHelpText, operatorReplyMarkup, tourPriceLabel } from '@/lib/telegram/operator-desk';
import { chatAnswerButtons, chatAnswerText, parseChatAnswer } from '@/lib/requests/chat-answer';

afterEach(() => cleanup());

describe('короткий код привязки', () => {
  it('шесть знаков без 0, O, 1 и I', () => {
    expect(normalizeBindCode(' ab23cd ')).toBe('AB23CD');
    expect(normalizeBindCode('ABC12O')).toBeNull();
    expect(normalizeBindCode('ABC121')).toBeNull();
    expect(normalizeBindCode('abc234')).toBe('ABC234');
    for (let i = 0; i < 20; i += 1) {
      const code = mintBindCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it('неизвестный код говорит одну фразу и зовёт получить новый', () => {
    expect(bindCodeMissedText()).toBe('Код не подошёл — нажмите «Получить новый».');
  });
});

describe('подтверждение туроператора', () => {
  it('называет роль и заявки, не командный центр', () => {
    const text = operatorBoundText('Местечко <Камчатка>');
    expect(text).toContain('Вы подключены как туроператор «Местечко &lt;Камчатка&gt;».');
    expect(text).toContain('Сюда будут приходить заявки');
    expect(text).toContain('в этот чат не приходят — их принимает MAX');
    expect(text).not.toMatch(/командный центр|Совет директоров|\/stats/);
    const max = operatorBoundText('Местечко', 'max');
    expect(max).toContain('Имя и телефон туриста приходят в этот чат.');
    expect(max).not.toContain('не приходят');
    const bound = channelBoundText('max', {
      ok: true, partnerName: 'Местечко', displayName: 'Местечко',
      category: 'operator', slug: 'mestechko', previousChatId: null, rebound: false,
    });
    expect(bound).toContain('приходят в этот чат');
    expect(bound).not.toContain('не приходят');
    expect(operatorReplyMarkup().keyboard.flat().map((b) => b.text)).toEqual([
      'Новые заявки', 'Мои туры и цены', 'Обновить места', 'Помощь',
    ]);
  });

  it('справка не обещает тикет от слова «Помощь»', () => {
    const help = operatorHelpText();
    expect(help).toContain('Кабинет туроператора');
    expect(help).toContain('Само слово «Помощь» тикет не создаёт');
    expect(help).toContain('Бронь кнопкой ответа не подтверждается');
  });

  it('цена без единицы не называется ценой с человека', () => {
    const labeled = tourPriceLabel(4500, null);
    expect(labeled).toMatch(/^от /);
    expect(labeled).toContain('₽');
    expect(labeled).not.toContain('не записано');
    expect(tourPriceLabel(null, 'person')).toBeNull();
  });
});

describe('кнопки карточки заявки', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('четыре ответа и ни один не подтверждает бронь', () => {
    const buttons = chatAnswerButtons(1, 'booking', id);
    expect(buttons.map((b) => b.text)).toEqual(['1 · Принять', '1 · Нет мест', '1 · Уточнить', '1 · Свяжусь сам']);
    expect(parseChatAnswer(buttons[0]!.payload)).toEqual({ answer: 'accept', kind: 'booking', subjectId: id });
    for (const answer of ['accept', 'no_seats', 'clarify', 'self'] as const) {
      const line = chatAnswerText(answer, false);
      expect(line).not.toMatch(/бронь подтверждена/i);
      expect(line).not.toMatch(/оплата открыта/i);
    }
    expect(chatAnswerText('accept', false)).toContain('Бронь этим не подтверждена');
    expect(chatAnswerText('self', false)).toContain('Контакты заказчика в Telegram не отправляю');
  });
});

describe('карточка подключения в профиле', () => {
  it('показывает QR, короткую команду и обе двери', () => {
    const onIssue = vi.fn();
    render(React.createElement(MessengerConnectCard, {
      status: 'not_connected',
      onIssue,
      panel: {
        loading: false,
        error: null,
        code: 'ABC234',
        telegramUrl: 'https://t.me/kuzmichai_bot?start=ABC234',
        maxUrl: 'https://max.ru/id4101147649_bot?start=ABC234',
        telegramQr: 'data:image/png;base64,aaa',
        maxQr: 'data:image/png;base64,bbb',
      },
    }));
    expect(screen.getByText('/start ABC234')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Открыть Telegram' }).getAttribute('href')).toBe('https://t.me/kuzmichai_bot?start=ABC234');
    expect(screen.getByRole('link', { name: 'Открыть MAX' }).getAttribute('href')).toContain('start=ABC234');
    expect(screen.getByAltText('QR-код для Telegram')).toBeTruthy();
    expect(screen.getByAltText('QR-код для MAX')).toBeTruthy();
    expect(screen.getByText(/кабинет туроператора/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Получить новый' }));
    expect(onIssue).toHaveBeenCalledTimes(1);
  });
});
