/**
 * Контроль выхода из чата Кузьмича — lib/kuzmich/watch-flow.ts.
 *
 * Держит правило 3 манифеста (docs/safety/WATCH_MANIFEST.md): включает,
 * закрывает и отодвигает контроль только явное слово человека, разобранное
 * кодом; срок — камчатский; не разобрали — переспросили, а не угадали.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const tgSend = vi.fn(async () => ({ ok: true }));
const sendEmail = vi.fn(async () => ({ success: true }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgSend(...(a as [])) }));
vi.mock('@/lib/email', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...(a as [])) }));

import {
  isWatchTrigger, isReturnedCommand, isDelayedCommand, isConfirm, isCancel,
  extractPhone, extractDestination, extractContactName, parseReturn, returnSegment,
  draftFromTrigger, advanceDraft, watchSummary, handleWatchMessage, WATCH_MAX_OPEN_PER_CHAT, type WatchDraft,
} from '@/lib/kuzmich/watch-flow';
import { buildTouristWakeMessage } from '@/lib/safety/checkin-escalation';

// 30.09.2026 10:00 по Камчатке = 29.09 22:00 UTC.
const NOW = new Date('2026-09-29T22:00:00Z');

beforeEach(() => { query.mockReset(); tgSend.mockClear(); sendEmail.mockClear(); });

describe('слова человека — только сообщением целиком', () => {
  it('«вернулся» закрывает, «я не вернулся» — нет', () => {
    expect(isReturnedCommand('Вернулся!')).toBe(true);
    expect(isReturnedCommand('мы вернулись.')).toBe(true);
    expect(isReturnedCommand('я не вернулся')).toBe(false);
    expect(isReturnedCommand('вернулся бы, да дождь')).toBe(false);
  });

  it('«ок» и «около» не отодвигают тревогу', () => {
    expect(isDelayedCommand('задерживаюсь')).toBe(true);
    expect(isDelayedCommand('ок')).toBe(false);
    expect(isDelayedCommand('около часа ещё')).toBe(false);
  });

  it('подтверждение — «да», а не «да, но…»', () => {
    expect(isConfirm('Да')).toBe(true);
    expect(isConfirm('подтверждаю')).toBe(true);
    expect(isConfirm('да но время другое')).toBe(false);
    expect(isConfirm('ну давай')).toBe(false);
    expect(isCancel('Отмена')).toBe(true);
  });

  it('триггер — просьба о контроле, а не любое упоминание', () => {
    expect(isWatchTrigger('Еду на Чёртов мост, если задержусь — сообщите маме')).toBe(true);
    expect(isWatchTrigger('поставь меня на контроль')).toBe(true);
    expect(isWatchTrigger('/watch')).toBe(true);
    expect(isWatchTrigger('как добраться до Чёртова моста?')).toBe(false);
  });
});

describe('разбор', () => {
  it('телефон: +7, 8, скобки и дефисы — к +7XXXXXXXXXX', () => {
    expect(extractPhone('маме +7 (914) 123-45-67')).toBe('+79141234567');
    expect(extractPhone('89146245651')).toBe('+79146245651');
    expect(extractPhone('в 19:00')).toBeNull();
    expect(extractPhone('ИНН 4100039249')).toBeNull();
  });

  it('куда: из «еду на …», без хвоста про срок', () => {
    expect(extractDestination('еду на Чёртов мост, вернусь к 19:00')).toBe('Чёртов мост');
    expect(extractDestination('Иду на Авачинский перевал до 18:00')).toBe('Авачинский перевал');
    expect(extractDestination('привет')).toBeNull();
  });

  it('имя контакта без телефона и служебных слов', () => {
    expect(extractContactName('Марина +7 914 123-45-67')).toBe('Марина');
    expect(extractContactName('сообщите по номеру +79141234567')).toBeNull();
  });

  it('срок — камчатский: «сегодня 19:00» = 07:00 UTC', () => {
    const r = parseReturn('сегодня 19:00', NOW);
    expect(r).toEqual({ ok: true, date: '2026-09-30', time: '19:00' });
  });

  it('«завтра к 12», «03.10 18:30», «к 19»', () => {
    expect(parseReturn('завтра к 12', NOW)).toEqual({ ok: true, date: '2026-10-01', time: '12:00' });
    expect(parseReturn('03.10 18:30', NOW)).toEqual({ ok: true, date: '2026-10-03', time: '18:30' });
    expect(parseReturn('вернусь к 19', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '19:00' });
  });

  it('не угадывает: прошлое, без времени, дальше месяца, несуществующая дата', () => {
    expect(parseReturn('сегодня 09:00', NOW)).toEqual({ ok: false, reason: 'past' });
    expect(parseReturn('к вечеру', NOW)).toEqual({ ok: false, reason: 'no_time' });
    expect(parseReturn('15.12 12:00', NOW)).toEqual({ ok: false, reason: 'too_far' });
    expect(parseReturn('31.02 12:00', NOW)).toEqual({ ok: false, reason: 'bad_date' });
  });

  it('два времени во фразе — отказ, а не первое попавшееся (оно было бы временем выхода)', () => {
    expect(parseReturn('выхожу в 7, вернусь в 19', NOW)).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseReturn('сегодня или завтра к 12', NOW)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('дни словами не считаем: «в субботу», «через 3 часа» — переспрос', () => {
    expect(parseReturn('в субботу к 18', NOW)).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseReturn('через 3 часа', NOW)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('«к 19.30» и «19.30» — время, «7 вечера» — 19:00, «3 октября» — дата', () => {
    expect(parseReturn('к 19.30', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '19:30' });
    expect(parseReturn('вернусь 19.30', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '19:30' });
    expect(parseReturn('в 7 вечера', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '19:00' });
    expect(parseReturn('3 октября в 18:00', NOW)).toEqual({ ok: true, date: '2026-10-03', time: '18:00' });
    expect(parseReturn('в 2 часа дня', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '14:00' });
    // «в 2 дня» — то ли 14:00, то ли «на два дня»: не угадываем, переспрашиваем.
    expect(parseReturn('в 2 дня', NOW)).toEqual({ ok: false, reason: 'no_time' });
  });

  it('число с единицей — не час: «в 2 км от моста»', () => {
    expect(parseReturn('в 2 км от моста', NOW)).toEqual({ ok: false, reason: 'no_time' });
  });

  it('срок из первой фразы — только из куска про возвращение', () => {
    expect(returnSegment('еду на Авачу в 7, вернусь к 19, если задержусь — сообщите')).toBe('вернусь к 19');
    expect(returnSegment('еду на Авачу к 10, если задержусь — сообщите')).toBeNull();
    const d = draftFromTrigger('Еду на Авачу к 10, если задержусь — сообщите +7 914 123-45-67', NOW, 1);
    expect(d.returnTime).toBeUndefined();
    expect(d.step).toBe('return');
  });
});

describe('черновик', () => {
  it('из первой фразы забирается названное, спрашивается недостающее', () => {
    const d = draftFromTrigger('Еду на Чёртов мост, вернусь сегодня к 19:00, если задержусь — сообщите +7 914 123-45-67', NOW, 1);
    expect(d).toMatchObject({ where: 'Чёртов мост', returnDate: '2026-09-30', returnTime: '19:00', contactPhone: '+79141234567', step: 'contact_name' });
  });

  it('свой телефон не может совпасть с телефоном контакта', () => {
    const d: WatchDraft = { step: 'leader_phone', where: 'x', returnDate: '2026-09-30', returnTime: '19:00', contactPhone: '+79141234567', contactName: 'Марина', startedAt: 1 };
    const r = advanceDraft(d, '+7 914 123 45 67', NOW);
    expect(r.draft.step).toBe('leader_phone');
    expect(r.reply).toMatch(/номер контакта/);
  });

  it('итог называет лестницу числами однодневки, кто несёт каждую ступень и что спасателей зовёт человек', () => {
    const d: WatchDraft = { step: 'confirm', where: 'Чёртов <b>мост</b>', returnDate: '2026-09-30', returnTime: '19:00', contactPhone: '+79141234567', contactName: 'Марина', leaderPhone: '+79146245651', startedAt: 1 };
    const s = watchSummary(d, NOW);
    expect(s).toContain('через 1 ч напишу вам сюда');
    // До SMS контакту звонит человек — бот этого не обещает от своего имени.
    expect(s).toContain('через 3 ч попрошу дежурного Ведара позвонить Марина (+79141234567)');
    expect(s).not.toMatch(/сообщу Марина/);
    expect(s).toContain('через 8 ч дежурный получит тревогу');
    expect(s).toContain('Сам автомат спасателей не вызывает');
    expect(s).toContain('может прийти на час позже');
    expect(s).toContain('Чёртов &lt;b&gt;мост&lt;/b&gt;');
    expect(s).toContain('19:00 по камчатскому времени');
  });

  it('вопрос вместо ответа не становится маршрутом', () => {
    const d: WatchDraft = { step: 'where', startedAt: 1 };
    const r = advanceDraft(d, 'а какая там погода?', NOW);
    expect(r.draft.where).toBeUndefined();
    expect(r.reply).toMatch(/Сначала закончим с контролем/);
  });
});

describe('handleWatchMessage', () => {
  const replies: string[] = [];
  const reply = async (_: number, t: string) => { replies.push(t); };
  beforeEach(() => { replies.length = 0; });

  it('обычный вопрос — не про контроль, отдаётся дальше', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await handleWatchMessage({ channel: 'tg', chatId: 5, text: 'какая погода на Авачинском?', userName: null, reply, now: NOW })).toBe(false);
  });

  it('«да» на итог создаёт контроль с каналом туриста и камчатским сроком', async () => {
    const draft: WatchDraft = { step: 'confirm', where: 'Чёртов мост', returnDate: '2026-09-30', returnTime: '19:00', contactPhone: '+79141234567', contactName: 'Марина', leaderPhone: '+79146245651', startedAt: NOW.getTime() };
    query
      .mockResolvedValueOnce({ rows: [{ state: draft }] })   // черновик
      .mockResolvedValueOnce({ rows: [{ id: 'reg-1' }] })    // INSERT
      .mockResolvedValueOnce({ rows: [] });                  // DELETE черновика
    const handled = await handleWatchMessage({ channel: 'tg', chatId: 5, text: 'да', userName: 'Иван', reply, now: NOW });
    expect(handled).toBe(true);
    const insert = query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO route_registrations'));
    expect(insert).toBeTruthy();
    const params = insert![1] as unknown[];
    expect(params).toContain('telegram');
    expect(params).toContain('tg');
    expect(params).toContain(5);
    expect((params[17] as Date).toISOString()).toBe('2026-09-30T07:00:00.000Z');
    expect(replies.at(-1)).toMatch(/Контроль включён/);
  });

  it('сбой записи — честный отказ, а не «включён»', async () => {
    const draft: WatchDraft = { step: 'confirm', where: 'x', returnDate: '2026-09-30', returnTime: '19:00', contactPhone: '+79141234567', contactName: 'Марина', leaderPhone: '+79146245651', startedAt: NOW.getTime() };
    query
      .mockResolvedValueOnce({ rows: [{ state: draft }] })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '23502' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleWatchMessage({ channel: 'tg', chatId: 5, text: 'да', userName: 'Иван', reply, now: NOW });
    expect(replies.at(-1)).toMatch(/Не получилось включить контроль/);
    expect(replies.join('\n')).not.toMatch(/Контроль включён/);
    spy.mockRestore();
  });

  it('сообщение о беде черновик не проглатывает — оно уходит в обычный путь с SOS-блоком', async () => {
    const draft: WatchDraft = { step: 'return', where: 'Чёртов мост', startedAt: NOW.getTime() };
    query.mockResolvedValueOnce({ rows: [{ state: draft }] });
    const handled = await handleWatchMessage({ channel: 'tg', chatId: 5, text: 'помогите, сломал ногу', userName: null, reply, now: NOW });
    expect(handled).toBe(false);
    expect(replies).toHaveLength(0);
    expect(query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO trip_watch_flow'))).toBe(false);
  });

  it(`больше ${WATCH_MAX_OPEN_PER_CHAT} открытых контролей из одного чата не ставится`, async () => {
    const open = Array.from({ length: WATCH_MAX_OPEN_PER_CHAT }, (_, i) => ({ id: `r${i}`, route_name: 'x', expected_return_at: null }));
    query
      .mockResolvedValueOnce({ rows: [] })        // черновика нет
      .mockResolvedValueOnce({ rows: open });     // открытые контроли чата
    await handleWatchMessage({ channel: 'tg', chatId: 5, text: 'поставь меня на контроль', userName: null, reply, now: NOW });
    expect(replies.at(-1)).toMatch(/больше из одного чата не ставлю/);
    expect(query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO trip_watch_flow'))).toBe(false);
  });

  it('отбой после тревоги уходит тем, кого встревожили: дежурному и контакту', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'reg-1', route_name: 'Чёртов мост', expected_return_at: null }] }) // открытые
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                                                          // UPDATE
      .mockResolvedValueOnce({ rows: [{ route_name: 'Чёртов мост', leader_name: 'Иван', contact_tg: null }] })  // контроль
      .mockResolvedValueOnce({ rows: [{ channel: 'admin_only', recipient: 'admin' }, { channel: 'email', recipient: 'm@x.ru' }] });
    await handleWatchMessage({ channel: 'tg', chatId: 5, text: 'вернулся', userName: null, reply, now: NOW });
    expect(tgSend).toHaveBeenCalledTimes(1);
    expect(String(tgSend.mock.calls[0]?.[1])).toMatch(/Отбой тревоги: Иван вернулся/);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('не встревожили никого — отбоя никому не шлём', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'reg-1', route_name: 'x', expected_return_at: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ route_name: 'x', leader_name: 'Иван', contact_tg: null }] })
      .mockResolvedValueOnce({ rows: [] });
    await handleWatchMessage({ channel: 'tg', chatId: 5, text: 'вернулся', userName: null, reply, now: NOW });
    expect(tgSend).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('«вернулся» закрывает открытый контроль этого чата с пометкой chat', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'reg-1', route_name: 'Чёртов мост', expected_return_at: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await handleWatchMessage({ channel: 'max', chatId: 7, text: 'вернулся', userName: null, reply, now: NOW });
    const upd = query.mock.calls[1];
    expect(String(upd[0])).toContain('completed_at = now()');
    expect(upd[1]).toEqual(['reg-1', 'chat']);
    expect(replies.at(-1)).toMatch(/С возвращением/);
  });
});

describe('сторож будит туриста первым', () => {
  it('текст называет срок по Камчатке, слова отметки и когда сообщат контакту', () => {
    const t = buildTouristWakeMessage({ routeName: 'Чёртов мост', controlTime: new Date('2026-09-30T07:00:00Z'), contactName: 'Марина', hoursUntilContact: 2, contactByDuty: true });
    expect(t).toContain('30.09 19:00 (камч.)');
    expect(t).toContain('«вернулся»');
    expect(t).toContain('«задерживаюсь»');
    expect(t).toContain('примерно через 2 ч дежурный Ведара позвонит Марина');
    const viaBot = buildTouristWakeMessage({ routeName: 'x', controlTime: new Date(), contactName: 'Марина', hoursUntilContact: 2, contactByDuty: false });
    expect(viaBot).toContain('я сообщу Марина');
  });

  it('checkin-watchdog: soft у контроля из чата — туристу, контакту только если не дошло', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/cron/checkin-watchdog/route.ts'), 'utf-8');
    expect(src).toMatch(/step === 'soft' && reg\.tourist_chat_channel/);
    expect(src).toMatch(/if \(!woke\) await notifyContact/);
  });

  it('процессор сообщений зовёт контроль раньше брони', () => {
    const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');
    const watch = core.indexOf('handleWatchMessage({');
    const booking = core.indexOf('loadBookingFlow(chatId, mode, pendingMap)');
    expect(watch).toBeGreaterThan(0);
    expect(watch).toBeLessThan(booking);
  });
});
