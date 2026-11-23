// @vitest-environment jsdom
/**
 * Справка оператора: привязка мессенджеров и вопрос о выплатах (владелец 23.11).
 *
 * Справка звала подключить MAX командой «партнер + email». Боты эту команду
 * не принимают с 09.10: по почте чат подключил бы любой, кто знает адрес, и
 * заявки туристов ушли бы ему. Человек делал, как написано, и получал отказ.
 * Теперь справка называет два настоящих пути — и называет их теми же словами,
 * что кабинет и бот: сторож рендерит блок профиля и читает ответ бота.
 *
 * Вопрос «Когда я получу деньги?» обещал выплату от администрации, которой
 * нет: платформа платежи не принимает.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { OPERATORS } from '@/lib/help/content';
import { PARTNER_EMAIL_BIND_CLOSED } from '@/lib/kuzmich/operator-chat';
import { MessengerConnectCard } from '@/components/operator/MessengerConnectCard';
import { PLATFORM_ACCEPTS_PAYMENTS } from '@/lib/payments/accepting';

afterEach(() => cleanup());

const text = JSON.stringify(OPERATORS);

describe('справка оператора: как подключить MAX и Telegram', () => {
  it('старой команды «партнер + email» в справке нет', () => {
    expect(text).not.toMatch(/«партн[её]р»/i);
    expect(text).not.toMatch(/email из профиля/i);
    expect(text).toContain('По почте чат не подключается');
  });

  it('первый путь — кнопка из кабинета, теми же словами, что отвечает бот', () => {
    for (const word of ['«Подключить MAX»', '«Подключить Telegram»', '«Старт»']) {
      expect(text, word).toContain(word);
      expect(PARTNER_EMAIL_BIND_CLOSED, `бот называет ${word}`).toContain(word);
    }
  });

  it('второй путь — код из профиля: блок и кнопка называются так же, как в кабинете', () => {
    const { container, getByRole } = render(<MessengerConnectCard status="not_connected" panel={null} onIssue={() => {}} />);
    const heading = container.querySelector('h2')?.textContent ?? '';
    const button = getByRole('button').textContent ?? '';
    expect(heading).toBe('Заявки в Telegram и MAX');
    expect(button).toBe('Получить код');
    expect(text).toContain(`«${heading}»`);
    expect(text).toContain(`«${button}»`);
    // Срок кода и команда — те же, что на карточке.
    expect(container.textContent).toContain('Код действует 30 минут');
    expect(text).toContain('он действует 30 минут');
    expect(text).toContain('/start и код из шести знаков');
  });

  it('прежних названий блока, которых в кабинете нет, в справке не осталось', () => {
    expect(text).not.toContain('Уведомления о бронях в Telegram');
    expect(render(<MessengerConnectCard status="connected" panel={null} onIssue={() => {}} />).container.textContent).toContain('Подключены');
    expect(OPERATORS.faq.find((f) => f.q === 'Не приходят заявки')?.a).toContain('должно быть «Подключены»');
  });
});

describe('справка оператора: выплат от платформы не обещает', () => {
  it('вопроса о выплате в справке нет', () => {
    expect(OPERATORS.faq.map((f) => f.q)).not.toContain('Когда я получу деньги?');
    expect(OPERATORS.faq.length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(PLATFORM_ACCEPTS_PAYMENTS)('пока платформа платежи не принимает — слов о выплате на реквизиты нет', () => {
    expect(text).not.toMatch(/формирует выплату/);
    expect(text).not.toMatch(/36 час/);
  });
});
