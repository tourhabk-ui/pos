/**
 * Контроль выхода из чата Кузьмича в MAX — lib/kuzmich/watch-flow.ts.
 *
 * Держит правило 3 манифеста (docs/safety/WATCH_MANIFEST.md): включает,
 * закрывает и отодвигает контроль только явное слово человека, разобранное
 * кодом и пришедшее заверенным путём; срок — камчатский; не разобрали —
 * переспросили, а не угадали.
 *
 * Каждое замечание трёх критиков 30.09 держит здесь свой тест: поддельное
 * «вернулся», «вернулся», закрывший завтрашний поход, однодневка накануне
 * вечером как многодневка, двойное «да», отбой, разминувшийся со ступенью,
 * лестница назад, «задерживаюсь» с пустым обещанием, выдуманная группа из
 * одного, телефоны в Telegram вопреки политике конфиденциальности.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type QueryResult = { rows: unknown[]; rowCount?: number };
const query = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => query(sql, params) } }));

const tgSend = vi.fn<(scope: string, text: string) => Promise<{ ok: true }>>(async () => ({ ok: true }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (scope: string, text: string) => tgSend(scope, text) }));

type Mail = { to: string; subject: string; text: string };
const sendEmail = vi.fn<(m: Mail) => Promise<{ success: boolean }>>(async () => ({ success: true }));
vi.mock('@/lib/email', () => ({ sendEmail: (m: Mail) => sendEmail(m) }));

type PdParams = { text: string; stub: string };
type PdResult = { channel: 'max' | 'telegram-stub' | 'none'; delivered: boolean; reason: string };
const sendPdAlert = vi.fn<(p: PdParams) => Promise<PdResult>>(
  async () => ({ channel: 'max', delivered: true, reason: 'доставлено в MAX' }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (p: PdParams) => sendPdAlert(p) }));

type TgMessage = { chatId: string; text: string };
const tgService = vi.fn<(m: TgMessage) => Promise<{ success: boolean }>>(async () => ({ success: true }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: (m: TgMessage) => tgService(m) } }));

import {
  isWatchTrigger, isReturnedCommand, isDelayedCommand, isConfirm, isCancel, isNearMissCheckin,
  extractPhone, extractDestination, extractContactName, parseReturn, returnSegment, parseGroupSize,
  parseExtension, tripKindFor, draftFromTrigger, advanceDraft, watchSummary, contactForwardText,
  handleWatchMessage, chatAllowed, telegramWatchRedirect, WATCH_MAX_OPEN_PER_CHAT, WATCH_DISCLAIMER,
  type WatchDraft,
} from '@/lib/kuzmich/watch-flow';
import { buildTouristWakeMessage, decideEscalation, formatPositionText } from '@/lib/safety/checkin-escalation';

// 30.09.2026 10:00 по Камчатке = 29.09 22:00 UTC.
const NOW = new Date('2026-09-29T22:00:00Z');
// 30.09.2026 20:00 по Камчатке — час после срока 19:00.
const LATER = new Date('2026-09-30T08:00:00Z');
// 30.09.2026 19:00 по Камчатке.
const DUE_19 = new Date('2026-09-30T07:00:00Z');

const FULL: WatchDraft = {
  step: 'confirm', where: 'Чёртов мост', returnDate: '2026-09-30', returnTime: '19:00',
  contactPhone: '+79141234567', contactName: 'Марина', leaderPhone: '+79146245651', groupSize: 2,
  startedAt: NOW.getTime(), touchedAt: NOW.getTime(),
};

const replies: string[] = [];
const reply = async (_: number, t: string) => { replies.push(t); };
function msg(text: string, over: { verified?: boolean; now?: Date; chatId?: number } = {}) {
  return {
    channel: 'max' as const, chatId: over.chatId ?? 5, text, userName: 'Иван', reply,
    verified: over.verified ?? true, now: over.now ?? NOW,
  };
}
const sqlCalls = (needle: string) => query.mock.calls.filter((c) => String(c[0]).includes(needle));
function openRow(o: Partial<{ id: string; route_name: string; expected_return_at: Date | null; emergency_contact_name: string; last_step: number; alerted_others: boolean }> = {}) {
  return {
    id: 'reg-1', route_name: 'Чёртов мост', expected_return_at: DUE_19, emergency_contact_name: 'Марина',
    last_step: 0, alerted_others: false, ...o,
  };
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

beforeEach(() => {
  query.mockReset();
  tgSend.mockClear(); sendEmail.mockClear(); sendPdAlert.mockClear(); tgService.mockClear();
  replies.length = 0;
  process.env.TRIP_WATCH_MAX_CHATS = '5';
});
afterEach(() => { delete process.env.TRIP_WATCH_MAX_CHATS; });

describe('слова человека — только сообщением целиком', () => {
  it('«вернулся» закрывает, «я не вернулся» — нет', () => {
    expect(isReturnedCommand('Вернулся!')).toBe(true);
    expect(isReturnedCommand('мы вернулись.')).toBe(true);
    expect(isReturnedCommand('я не вернулся')).toBe(false);
    expect(isReturnedCommand('вернулся бы, да дождь')).toBe(false);
    expect(isReturnedCommand('вернулся, всё ок')).toBe(false);
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

  it('похожее на отметку — узнаётся, чтобы переспросить, а не отдать модели', () => {
    expect(isNearMissCheckin('вернулся, всё ок')).toBe(true);
    expect(isNearMissCheckin('я дома')).toBe(true);
    expect(isNearMissCheckin('задержусь немного')).toBe(true);
    expect(isNearMissCheckin('какая погода на Авачинском?')).toBe(false);
  });
});

describe('разбор', () => {
  it('телефон: +7, 8, скобки и дефисы — к +7XXXXXXXXXX', () => {
    expect(extractPhone('маме +7 (914) 123-45-67')).toBe('+79141234567');
    expect(extractPhone('89146245651')).toBe('+79146245651');
    expect(extractPhone('в 19:00')).toBeNull();
    expect(extractPhone('ИНН 4100039249')).toBeNull();
  });

  it('иностранный номер не упирается в «не нашёл телефон»', () => {
    expect(extractPhone('mom +49 151 2345 6789')).toBe('+4915123456789');
    expect(extractPhone('+1 (415) 555-0132')).toBe('+14155550132');
    expect(extractContactName('Mom +49 151 2345 6789')).toBe('Mom');
  });

  it('куда: из «еду на …», без хвоста про срок', () => {
    expect(extractDestination('еду на Чёртов мост, вернусь к 19:00')).toBe('Чёртов мост');
    expect(extractDestination('Иду на Авачинский перевал до 18:00')).toBe('Авачинский перевал');
    expect(extractDestination('привет')).toBeNull();
  });

  it('куда: разбор линейный — строка из 50 тысяч пробелов не вешает поток (CodeQL js/polynomial-redos)', () => {
    const t0 = Date.now();
    expect(extractDestination(`еду на${'\t'.repeat(50_000)}!`)).toBeNull();
    expect(extractDestination(`еду на ${' a'.repeat(50_000)}`)).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('имя контакта без телефона и служебных слов', () => {
    expect(extractContactName('Марина +7 914 123-45-67')).toBe('Марина');
    expect(extractContactName('сообщите по номеру +79141234567')).toBeNull();
  });

  it('срок — камчатский: «сегодня 19:00» = 07:00 UTC', () => {
    expect(parseReturn('сегодня 19:00', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '19:00' });
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

  it('«через 3 часа» — от этой минуты; «через пару часов» и «в субботу» — переспрос', () => {
    expect(parseReturn('через 3 часа', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '13:00' });
    expect(parseReturn('через 40 минут', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '10:40' });
    expect(parseReturn('через пару часов', NOW)).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseReturn('в субботу к 18', NOW)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('«к 5» без утра и вечера — переспрос: в 04:30 перед ранним выходом это 05:00, а не 17:00', () => {
    expect(parseReturn('вернусь к 5', NOW)).toEqual({ ok: false, reason: 'ampm', hour: 5 });
    expect(parseReturn('к 5 вечера', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '17:00' });
    expect(parseReturn('завтра к 5 утра', NOW)).toEqual({ ok: true, date: '2026-10-01', time: '05:00' });
    expect(parseReturn('к 17', NOW)).toEqual({ ok: true, date: '2026-09-30', time: '17:00' });
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

  it('сколько вас — числом или словом; ноль и толпа — переспрос', () => {
    expect(parseGroupSize('4')).toBe(4);
    expect(parseGroupSize('нас 4')).toBe(4);
    expect(parseGroupSize('4 человека')).toBe(4);
    expect(parseGroupSize('Вдвоём')).toBe(2);
    expect(parseGroupSize('я один')).toBe(1);
    expect(parseGroupSize('0')).toBeNull();
    expect(parseGroupSize('31')).toBeNull();
    expect(parseGroupSize('много')).toBeNull();
  });

  it('новый срок — только сообщением целиком; «до завтра» — прощание, а не срок', () => {
    expect(parseExtension('+2 ч')).toEqual({ kind: 'relative', minutes: 120 });
    expect(parseExtension('+30 мин')).toEqual({ kind: 'relative', minutes: 30 });
    expect(parseExtension('продли на 2 часа')).toEqual({ kind: 'relative', minutes: 120 });
    expect(parseExtension('задержусь на час')).toEqual({ kind: 'relative', minutes: 60 });
    expect(parseExtension('на полчаса')).toEqual({ kind: 'relative', minutes: 30 });
    expect(parseExtension('+5 мин')).toBeNull();
    expect(parseExtension('до 21:00')).toEqual({ kind: 'absolute', text: 'до 21:00' });
    expect(parseExtension('продли до завтра 9 утра')).toEqual({ kind: 'absolute', text: 'до завтра 9 утра' });
    expect(parseExtension('до завтра')).toBeNull();
    expect(parseExtension('до встречи')).toBeNull();
    expect(parseExtension('ок')).toBeNull();
    expect(parseExtension('+2 ч!!!')).toEqual({ kind: 'relative', minutes: 120 });
    expect(parseExtension('до 21:00.')).toEqual({ kind: 'absolute', text: 'до 21:00' });
  });

  it('новый срок: разбор линейный — строка из 50 тысяч «!» не вешает поток (CodeQL js/polynomial-redos)', () => {
    const t0 = Date.now();
    expect(parseExtension(`${'!'.repeat(50_000)}x`)).toBeNull();
    expect(parseExtension(`+2 ч${'!'.repeat(50_000)}`)).toBeNull();
    expect(telegramWatchRedirect(`${'!'.repeat(50_000)}x`)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('однодневка — по длительности: поставленная накануне вечером тоже однодневка', () => {
    const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
    expect(tripKindFor(at(9), NOW)).toBe('day');
    expect(tripKindFor(at(23), NOW)).toBe('day');
    expect(tripKindFor(at(25), NOW)).toBe('multi');
  });
});

describe('черновик и итог', () => {
  it('из первой фразы забирается названное, спрашивается недостающее', () => {
    const d = draftFromTrigger('Еду на Чёртов мост, вернусь сегодня к 19:00, если задержусь — сообщите +7 914 123-45-67', NOW, 1);
    expect(d).toMatchObject({ where: 'Чёртов мост', returnDate: '2026-09-30', returnTime: '19:00', contactPhone: '+79141234567', step: 'contact_name' });
  });

  it('свой телефон не может совпасть с телефоном контакта', () => {
    const d: WatchDraft = { ...FULL, step: 'leader_phone', leaderPhone: undefined };
    const r = advanceDraft(d, '+7 914 123 45 67', NOW);
    expect(r.draft.step).toBe('leader_phone');
    expect(r.reply).toMatch(/номер контакта/);
  });

  it('размер группы спрашивается, а не выдумывается единицей', () => {
    const d: WatchDraft = { ...FULL, step: 'leader_phone', leaderPhone: undefined, groupSize: undefined };
    const r = advanceDraft(d, '+7 914 624 56 51', NOW);
    expect(r.draft.step).toBe('group');
    expect(r.reply).toMatch(/Сколько вас/);
    const r2 = advanceDraft(r.draft, 'много', NOW);
    expect(r2.draft.step).toBe('group');
    const r3 = advanceDraft(r2.draft, 'нас 3', NOW);
    expect(r3.draft).toMatchObject({ step: 'confirm', groupSize: 3 });
  });

  it('вопрос вместо ответа не становится маршрутом', () => {
    const d: WatchDraft = { step: 'where', startedAt: 1 };
    const r = advanceDraft(d, 'а какая там погода?', NOW);
    expect(r.draft.where).toBeUndefined();
    expect(r.reply).toMatch(/Сначала закончим с контролем/);
  });

  it('каждый ответ продлевает жизнь черновика', () => {
    const d: WatchDraft = { step: 'where', startedAt: 1, touchedAt: 1 };
    expect(advanceDraft(d, 'Чёртов мост', NOW).draft.touchedAt).toBe(NOW.getTime());
    expect(advanceDraft(d, 'а погода?', NOW).draft.touchedAt).toBe(NOW.getTime());
  });

  it('итог называет лестницу абсолютными часами, кто несёт каждую ступень и что спасателей зовёт человек', () => {
    const s = watchSummary({ ...FULL, where: 'Чёртов <b>мост</b>' }, NOW);
    expect(s).toContain('19:00 по камчатскому времени (через 9 ч)');
    expect(s).toContain('- в 20:00 напишу вам сюда;');
    // До SMS контакту звонит человек — бот этого не обещает от своего имени.
    expect(s).toContain('- в 22:00 попрошу дежурного Ведара позвонить вашему контакту;');
    expect(s).not.toMatch(/сообщу Марина/);
    expect(s).toContain('- завтра в 03:00 дежурный получит тревогу и решит, звать ли спасателей');
    expect(s).toContain('Сам автомат спасателей не вызывает');
    expect(s).toContain('Дежурный один');
    expect(s).toContain('до двух часов');
    expect(s).toContain('Назовите реальное время, без запаса');
    expect(s).toContain('Сколько вас: 2');
    expect(s).toContain(WATCH_DISCLAIMER);
    expect(s).toContain('Чёртов &lt;b&gt;мост&lt;/b&gt;');
  });

  it('многодневка — буферы многодневки, с датами', () => {
    const s = watchSummary({ ...FULL, returnDate: '2026-10-03', returnTime: '18:00' }, NOW);
    expect(s).toContain('- 03.10 в 21:00 напишу вам сюда;');
    expect(s).toContain('- 04.10 в 00:00 попрошу дежурного');
    expect(s).toContain('- 04.10 в 12:00 дежурный получит тревогу');
  });

  it('текст для контакта — с датой числом: пересланное «завтра», прочитанное назавтра, указало бы не тот день', () => {
    const t = contactForwardText({ ...FULL, where: 'Чёртов <b>мост</b>' }, DUE_19, new Date('2026-09-30T10:00:00Z'));
    expect(t).toContain('Вернусь к 30.09 19:00 (камчатское время)');
    expect(t).toContain('Если до 30.09 22:00 я не напишу тебе, что вернулся, — позвони мне: +79146245651');
    expect(t).toContain('звони 112');
    expect(t).toContain(', нас 2');
    expect(t).toContain('Чёртов &lt;b&gt;мост&lt;/b&gt;');
    expect(t).not.toMatch(/завтра|сегодня/);
  });
});

describe('двери: только MAX, только заверенный апдейт, только чаты испытаний', () => {
  it('незаверенный апдейт не трогает базу: поддельное «вернулся» не закроет чужой контроль', async () => {
    expect(await handleWatchMessage(msg('вернулся', { verified: false }))).toBe(true);
    expect(replies.at(-1)).toMatch(/Не могу подтвердить, что это сообщение пришло из MAX/);
    expect(query).not.toHaveBeenCalled();
    replies.length = 0;
    expect(await handleWatchMessage(msg('+2 ч', { verified: false }))).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('незаверенный обычный вопрос уходит в разговор без ответа отсюда', async () => {
    expect(await handleWatchMessage(msg('какая погода на Авачинском?', { verified: false }))).toBe(false);
    expect(replies).toHaveLength(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('список испытаний: не задан — никому, «*» — всем, иначе по номерам', () => {
    process.env.TRIP_WATCH_MAX_CHATS = '';
    expect(chatAllowed(5)).toBe(false);
    process.env.TRIP_WATCH_MAX_CHATS = '*';
    expect(chatAllowed(5)).toBe(true);
    process.env.TRIP_WATCH_MAX_CHATS = '7, 5';
    expect(chatAllowed(5)).toBe(true);
    expect(chatAllowed(55)).toBe(false);
  });

  it('чат вне испытаний получает ссылку на форму и свой номер, черновик не заводится', async () => {
    process.env.TRIP_WATCH_MAX_CHATS = '7';
    query.mockResolvedValueOnce({ rows: [] }); // черновика нет
    expect(await handleWatchMessage(msg('поставь меня на контроль'))).toBe(true);
    expect(replies.at(-1)).toMatch(/в испытаниях/);
    expect(replies.at(-1)).toContain('Номер этого чата для испытаний: 5');
    expect(sqlCalls('INSERT INTO trip_watch_flow')).toHaveLength(0);
  });

  it('Telegram: контроль не ставится — ответ, где его поставить, и что телефонов там не собираем', () => {
    const r = telegramWatchRedirect('еду на Чёртов мост, если задержусь — сообщите маме +7 914 123-45-67');
    expect(r).toContain('https://max.ru/');
    expect(r).toContain('vedarai.ru/register');
    expect(r).toContain('Телефоны в Telegram мы не собираем');
    expect(telegramWatchRedirect('вернулся')).not.toBeNull();
    expect(telegramWatchRedirect('какая погода?')).toBeNull();
  });
});

describe('handleWatchMessage', () => {
  it('обычный вопрос — не про контроль, отдаётся дальше', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await handleWatchMessage(msg('какая погода на Авачинском?'))).toBe(false);
  });

  it('первая фраза заводит черновик и спрашивает недостающее', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })   // черновика нет
      .mockResolvedValueOnce({ rows: [] })   // открытых контролей нет
      .mockResolvedValueOnce({ rows: [] });  // черновик записан
    const text = 'Еду на Чёртов мост, вернусь сегодня к 19:00, если задержусь — сообщите +7 914 123-45-67';
    expect(await handleWatchMessage(msg(text))).toBe(true);
    const save = sqlCalls('INSERT INTO trip_watch_flow')[0];
    expect(save?.[1]?.[0]).toBe('max');
    expect(JSON.parse(String(save?.[1]?.[2]))).toMatchObject({ where: 'Чёртов мост', step: 'contact_name' });
    expect(replies.at(-1)).toMatch(/Как зовут человека/);
  });

  it('«да» забирает черновик ровно один раз и создаёт контроль MAX с камчатским сроком', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ state: FULL }] })   // черновик прочитан
      .mockResolvedValueOnce({ rows: [{ state: FULL }] })   // DELETE … RETURNING
      .mockResolvedValueOnce({ rows: [{ id: 'reg-1' }] });  // INSERT
    expect(await handleWatchMessage(msg('да'))).toBe(true);
    const claim = sqlCalls('DELETE FROM trip_watch_flow');
    expect(claim).toHaveLength(1);
    expect(String(claim[0]?.[0])).toContain('RETURNING state');
    const insert = sqlCalls('INSERT INTO route_registrations')[0];
    const p = insert?.[1] ?? [];
    expect(p[6]).toBe(2);                                                  // группа — названная, не выдуманная
    expect((p[17] as Date).toISOString()).toBe('2026-09-30T07:00:00.000Z'); // 19:00 по Камчатке
    expect(p[18]).toBe('day');
    expect(p.slice(19)).toEqual(['max', 'max', 5]);
    expect(replies.at(-1)).toContain('Контроль включён. Жду вас к 19:00 (камчатское время).');
    expect(replies.at(-1)).toContain('Если до 30.09 22:00 я не напишу тебе');
  });

  it('однодневка, поставленная накануне вечером, — однодневка, а не многодневка', async () => {
    const eve = new Date('2026-09-29T10:00:00Z'); // 29.09 22:00 по Камчатке
    const draft: WatchDraft = { ...FULL, startedAt: eve.getTime(), touchedAt: eve.getTime() };
    query
      .mockResolvedValueOnce({ rows: [{ state: draft }] })
      .mockResolvedValueOnce({ rows: [{ state: draft }] })
      .mockResolvedValueOnce({ rows: [{ id: 'reg-1' }] });
    await handleWatchMessage(msg('да', { now: eve }));
    expect(sqlCalls('INSERT INTO route_registrations')[0]?.[1]?.[18]).toBe('day');
  });

  it('второе «да» после забранного черновика контроль не дублирует', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ state: FULL }] })   // прочитал до того, как первый забрал
      .mockResolvedValueOnce({ rows: [] });                 // забирать уже нечего
    expect(await handleWatchMessage(msg('да'))).toBe(true);
    expect(sqlCalls('INSERT INTO route_registrations')).toHaveLength(0);
    expect(replies.at(-1)).toMatch(/Черновика нет/);
  });

  it('сбой записи — честный отказ, а не «включён», и черновик возвращается', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ state: FULL }] })
      .mockResolvedValueOnce({ rows: [{ state: FULL }] })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '23502' }))
      .mockResolvedValueOnce({ rows: [] });                 // черновик возвращён
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleWatchMessage(msg('да'));
    expect(replies.at(-1)).toMatch(/Не получилось включить контроль/);
    expect(replies.join('\n')).not.toMatch(/Контроль включён/);
    expect(sqlCalls('INSERT INTO trip_watch_flow')).toHaveLength(1);
    spy.mockRestore();
  });

  it('черновик не прочитан, а человек ответил «да» — честный отказ, а не ответ модели', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await handleWatchMessage(msg('да'))).toBe(true);
    expect(replies.at(-1)).toMatch(/Не получилось прочитать черновик/);
    spy.mockRestore();
  });

  it('черновик живёт полчаса от последнего ответа, а не от начала', async () => {
    const alive: WatchDraft = { ...FULL, startedAt: NOW.getTime() - 2 * 3_600_000, touchedAt: NOW.getTime() - 10 * 60_000 };
    query
      .mockResolvedValueOnce({ rows: [{ state: alive }] })
      .mockResolvedValueOnce({ rows: [{ state: alive }] })
      .mockResolvedValueOnce({ rows: [{ id: 'reg-1' }] });
    await handleWatchMessage(msg('да'));
    expect(sqlCalls('INSERT INTO route_registrations')).toHaveLength(1);

    query.mockReset();
    const stale: WatchDraft = { ...FULL, touchedAt: NOW.getTime() - 31 * 60_000 };
    query.mockResolvedValue({ rows: [] }).mockResolvedValueOnce({ rows: [{ state: stale }] });
    expect(await handleWatchMessage(msg('да'))).toBe(false);
    expect(sqlCalls('DELETE FROM trip_watch_flow')).toHaveLength(1);
    expect(sqlCalls('INSERT INTO route_registrations')).toHaveLength(0);
  });

  it('сообщение о беде черновик не проглатывает — оно уходит в обычный путь с SOS-блоком', async () => {
    const draft: WatchDraft = { step: 'return', where: 'Чёртов мост', startedAt: NOW.getTime(), touchedAt: NOW.getTime() };
    query.mockResolvedValueOnce({ rows: [{ state: draft }] });
    expect(await handleWatchMessage(msg('помогите, сломал ногу'))).toBe(false);
    expect(replies).toHaveLength(0);
    expect(sqlCalls('INSERT INTO trip_watch_flow')).toHaveLength(0);
  });

  it(`больше ${WATCH_MAX_OPEN_PER_CHAT} открытых контролей из одного чата не ставится`, async () => {
    const open = Array.from({ length: WATCH_MAX_OPEN_PER_CHAT }, (_, i) => openRow({ id: `r${i}` }));
    query
      .mockResolvedValueOnce({ rows: [] })        // черновика нет
      .mockResolvedValueOnce({ rows: open });     // открытые контроли чата
    await handleWatchMessage(msg('поставь меня на контроль'));
    expect(replies.at(-1)).toMatch(/больше из одного чата не ставлю/);
    expect(sqlCalls('INSERT INTO trip_watch_flow')).toHaveLength(0);
  });
});

describe('«вернулся», новый срок, «задерживаюсь»', () => {
  it('«вернулся» закрывает контроль, у которого подошёл срок, — не завтрашний поход', async () => {
    const today = openRow({ id: 'reg-today' });
    const tomorrow = openRow({ id: 'reg-tomorrow', route_name: 'Мутновский', expected_return_at: new Date('2026-10-01T19:00:00Z') });
    query
      .mockResolvedValueOnce({ rows: [today, tomorrow] })                   // открытые
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                     // UPDATE закрытия
      .mockResolvedValueOnce({ rows: [{ route_name: 'Чёртов мост', leader_name: 'Иван', contact_tg: null, mchs_sent: false }] })
      .mockResolvedValueOnce({ rows: [] });                                 // тревог не было
    await handleWatchMessage(msg('вернулся', { now: LATER }));
    const updates = sqlCalls('completed_at = now()');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[1]).toEqual(['reg-today', 'chat', 'returned']);
    expect(replies.at(-1)).toContain('С возвращением! Контроль «Чёртов мост» закрыт');
    expect(replies.at(-1)).toContain('Напишите Марина, что вы дома');
    expect(replies.at(-1)).toMatch(/МЧС/);
  });

  it('ни один не подошёл к сроку — список и «отменить контроль», ничего не закрыто', async () => {
    const a = openRow({ id: 'a', expected_return_at: new Date('2026-10-01T19:00:00Z') });
    const b = openRow({ id: 'b', expected_return_at: new Date('2026-10-02T19:00:00Z') });
    query.mockResolvedValueOnce({ rows: [a, b] });
    await handleWatchMessage(msg('вернулся', { now: LATER }));
    expect(sqlCalls('completed_at = now()')).toHaveLength(0);
    expect(replies.at(-1)).toMatch(/Ни один открытый контроль ещё не подошёл к сроку/);
    expect(replies.at(-1)).toMatch(/отменить контроль/);
  });

  it('сегодняшний срок закрывается «вернулся» и до срока: вернулся раньше', async () => {
    query
      .mockResolvedValueOnce({ rows: [openRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });                                  // контроль не найден для вести
    await handleWatchMessage(msg('вернулся'));
    expect(sqlCalls('completed_at = now()')[0]?.[1]).toEqual(['reg-1', 'chat', 'returned']);
    expect(replies.at(-1)).toMatch(/С возвращением/);
  });

  it('единственный контроль на завтра «вернулся» не закрывает: сегодня ходили без контроля', async () => {
    query.mockResolvedValueOnce({ rows: [openRow({ expected_return_at: new Date('2026-10-01T07:00:00Z') })] });
    await handleWatchMessage(msg('вернулся'));
    expect(sqlCalls('completed_at = now()')).toHaveLength(0);
    expect(replies.at(-1)).toMatch(/ещё не подошёл к сроку/);
    expect(replies.at(-1)).toMatch(/завтра 19:00/);
  });

  it('«+2 ч» после срока: новый срок от этой минуты, лестница заново с вопроса туристу', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })                                   // черновика нет
      .mockResolvedValueOnce({ rows: [openRow({ last_step: 1 })] })          // будили только туриста
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // UPDATE продления
      .mockResolvedValueOnce({ rows: [{ route_name: 'Чёртов мост', leader_name: 'Иван', contact_tg: null, mchs_sent: false }] })
      .mockResolvedValueOnce({ rows: [{ channel: 'max', recipient: 'tourist' }] });
    await handleWatchMessage(msg('+2 ч', { now: LATER }));
    const upd = sqlCalls('ladder_reset_at = now()')[0];
    expect(String(upd?.[0])).toContain('checkin_confirmed_at = NULL');
    expect((upd?.[1]?.[1] as Date).toISOString()).toBe('2026-09-30T10:00:00.000Z'); // 22:00 по Камчатке
    expect(upd?.[1]?.slice(2)).toEqual(['2026-09-30', 'day']);
    expect(replies.at(-1)).toContain('Новый срок «Чёртов мост» — 22:00.');
    expect(replies.at(-1)).toContain('Не отметитесь — в 23:00 напишу вам сюда');
    // Будили только самого туриста — «тем, кого встревожили, я сообщил» было бы неправдой.
    expect(replies.at(-1)).not.toMatch(/Тем, кого уже встревожили/);
    expect(sendPdAlert).not.toHaveBeenCalled();
  });

  it('«до 21:00» после тревоги контакту — весть дежурному, и туристу сказано, что весть ушла', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [openRow({ last_step: 2, alerted_others: true })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ route_name: 'Чёртов мост', leader_name: 'Иван', contact_tg: null, mchs_sent: false }] })
      .mockResolvedValueOnce({ rows: [{ channel: 'admin_only', recipient: 'admin' }] });
    await handleWatchMessage(msg('до 21:00', { now: LATER }));
    expect((sqlCalls('ladder_reset_at = now()')[0]?.[1]?.[1] as Date).toISOString()).toBe('2026-09-30T09:00:00.000Z');
    expect(sendPdAlert).toHaveBeenCalledTimes(1);
    expect(sendPdAlert.mock.calls[0]?.[0].text).toMatch(/назначил новый срок/);
    expect(replies.at(-1)).toMatch(/Тем, кого уже встревожили, я сообщил/);
  });

  it('«задерживаюсь» до срока ничего не сдвигает и не обещает — просит новое время', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [openRow()] });
    await handleWatchMessage(msg('задерживаюсь'));
    expect(sqlCalls('UPDATE route_registrations')).toHaveLength(0);
    expect(replies.at(-1)).toMatch(/ещё не наступил — 19:00/);
    expect(replies.at(-1)).toMatch(/«\+2 ч»/);
  });

  it('«задерживаюсь» после срока отмечает «на связи» и всё равно просит срок', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [openRow({ last_step: 1 })] })
      .mockResolvedValueOnce({ rows: [{ id: 'reg-1' }] })                   // checkin_confirmed_at
      .mockResolvedValueOnce({ rows: [{ route_name: 'Чёртов мост', leader_name: 'Иван', contact_tg: null, mchs_sent: false }] })
      .mockResolvedValueOnce({ rows: [] });
    await handleWatchMessage(msg('задерживаюсь', { now: LATER }));
    expect(sqlCalls('checkin_confirmed_at = now()')).toHaveLength(1);
    expect(replies.at(-1)).toMatch(/Отметил: вы на связи/);
    expect(replies.at(-1)).toMatch(/назовите новый срок/);
  });

  it('похожее на отметку при открытом контроле — переспрос кодом, а не ответ модели', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [openRow()] });
    expect(await handleWatchMessage(msg('вернулся, всё ок', { now: LATER }))).toBe(true);
    expect(replies.at(-1)).toMatch(/Это про контроль «Чёртов мост»\?/);
    expect(sqlCalls('completed_at = now()')).toHaveLength(0);
  });
});

describe('отбой — тем, кого встревожили, и по правилам о ПД', () => {
  it('дежурному — данные только в MAX, в Telegram — заглушка без имени; контакту — письмом', async () => {
    query
      .mockResolvedValueOnce({ rows: [openRow({ id: 'a1b2c3d4-0000-0000-0000-000000000000' })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ route_name: 'Чёртов мост', leader_name: 'Иван', contact_tg: null, mchs_sent: true }] })
      .mockResolvedValueOnce({ rows: [
        { channel: 'admin_only', recipient: 'admin' },
        { channel: 'email', recipient: 'm@x.ru' },
        { channel: 'max', recipient: 'tourist' },
      ] });
    await handleWatchMessage(msg('вернулся', { now: LATER }));
    expect(sendPdAlert).toHaveBeenCalledTimes(1);
    const { text, stub } = sendPdAlert.mock.calls[0]![0];
    expect(text).toMatch(/Отбой тревоги: турист Иван вернулся/);
    expect(stub).toContain('дело a1b2c3d4');
    expect(stub).not.toMatch(/Иван|Чёртов|\+7/);
    expect(tgSend).toHaveBeenCalledTimes(1);
    expect(String(tgSend.mock.calls[0]?.[1])).not.toMatch(/Иван|Чёртов|\+7/);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(tgService).not.toHaveBeenCalled();
  });

  it('«отменить контроль» после тревоги — не «вернулся, искать не нужно», а просьба дозвониться', async () => {
    query
      .mockResolvedValueOnce({ rows: [openRow({ alerted_others: true })] })   // открытые
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                         // UPDATE закрытия
      .mockResolvedValueOnce({ rows: [{ route_name: 'Чёртов мост', leader_name: 'Иван', contact_tg: null, mchs_sent: false }] })
      .mockResolvedValueOnce({ rows: [{ channel: 'admin_only', recipient: 'admin' }] });
    await handleWatchMessage(msg('отменить контроль', { now: LATER }));
    expect(sqlCalls('completed_at = now()')[0]?.[1]).toEqual(['reg-1', 'chat', 'cancelled']);
    const { text } = sendPdAlert.mock.calls[0]![0];
    expect(text).toMatch(/снял контроль маршрута «Чёртов мост»/);
    expect(text).toMatch(/не написал, что вернулся/);
    expect(text).toMatch(/дозвонитесь до туриста/);
    expect(text).not.toMatch(/Искать не нужно|Отбой тревоги/);
    expect(replies.at(-1)).toMatch(/Тем, кого уже встревожили, я сообщил, что вы сняли контроль/);
  });

  it('сторож догоняет закрытие вестью по записанной причине; причины нет — так и сказано', () => {
    const src = read('app/api/cron/checkin-watchdog/route.ts');
    expect(src).toMatch(/SELECT completed_at, closed_by, closed_reason FROM route_registrations/);
    expect(src).toMatch(/closed\.closed_reason === 'returned' \|\| closed\.closed_reason === 'cancelled' \? closed\.closed_reason : null/);
    const tw = read('lib/safety/trip-watch.ts');
    expect(tw).toMatch(/причина не записана/);
  });

  it('не встревожили никого, кроме самого туриста, — отбоя никому не шлём', async () => {
    query
      .mockResolvedValueOnce({ rows: [openRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ route_name: 'x', leader_name: 'Иван', contact_tg: null, mchs_sent: false }] })
      .mockResolvedValueOnce({ rows: [{ channel: 'max', recipient: 'tourist' }] });
    await handleWatchMessage(msg('вернулся'));
    expect(sendPdAlert).not.toHaveBeenCalled();
    expect(tgSend).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('сторож: лестница, очередь, отбой вдогонку', () => {
  const src = read('app/api/cron/checkin-watchdog/route.ts');

  it('soft у контроля из чата — туристу, контакту только если не дошло', () => {
    expect(src).toMatch(/step === 'soft' && reg\.tourist_chat_channel/);
    expect(src).toMatch(/if \(!woke\) await notifyContact/);
  });

  it('дело, дошедшее до дежурного, не занимает очередь: иначе сто забытых отметок заслоняют нового невернувшегося', () => {
    expect(src).toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM route_registration_notifications n\s*WHERE n\.registration_id = r\.id AND n\.step = 3 AND n\.status IN \('sent', 'skipped'\)/);
    expect(src).toMatch(/LIMIT \$3/);
    expect(src).toMatch(/\[now, now, WATCHDOG_BATCH\]/);
    expect(src).toMatch(/const tail = rows\.length === WATCHDOG_BATCH/);
    expect(src).toMatch(/problems \? 'failed' : 'success'/);
  });

  it('после продления пройденными считаются только шаги после ladder_reset_at', () => {
    expect(src).toMatch(/n\.sent_at >= r\.ladder_reset_at/);
  });

  it('дежурному — только через alertDuty (данные в MAX), а не прямым сообщением в Telegram', () => {
    expect(src).toMatch(/alertDuty\(`МЧС-ТРЕВОГА/);
    expect(src).not.toMatch(/TELEGRAM_CHAT_ID|TELEGRAM_ADMIN_CHAT_ID|sendTelegram\(adminChatId/);
  });

  it('турист закрыл контроль, пока уходил шаг, — отбой догоняет этот шаг', () => {
    const step = src.indexOf("alertDuty(`МЧС-ТРЕВОГА");
    const recheck = src.indexOf('SELECT completed_at, closed_by, closed_reason FROM route_registrations');
    expect(recheck).toBeGreaterThan(step);
    expect(src.slice(recheck)).toMatch(/await announceClosure\(reg\.id/);
  });

  it('лестница только вверх: после МЧС-ступени младшие не шлются', () => {
    const control = new Date('2026-09-30T07:00:00Z');
    const h = (n: number) => new Date(control.getTime() + n * 3_600_000);
    expect(decideEscalation(control, 'day', ['mchs'], null, h(20))).toBeNull();
    expect(decideEscalation(control, 'day', ['hard'], null, h(4))).toBeNull();
    // Сторож простоял: сразу старшая назревшая ступень.
    expect(decideEscalation(control, 'day', [], null, h(9))?.step).toBe('mchs');
    expect(decideEscalation(control, 'day', ['soft'], null, h(3.5))?.step).toBe('hard');
  });

  it('точка с телефона пишет свой источник — не наследует «трекер» от прошлой точки', () => {
    const pos = read('app/api/safety/position/route.ts');
    expect(pos).toMatch(/last_position_at = now\(\),\s*last_position_source = 'phone'/);
  });

  it('форма не принимает срок в прошлом и частые запросы: иначе поток мгновенных тревог дежурному', () => {
    const reg = read('app/api/safety/register/route.ts');
    expect(reg).toMatch(/const limiter = createRateLimiter\(\{ windowMs: 60_000, max: 5 \}\)/);
    // Предел применяется первым делом, а не только объявлен.
    expect(reg).toMatch(/export async function POST\(request: NextRequest\) \{\s*if \(!limiter\.check\(getClientIp\(request\.headers\)\)\) \{\s*return NextResponse\.json\([^;]*\{ status: 429 \}\);/);
    expect(reg).toMatch(/data\.end_date < today \|\| data\.start_date > data\.end_date/);
    // Проверка стоит ДО записи контроля.
    expect(reg.indexOf('data.end_date < today')).toBeLessThan(reg.indexOf('createTripWatch({'));
  });

  it('позиция — с источником и временем точки', () => {
    expect(formatPositionText('53.0195', '158.6505', 'phone', new Date('2026-09-30T02:20:00Z')))
      .toBe('53.01950° N, 158.65050° E (телефон, 30.09 14:20 (камч.))');
    expect(formatPositionText('53.0195', '158.6505', null, null))
      .toBe('53.01950° N, 158.65050° E (источник не записан, время не записано)');
  });
});

describe('сторож будит туриста первым', () => {
  it('текст называет срок по Камчатке, слова отметки и когда сообщат контакту', () => {
    const t = buildTouristWakeMessage({ routeName: 'Чёртов мост', controlTime: DUE_19, contactName: 'Марина', hoursUntilContact: 2, contactByDuty: true });
    expect(t).toContain('30.09 19:00 (камч.)');
    expect(t).toContain('«вернулся»');
    expect(t).toContain('«+2 ч»');
    expect(t).toContain('«задерживаюсь»');
    expect(t).toContain('примерно через 2 ч дежурный Ведара позвонит Марина');
    const viaBot = buildTouristWakeMessage({ routeName: 'x', controlTime: DUE_19, contactName: 'Марина', hoursUntilContact: 2, contactByDuty: false });
    expect(viaBot).toContain('я сообщу Марина');
  });
});

describe('проводка', () => {
  it('процессор сообщений зовёт контроль раньше брони, и только для MAX с заверенным источником', () => {
    const core = read('lib/kuzmich/core.ts');
    const watch = core.indexOf('handleWatchMessage({');
    const booking = core.indexOf('loadBookingFlow(chatId, mode, pendingMap)');
    expect(watch).toBeGreaterThan(0);
    expect(watch).toBeLessThan(booking);
    expect(core).toMatch(/if \(platform === 'max' && !isMediaMessage\)/);
    expect(core).toMatch(/verified: verifiedOrigin === true/);
    expect(core.indexOf('telegramWatchRedirect(text)')).toBeLessThan(watch);
  });

  it('вебхук MAX передаёт заверенность в каждый вызов processMessage', () => {
    const route = read('app/api/max/kuzmich/route.ts');
    const calls = route.match(/processMessage\(/g)?.length ?? 0;
    const passed = route.match(/verifiedOrigin: opts\?\.verifiedOrigin === true/g)?.length ?? 0;
    expect(calls).toBeGreaterThan(0);
    expect(passed).toBe(calls);
  });

  it('вебхук Telegram отвечает про контроль раньше, чем любой текст с цифрами сочтётся телефоном', () => {
    const tg = read('app/api/telegram/webhook/route.ts');
    const redirect = tg.indexOf('telegramWatchRedirect(text)');
    expect(redirect).toBeGreaterThan(0);
    expect(redirect).toBeLessThan(tg.indexOf('const phoneMatch = text.match'));
  });
});
