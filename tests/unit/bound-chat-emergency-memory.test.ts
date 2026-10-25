// @vitest-environment node
/**
 * Привязанный чат помнит свою беду (проверка качества 24.10, второе ревью).
 *
 * После «Помогите, мы заблудились» Кузьмич туриста спрашивает, где они, и
 * ответы («Стоим у ручья под Горелым», «Темнеет, что делать») классификатор
 * отдавал кабинету — без 112 и без разговора. Теперь два часа после своей
 * беды чат отвечается Кузьмичом, кроме команды кабинета своей формой.
 *
 * Здесь же: исключение CRM — только запись о чужой беде, начатая словом дела;
 * «да»/«нет» шага брони — целым словом; хвост номера для поиска в CRM.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BOUND_CHAT_EMERGENCY_MS, boundChatLane, boundChatLaneFor, clearBoundChatEmergencies,
} from '@/lib/kuzmich/bound-chat-route';
import { isNo, isYes } from '@/lib/kuzmich/core';
import { redactPII } from '@/lib/security/pii-redact';

const T0 = Date.UTC(2026, 9, 25, 3, 0);
const CHAT = 5151;

beforeEach(() => { clearBoundChatEmergencies(); });

describe('память о беде в привязанном чате', () => {
  it('после своей беды ответы на вопрос Кузьмича идут Кузьмичу, команда кабинета — кабинету', () => {
    expect(boundChatLaneFor('max', CHAT, 'Помогите, мы заблудились', { nowMs: T0 })).toBe('tourist');
    // Без памяти эти фразы — кабинет (неузнанное).
    expect(boundChatLane('Стоим у ручья под Горелым')).toBe('partner');
    expect(boundChatLaneFor('max', CHAT, 'Стоим у ручья под Горелым', { nowMs: T0 + 60_000 })).toBe('tourist');
    expect(boundChatLaneFor('max', CHAT, 'Темнеет, что делать', { nowMs: T0 + 30 * 60_000 })).toBe('tourist');
    expect(boundChatLaneFor('max', CHAT, 'календарь Jimny', { nowMs: T0 + 30 * 60_000 })).toBe('partner');
  });

  it('через два часа память гаснет; другой чат и другой канал её не видят', () => {
    boundChatLaneFor('max', CHAT, 'Помогите, мы заблудились', { nowMs: T0 });
    expect(boundChatLaneFor('telegram', CHAT, 'Стоим у ручья', { nowMs: T0 + 1000 })).toBe('partner');
    expect(boundChatLaneFor('max', CHAT + 1, 'Стоим у ручья', { nowMs: T0 + 1000 })).toBe('partner');
    expect(boundChatLaneFor('max', CHAT, 'Стоим у ручья', { nowMs: T0 + BOUND_CHAT_EMERGENCY_MS + 1000 })).toBe('partner');
  });

  it('запись о чужой беде («запиши: у клиента сломана нога») — кабинет, и память не заводит', () => {
    expect(boundChatLaneFor('telegram', CHAT, 'запиши: у клиента сломана нога', { nowMs: T0 })).toBe('partner');
    expect(boundChatLaneFor('telegram', CHAT, 'кто ждёт ответа?', { nowMs: T0 + 1000 })).toBe('partner');
  });

  it('администратор: беда Кузьмичу при любых словах, и чат её помнит', () => {
    expect(boundChatLaneFor('telegram', CHAT, 'запиши: турист сломал ногу', { admin: true, nowMs: T0 })).toBe('tourist');
    expect(boundChatLaneFor('telegram', CHAT, 'мы у третьего ручья', { admin: true, nowMs: T0 + 1000 })).toBe('tourist');
  });
});

describe('исключение CRM — только запись о чужой беде, начатая словом дела', () => {
  it.each([
    'Перезвоните, мы заблудились!',
    'Помогите! Клиент упал с обрыва',
    'Запишите координаты: мы заблудились у Горелого',
    'Клиент сломал ногу на Горелом, помогите',
  ])('«%s» — Кузьмичу туриста', (text) => {
    expect(boundChatLane(text)).toBe('tourist');
  });

  it.each([
    'запиши: турист сломал ногу',
    'заведи задачу: у клиента сломана нога, позвонить завтра',
    'напомни перезвонить: человек без сознания',
  ])('«%s» — кабинет', (text) => {
    expect(boundChatLane(text)).toBe('partner');
  });
});

describe('«да» и «нет» шага брони — целым словом', () => {
  it.each(['У нас беда', 'вода прибывает', 'Когда нас найдут?', 'Ладно, подумаю'])('«%s» — не «да»', (t) => {
    expect(isYes(t)).toBe(false);
  });
  it.each(['да', 'Да!', 'да, всё верно', 'Ок', 'окей', 'подтверждаю'])('«%s» — «да»', (t) => {
    expect(isYes(t)).toBe(true);
  });
  it.each(['интернет есть', 'Анна Нетребко'])('«%s» — не «нет»', (t) => {
    expect(isNo(t)).toBe(false);
  });
  it.each(['нет', 'Нет, отмена', 'стоп'])('«%s» — «нет»', (t) => {
    expect(isNo(t)).toBe(true);
  });
});

describe('хвост номера для помощника кабинета', () => {
  it('keepPhoneTail оставляет четыре последние цифры, остальное вырезано', () => {
    const out = redactPII('Найди клиента +7 900 000-12-34', { keepPhoneTail: true });
    expect(out).toBe('Найди клиента [телефон …1234]');
    expect(out).not.toMatch(/900/);
  });
  it('без опции — прежний плейсхолдер', () => {
    expect(redactPII('звонил +7 900 000-12-34')).toBe('звонил [телефон]');
  });
});
