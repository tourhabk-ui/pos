/**
 * Заявка Кузьмича из MAX/Telegram (02.11, «го» владельца): тот же план, что
 * у веб-чата, согласие обязательно, дата не выдумывается.
 */
import { describe, it, expect } from 'vitest';
import {
  planFromBookingFlow, planChatRequest, humanChatConfirm,
  chatRequestNotCreated,
} from '@/lib/kuzmich/chat-request';

describe('planFromBookingFlow', () => {
  it('шаги MAX → create_booking_request с согласием, туром и датой', () => {
    const p = planFromBookingFlow({ tourId: 36, name: 'Иван', phone: '+79991234567', date: '2099-11-15', participants: 2 });
    expect(p.tool).toBe('create_booking_request');
    expect(p.args).toMatchObject({ tour: '36', date: '2099-11-15', participants: 2, consent: true, name: 'Иван', phone: '+79991234567' });
  });
  it('совпадает по форме с планом веб-чата', () => {
    const web = planChatRequest('Меня зовут Иван, +79991234567, согласен', { id: 36 }, { date: '2099-11-15', guests: 2 });
    const max = planFromBookingFlow({ tourId: 36, name: 'Иван', phone: '+79991234567', date: '2099-11-15', participants: 2 });
    expect(web?.tool).toBe(max.tool);
    expect(Object.keys(web!.args).sort()).toEqual(Object.keys(max.args).sort());
  });
});

describe('быстрый путь MAX — тот же planChatRequest', () => {
  it('без согласия заявки нет', () => {
    expect(planChatRequest('Меня зовут Иван, +79991234567', { id: 36 }, { date: '2099-11-15' })).toBeNull();
  });
  it('без даты заявки нет — дату не выдумываем', () => {
    expect(planChatRequest('Меня зовут Иван, +79991234567, согласен', { id: 36 }, {})).toBeNull();
  });
});

describe('подтверждение', () => {
  it('штатная фраза, тур назван, предложена правка, без «недоступен»', () => {
    const t = humanChatConfirm('Заявка оператору принята: "Тур", 2099-11-15. Это заявка, не оплата. Ключ статуса заявки: abc — по нему get_request_status покажет. Человеку дайте ссылку https://vedarai.ru/request-status#abc', 'Зимняя рыбалка');
    expect(t).toContain('Заявка создана.');
    expect(t).toContain('Оператор свяжется с вами');
    expect(t).toContain('«Зимняя рыбалка»');
    expect(t).toContain('Если не тот');
    expect(t).not.toMatch(/недоступ|временно/i);
  });
  it('отказ — без «временно недоступен»', () => {
    expect(chatRequestNotCreated(null)).not.toMatch(/недоступ|временно/i);
    expect(chatRequestNotCreated('мест нет на эту дату')).toContain('мест нет');
  });
});

import { tourPickLabel, parseTourPick, tourPickButtons, GUEST_BUTTONS, CONFIRM_BUTTONS, CONFIRM_YES, isCorrection } from '@/lib/kuzmich/quick-replies';
import { isYes, isNo } from '@/lib/kuzmich/core';

describe('кнопки шагов заявки', () => {
  it('кнопка тура читается шагом «тур» как номер', () => {
    const label = tourPickLabel(36, 'Зимняя рыбалка на Авачинской губе ноябрь — январь');
    expect(label.startsWith('36 · ')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(36);
    expect(parseTourPick(label)).toBe(36);
    expect(parseTourPick('ID61')).toBe(61);
    expect(parseTourPick('15 июля')).toBeNull();
  });
  it('не больше шести туров, без повторов, плюс «Отмена»', () => {
    const rows = tourPickButtons(Array.from({ length: 9 }, (_, i) => ({ id: i % 8, title: `Тур ${i}` })));
    expect(rows).toHaveLength(7);
    expect(rows.at(-1)).toEqual(['Отмена']);
  });
  it('люди — числа, подтверждение — да/исправить/отмена', () => {
    expect(GUEST_BUTTONS.flat().filter((l) => /^\d+$/.test(l))).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(isYes(CONFIRM_YES)).toBe(true);
    expect(isNo(CONFIRM_YES)).toBe(false);
    expect(isCorrection('Исправить')).toBe(true);
    expect(CONFIRM_BUTTONS.flat()).toContain('Отмена');
    expect(isNo('Отмена')).toBe(true);
  });
});
