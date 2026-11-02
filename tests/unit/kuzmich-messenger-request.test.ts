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
    const t = humanChatConfirm('ok https://vedarai.ru/request-status#abc', 'Зимняя рыбалка');
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
