/**
 * Очередь после отказа в чате администратора (план «после отказа», этап 3б-2).
 *
 * Очередь менеджера (lib/manager-queue) видна на сайте; здесь — она же в MAX
 * администратора: список с именем и телефоном клиента и кнопки «Взял N».
 * Судится вызовом:
 *  - список: кому звонить, что за заявка и что ответил партнёр — у каждого
 *    ждущего случая; взятые в список не входят; не прочитавшаяся часть очереди
 *    названа сбоем, а «никого нет» сказано только о прочитанном (§4.0);
 *  - длинный список режется по пределу сообщения: кнопка «Взял N» есть только
 *    у случая, строка которого в сообщение вошла, а сколько не вошло — названо;
 *  - ПД: ответ с контактами помечен `pd: true` — по этой отметке он уходит
 *    только в личный MAX администратора, а в Telegram заменяется строкой без
 *    контактов;
 *  - «Взял N» — запись: кнопка подписана, разбирается в род и номер случая и
 *    исполняется только у администратора в личном диалоге; кто взял — аккаунт,
 *    привязанный к этому MAX, а не содержимое кнопки;
 *  - вход: слово «очередь» и кнопка «Очередь после отказа» под «Заявками»;
 *    строка меню администратора остаётся прежней.
 * Запись отметки на настоящем PostgreSQL — tests/integration/request-chat.pg.test.ts
 * (сцена «очередь менеджера»).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ load: vi.fn(), take: vi.fn(), admin: vi.fn(), query: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => h.query(...a) } }));
vi.mock('@/lib/manager-queue/queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/manager-queue/queue')>()),
  loadManagerQueue: (...a: unknown[]) => h.load(...a),
  takeQueueItem: (...a: unknown[]) => h.take(...a),
}));
vi.mock('@/lib/max/admin-link', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/admin-link')>()),
  findMaxAdmin: (...a: unknown[]) => h.admin(...a),
}));

import {
  ADMIN_QUEUE_BUTTONS, ADMIN_QUEUE_NAME_CHARS, ADMIN_QUEUE_TEXT, adminQueueReply, adminTakeText, readAdminQueue, takeFromAdminChat,
} from '@/lib/max/admin-queue';
import { ADMIN_ACTION_TEXT, adminQueueTakePayload, handleAdminPress, parseAdminPress } from '@/lib/max/admin-actions';
import { ADMIN_HELP_TEXT, ADMIN_MAX_MESSAGE_CHARS, adminCommandOf, adminReplyFor, readWaitingLeads } from '@/lib/max/admin-read';
import { isWritePayload, unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { menuRows } from '@/lib/roles/chat-menu';
import { adminMenu, adminMenuHelp, adminQueueButton, parseRoleMenuPress } from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';
import type { ManagerQueue, NoticeItem, StayItem, VehicleItem } from '@/lib/manager-queue/types';

const ADMIN_USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '00000000-0000-4000-8000-000000000001';
const STAY = '22222222-2222-4222-8222-222222222222';

const NOTICE: NoticeItem = {
  kind: 'answer_notice', id: '101', happened_at: '2026-11-12T03:10:00.000Z', partner_name: 'Оператор',
  contact_name: 'Анна', contact_phone: '+79990000001', take: null,
  lead_id: LEAD, lead_status: 'lost', answer: 'decline', decline_reason: 'weather', manager_channel: 'max',
  tour_title: 'Мутновский', date: '2026-12-02', people: 2,
};
const VEHICLE: VehicleItem = {
  kind: 'vehicle_decline', id: '51', happened_at: '2026-11-12T04:00:00.000Z', partner_name: 'Перевозчик',
  contact_name: 'Борис', contact_phone: '+79990000002', take: null,
  lead_id: LEAD, lead_status: 'lost', vehicle_kind: 'charter', vehicle_title: 'Елизово — Мутновский',
  date_from: '2026-12-05', date_to: '2026-12-06', notice_state: 'undelivered',
};
const STAY_ITEM: StayItem = {
  kind: 'stay_busy', id: STAY, stay_request_id: STAY, happened_at: '2026-11-12T05:00:00.000Z', partner_name: 'Хозяин',
  contact_name: 'Вера', contact_phone: '+79990000003', take: null,
  accommodation_name: 'Дом у вулкана', check_in: '2026-12-10', check_out: '2026-12-12', guests: 3,
};
const TAKE = { at: '2026-11-12T09:05:00.000Z', via: 'site', by: 'Ирина' };

const queueOf = (patch: Partial<ManagerQueue> = {}): ManagerQueue => ({
  since: '2026-11-12',
  answer_notice: { state: 'ok', items: [], more: false },
  vehicle_decline: { state: 'ok', items: [], more: false },
  stay_busy: { state: 'ok', items: [], more: false },
  ...patch,
});
const FULL = queueOf({
  answer_notice: { state: 'ok', items: [NOTICE], more: false },
  vehicle_decline: { state: 'ok', items: [VEHICLE], more: false },
  stay_busy: { state: 'ok', items: [STAY_ITEM], more: false },
});

/** Кнопка как она придёт нажатием: подпись снята и проверена. */
function pressed(payload: string): string {
  const v = unwrapPress(payload);
  if (!v.ok) throw new Error(`кнопка не прошла проверку подписи: ${v.reason}`);
  return v.payload;
}

beforeEach(() => {
  for (const f of [h.load, h.take, h.admin, h.query]) f.mockReset();
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'ключ-подписи-кнопок-для-проверок');
  h.load.mockResolvedValue(FULL);
  h.take.mockResolvedValue({ kind: 'taken', at: '2026-11-12T07:00:00.000Z' });
  h.admin.mockResolvedValue({ outcome: 'admin', userId: ADMIN_USER, name: 'Ирина' });
  h.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('список очереди в MAX', () => {
  it('у каждого ждущего случая — кому звонить, что за заявка и что ответил партнёр; ответ помечен как несущий ПД', () => {
    const r = adminQueueReply(FULL);
    expect(r.pd).toBe(true);
    expect(r.text.split('\n')).toEqual([
      '<b>Очередь после отказа — ждут: 3</b>',
      'Кому после отказа нужен звонок или замена.',
      '<b>Отказ не дошёл до клиента</b>',
      '1. Анна, +79990000001 · Тур «Мутновский», 02.12.2026, 2 чел. · «Оператор»: отказ — погода, безопасность. Сообщение об этом до клиента не дошло. Письмо с телефоном ушло в рабочий чат MAX.',
      '<b>Перевозчик или прокатчик не может</b>',
      '2. Борис, +79990000002 · Машина под заказ: Елизово — Мутновский, с 05.12.2026 по 06.12.2026 · Перевозчик «Перевозчик» ответил «Не могу». Сообщение об отказе до заказчика не дошло — позвонить.',
      '<b>Жильё занято</b>',
      '3. Вера, +79990000003 · Жильё «Дом у вулкана», с 10.12.2026 по 12.12.2026, гостей: 3 · Хозяин «Хозяин» ответил «занято».',
      ADMIN_QUEUE_TEXT.hint,
    ]);
    expect(r.buttonsLabel).toBe(ADMIN_QUEUE_TEXT.buttonsLabel);
  });

  it('кнопки «Взял N» — по номерам строк; каждая подписана как запись и разбирается в род и номер случая', () => {
    const r = adminQueueReply(FULL);
    const buttons = (r.buttons ?? []).flat();
    expect(buttons.map((b) => b.text)).toEqual(['Взял 1', 'Взял 2', 'Взял 3']);
    const want = [
      { kind: 'queue_take', queueKind: 'answer_notice', id: '101' },
      { kind: 'queue_take', queueKind: 'vehicle_decline', id: '51' },
      { kind: 'queue_take', queueKind: 'stay_busy', id: STAY },
    ];
    buttons.forEach((b, i) => {
      // Подпись стоит: хвост есть, без неё кнопка — другая строка.
      expect(b.payload, b.text).not.toBe(pressed(b.payload));
      expect(isWritePayload(pressed(b.payload)), b.text).toBe(true);
      expect(Buffer.byteLength(b.payload), b.text).toBeLessThanOrEqual(64);
      expect(parseAdminPress(pressed(b.payload)), b.text).toEqual(want[i]);
      // В подписи кнопки — только номер: ни имени, ни телефона.
      expect(b.text).toMatch(/^Взял [1-6]$/);
    });
    // Подделанная подпись нажатием не становится (последний знак подписи заменён на заведомо другой).
    const signed = buttons[0]!.payload;
    const forged = `${signed.slice(0, -1)}${signed.endsWith('x') ? 'y' : 'x'}`;
    expect(unwrapPress(forged)).toEqual({ ok: false, reason: 'forged' });
  });

  it('слова клиента и партнёра в тексте экранированы', () => {
    const r = adminQueueReply(queueOf({
      answer_notice: { state: 'ok', items: [{ ...NOTICE, contact_name: '<b>Анна</b>', tour_title: 'Тур <script>', partner_name: 'ООО «A&B»' }], more: false },
    }));
    expect(r.text).toContain('&lt;b&gt;Анна&lt;/b&gt;');
    expect(r.text).toContain('Тур «Тур &lt;script&gt;»');
    expect(r.text).toContain('«ООО «A&amp;B»»');
    expect(r.text).not.toContain('<script>');
  });

  it('взятые в список не входят и кнопок не получают — названо, сколько их и где смотреть', () => {
    const r = adminQueueReply(queueOf({
      answer_notice: { state: 'ok', items: [{ ...NOTICE, take: TAKE }], more: false },
      stay_busy: { state: 'ok', items: [STAY_ITEM], more: false },
    }));
    expect(r.text).not.toContain('Анна');
    expect(r.text).toContain('<b>Очередь после отказа — ждут: 1</b>');
    expect(r.text).toContain('1. Вера, +79990000003');
    expect(r.text).toContain('Уже взято: 1 — кто взял, видно на сайте, в «Очереди менеджера».');
    expect((r.buttons ?? []).flat().map((b) => b.text)).toEqual(['Взял 1']);
    expect(parseAdminPress(pressed((r.buttons ?? []).flat()[0]!.payload))).toEqual({ kind: 'queue_take', queueKind: 'stay_busy', id: STAY });
  });

  it('случаев больше, чем кнопок: номер и кнопку получают первые шесть', () => {
    const many = Array.from({ length: ADMIN_QUEUE_BUTTONS + 2 }, (_, i) => ({ ...NOTICE, id: String(200 + i), contact_name: `Клиент ${i + 1}` }));
    const r = adminQueueReply(queueOf({ answer_notice: { state: 'ok', items: many, more: true } }));
    const lines = r.text.split('\n');
    expect(lines.filter((l) => /^[1-6]\. /.test(l))).toHaveLength(ADMIN_QUEUE_BUTTONS);
    expect(lines.filter((l) => l.startsWith('• '))).toHaveLength(2);
    expect(lines.find((l) => l.startsWith('• '))).toContain('Клиент 7');
    expect((r.buttons ?? []).flat()).toHaveLength(ADMIN_QUEUE_BUTTONS);
    // Кнопки стоят рядами не шире трёх — как строка меню.
    expect(r.buttons).toEqual(menuRows((r.buttons ?? []).flat()));
    expect(r.text).toContain('Разобраны только последние случаи — более ранние в список не попали.');
  });

  // Направление поездки — свободный ввод заказчика: такие строки в одно сообщение не входят.
  const longVehicles = (n: number, from = 300): VehicleItem[] => Array.from({ length: n }, (_, i) => ({
    ...VEHICLE, id: String(from + i), contact_name: `Клиент ${i + 1}`, vehicle_title: `Елизово — ${'очень далёкое место '.repeat(60)}`,
  }));

  it('список длиннее одного сообщения: кнопка «Взял N» — только у случая, строка которого в сообщение вошла', () => {
    const r = adminQueueReply(queueOf({ vehicle_decline: { state: 'ok', items: longVehicles(ADMIN_QUEUE_BUTTONS), more: false } }));
    expect(r.text.length).toBeLessThanOrEqual(ADMIN_MAX_MESSAGE_CHARS);
    const lines = r.text.split('\n');
    const shown = lines.filter((l) => /^[1-6]\. /.test(l));
    // Вошли не все и не ноль: иначе проверять нечего.
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(ADMIN_QUEUE_BUTTONS);
    shown.forEach((l, i) => expect(l.startsWith(`${i + 1}. Клиент ${i + 1}, +79990000002 · `), l.slice(0, 40)).toBe(true));
    // Кнопок столько же, сколько строк с номером, — по тем же номерам и тем же случаям.
    const buttons = (r.buttons ?? []).flat();
    expect(buttons.map((b) => b.text)).toEqual(shown.map((_, i) => `Взял ${i + 1}`));
    expect(buttons.map((b) => parseAdminPress(pressed(b.payload)))).toEqual(
      shown.map((_, i) => ({ kind: 'queue_take', queueKind: 'vehicle_decline', id: String(300 + i) })),
    );
    // Счёт «ждут» — по всем, а не по показанным; сколько не вошло — числом.
    expect(lines[0]).toBe('<b>Очередь после отказа — ждут: 6</b>');
    expect(lines).toContain(`…и ещё ${ADMIN_QUEUE_BUTTONS - shown.length} — в сообщение не вошли: они на сайте, в «Очереди менеджера».`);
    // Подсказка под списком не обрезана.
    expect(lines[lines.length - 1]).toBe(ADMIN_QUEUE_TEXT.hint);
  });

  it('очередь в шестьсот длинных случаев укладывается в одно сообщение; ни одна строка не вошла — кнопок нет', () => {
    const r = adminQueueReply(queueOf({
      answer_notice: { state: 'ok', items: Array.from({ length: 200 }, (_, i) => ({ ...NOTICE, id: String(1000 + i), tour_title: 'Тур '.repeat(200) })), more: true },
      vehicle_decline: { state: 'ok', items: longVehicles(200, 2000), more: true },
      stay_busy: { state: 'ok', items: Array.from({ length: 200 }, (_, i) => ({ ...STAY_ITEM, id: STAY.replace(/2222$/, String(3000 + i)), accommodation_name: 'Дом '.repeat(200) })), more: true },
    }));
    expect(r.text.length).toBeLessThanOrEqual(ADMIN_MAX_MESSAGE_CHARS);
    expect(r.text).toContain('<b>Очередь после отказа — ждут: 600</b>');
    const shown = r.text.split('\n').filter((l) => /^([1-6]\.|•) /.test(l)).length;
    expect(r.text).toContain(`…и ещё ${600 - shown} — в сообщение не вошли`);

    // Предел меньше одной строки случая: текст честный, кнопок и их подписи нет.
    const none = adminQueueReply(FULL, 400);
    expect(none.text).toContain('…и ещё 3 — в сообщение не вошли');
    expect(none.text).not.toMatch(/Анна|Борис|Вера|7999000000/);
    expect(none.buttons).toBeUndefined();
    expect(none.buttonsLabel).toBeUndefined();
  });

  it('длинное имя клиента обрезано — телефон в строке остаётся', () => {
    const r = adminQueueReply(queueOf({
      answer_notice: { state: 'ok', items: [{ ...NOTICE, contact_name: 'Я'.repeat(700) }], more: false },
    }));
    const line = r.text.split('\n').find((l) => l.startsWith('1. ')) ?? '';
    expect(line.startsWith(`1. ${'Я'.repeat(ADMIN_QUEUE_NAME_CHARS - 1)}…, +79990000001 · Тур «Мутновский»`)).toBe(true);
  });

  it('список обрезан — строка о не прочитавшейся части очереди остаётся', () => {
    const r = adminQueueReply(queueOf({
      vehicle_decline: { state: 'ok', items: longVehicles(ADMIN_QUEUE_BUTTONS), more: false },
      stay_busy: { state: 'failed' },
    }));
    expect(r.text).toContain('…и ещё ');
    expect(r.text).toContain('<b>Жильё занято</b> — эта часть не прочиталась: сбой, а не «никого нет».');
    expect(r.text.length).toBeLessThanOrEqual(ADMIN_MAX_MESSAGE_CHARS);
  });

  it('часть очереди не прочиталась — названа сбоем; остальное показано', () => {
    const r = adminQueueReply(queueOf({
      answer_notice: { state: 'ok', items: [NOTICE], more: false },
      stay_busy: { state: 'failed' },
    }));
    expect(r.pd).toBe(true);
    expect(r.text).toContain('1. Анна, +79990000001');
    expect(r.text).toContain('<b>Жильё занято</b> — эта часть не прочиталась: сбой, а не «никого нет».');
  });

  it('никого не ждёт: «никого нет» — только когда прочитано всё', () => {
    expect(adminQueueReply(queueOf())).toEqual({ text: ADMIN_QUEUE_TEXT.empty, pd: false });

    const partly = adminQueueReply(queueOf({ vehicle_decline: { state: 'failed' } }));
    expect(partly.pd).toBe(false);
    expect(partly.buttons).toBeUndefined();
    expect(partly.text.split('\n')).toEqual([
      'В прочитанных частях очереди после отказа никого нет.',
      '<b>Перевозчик или прокатчик не может</b> — эта часть не прочиталась: сбой, а не «никого нет».',
    ]);
    expect(partly.text).not.toContain(ADMIN_QUEUE_TEXT.empty);

    const allFailed = adminQueueReply(queueOf({
      answer_notice: { state: 'failed' }, vehicle_decline: { state: 'failed' }, stay_busy: { state: 'failed' },
    }));
    expect(allFailed).toEqual({ text: ADMIN_QUEUE_TEXT.failed, pd: false });

    // Все случаи уже взяты — ждать некому, контактов в ответе нет.
    const taken = adminQueueReply(queueOf({ stay_busy: { state: 'ok', items: [{ ...STAY_ITEM, take: TAKE }], more: false } }));
    expect(taken.pd).toBe(false);
    expect(taken.text).toBe(`${ADMIN_QUEUE_TEXT.empty}\nУже взято: 1 — кто взял, видно на сайте, в «Очереди менеджера».`);
    expect(taken.text).not.toMatch(/Вера|79990000003/);
  });
});

describe('ПД: контакты — только в MAX администратора', () => {
  it('в MAX экран очереди несёт контакты и помечен pd; в Telegram — строка без контактов и без кнопок', async () => {
    const max = await roleMenuScreen({ role: 'admin', action: 'queue', channel: 'max', partner: null });
    expect(max.pd).toBe(true);
    expect(max.text).toContain('Анна, +79990000001');

    const tg = await roleMenuScreen({ role: 'admin', action: 'queue', channel: 'telegram', partner: null });
    expect(tg).toEqual({ text: 'Контакты туристов в этом списке есть только в MAX. Здесь их не показываю.', pd: false });
    expect(JSON.stringify(tg)).not.toMatch(/Анна|Борис|Вера|7999000000/);
  });

  it('ответ на «Взял» контактов и слов заявки не несёт', () => {
    const texts = [
      adminTakeText({ kind: 'taken', at: '2026-11-12T07:00:00.000Z' }),
      adminTakeText({ kind: 'already', at: '2026-11-12T09:05:00.000Z', by: 'Ирина', mine: false }),
      adminTakeText({ kind: 'already', at: '2026-11-12T09:05:00.000Z', by: 'Ирина', mine: true }),
      adminTakeText({ kind: 'already', at: 'не дата', by: null, mine: false }),
      adminTakeText({ kind: 'not_in_queue' }),
      adminTakeText({ kind: 'failed' }),
    ];
    expect(texts).toEqual([
      ADMIN_QUEUE_TEXT.taken,
      'Этот случай уже взял другой администратор: Ирина — 12.11, 21:05 по Камчатке.',
      'Этот случай уже взяли вы — 12.11, 21:05 по Камчатке.',
      'Этот случай уже взял другой администратор: имя не записано.',
      ADMIN_QUEUE_TEXT.gone,
      ADMIN_QUEUE_TEXT.notSaved,
    ]);
    // Исходы различимы: «не записалось» не выдаётся ни за «взяли», ни за «случая нет».
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('нажатие «Взял N»', () => {
  const press = (payload: string, patch: Partial<Parameters<typeof handleAdminPress>[0]> = {}) =>
    handleAdminPress({ chatId: 500, privateChat: true, presserId: 77, payload, ...patch });

  it('администратор в личном диалоге: отметка на его аккаунт, дверь — MAX; под ответом строка меню', async () => {
    const r = await press(pressed(adminQueueTakePayload('stay_busy', STAY)));
    expect(h.admin).toHaveBeenCalledWith(77);
    expect(h.take).toHaveBeenCalledTimes(1);
    expect(h.take).toHaveBeenCalledWith({ kind: 'stay_busy', id: STAY, userId: ADMIN_USER, via: 'max' });
    expect(r.text).toBe(ADMIN_QUEUE_TEXT.taken);
    expect(r.buttons).toEqual(menuRows(adminMenu()));
  });

  it('исход отметки доходит до слов', async () => {
    h.take.mockResolvedValue({ kind: 'already', at: '2026-11-12T09:05:00.000Z', by: 'Олег', mine: false });
    expect((await press('ad:q:n:101')).text).toBe('Этот случай уже взял другой администратор: Олег — 12.11, 21:05 по Камчатке.');
    h.take.mockResolvedValue({ kind: 'not_in_queue' });
    expect((await press('ad:q:v:51')).text).toBe(ADMIN_QUEUE_TEXT.gone);
    h.take.mockResolvedValue({ kind: 'failed' });
    expect((await press('ad:q:v:51')).text).toBe(ADMIN_QUEUE_TEXT.notSaved);
    expect(h.take.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'answer_notice', id: '101', userId: ADMIN_USER, via: 'max' },
      { kind: 'vehicle_decline', id: '51', userId: ADMIN_USER, via: 'max' },
      { kind: 'vehicle_decline', id: '51', userId: ADMIN_USER, via: 'max' },
    ]);
  });

  it('не администратор, не личный диалог, непроверенные права — отметки нет', async () => {
    h.admin.mockResolvedValue({ outcome: 'none' });
    expect((await press('ad:q:n:101')).text).toBe(ADMIN_ACTION_TEXT.notAdmin);
    h.admin.mockResolvedValue({ outcome: 'unavailable' });
    expect((await press('ad:q:n:101')).text).toBe(ADMIN_ACTION_TEXT.unchecked);
    h.admin.mockResolvedValue({ outcome: 'admin', userId: ADMIN_USER, name: 'Ирина' });
    expect((await press('ad:q:n:101', { privateChat: false })).text).toBe(ADMIN_ACTION_TEXT.notDialog);
    expect((await press('ad:q:n:101', { presserId: null })).text).toBe(ADMIN_ACTION_TEXT.unchecked);
    expect(h.take).not.toHaveBeenCalled();
  });

  it('чужая форма кнопки — не нажатие: род и номер случая проверены до базы', async () => {
    for (const bad of ['ad:q:x:101', 'ad:q:n:abc', 'ad:q:n:', 'ad:q:s:101', `ad:q:v:${STAY}`, `ad:q:n:${STAY}`, 'ad:q:n:101:1', "ad:q:n:1' OR 1=1"]) {
      expect(parseAdminPress(bad), bad).toBeNull();
      expect((await press(bad)).text, bad).toBe(ADMIN_ACTION_TEXT.unknownButton);
    }
    expect(h.admin).not.toHaveBeenCalled();
    expect(h.take).not.toHaveBeenCalled();
    // Запись подписывается: без подписи такая кнопка после срока старых кнопок не принимается.
    expect(isWritePayload('ad:q:n:101')).toBe(true);
    expect(isWritePayload(`ad:q:s:${STAY}`)).toBe(true);
  });

  it('takeFromAdminChat пишет отметку от имени переданного администратора', async () => {
    const r = await takeFromAdminChat(ADMIN_USER, 'answer_notice', '101');
    expect(h.take).toHaveBeenCalledWith({ kind: 'answer_notice', id: '101', userId: ADMIN_USER, via: 'max' });
    expect(r.text).toBe(ADMIN_QUEUE_TEXT.taken);
  });
});

describe('вход в очередь', () => {
  it('слово «очередь» — команда; «заявки» и «брони» остаются собой', async () => {
    for (const t of ['очередь', 'Очередь', 'Очередь после отказа', 'очередь заявок', 'покажи очередь', 'кто в очереди?', 'кто ждёт после отказа']) {
      expect(adminCommandOf(t), t).toBe('queue');
    }
    expect(adminCommandOf('заявки')).toBe('leads');
    expect(adminCommandOf('брони')).toBe('bookings');
    expect(adminCommandOf('сводка')).toBe('summary');
    // Оборот речи — не команда: прежние команды очередь не перехватывает.
    expect(adminCommandOf('в первую очередь покажи даты')).toBe('dates');
    expect(adminCommandOf('Брони в первую очередь')).toBe('bookings');
    expect(adminCommandOf('заявки, в свою очередь, покажи')).toBe('leads');
    expect(adminCommandOf('очередной тур — какие даты')).toBe('dates');
    expect(ADMIN_HELP_TEXT).toContain('<b>очередь</b> — кому после отказа нужен звонок или замена');

    const r = await adminReplyFor('queue');
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(r.pd).toBe(true);
    expect(r.text).toContain('<b>Очередь после отказа — ждут: 3</b>');
    expect(await readAdminQueue()).toEqual(r);
  });

  it('кнопка «Очередь после отказа» стоит под «Заявками» — и когда заявок нет', async () => {
    const button = adminQueueButton();
    expect(button).toEqual({ text: 'Очередь после отказа', payload: 'rm:ad:qu' });
    expect(parseRoleMenuPress(button.payload)).toEqual({ role: 'admin', action: 'queue' });

    const none = await readWaitingLeads();
    expect(none).toEqual({ text: 'Заявок без ответа человека нет.', pd: false, buttons: [[button]] });

    h.query.mockResolvedValue({ rows: [{ id: LEAD, name: 'Анна', phone: '+79990000001', route_title: 'Мутновский', age_h: 3, addressee: 'Оператор', kind: '', total: 1 }] });
    const some = await readWaitingLeads();
    expect(some.pd).toBe(true);
    expect(some.buttons?.at(-1)).toEqual([button]);
    expect(some.buttons?.[0]?.[0]?.text).toBe('Заявка 1');
  });

  it('строка меню администратора прежняя; очередь — только у администратора', () => {
    expect(adminMenu().map((b) => b.text)).toEqual(['Даты', 'Брони', 'Заявки', 'Сводка', 'Здоровье', 'Помощь']);
    for (const other of ['rm:op:qu', 'rm:tf:qu', 'rm:st:qu', 'rm:gd:qu']) expect(parseRoleMenuPress(other), other).toBeNull();
  });

  it('справка называет очередь и где контакты; «Взял» — только в справке MAX', () => {
    const max = adminMenuHelp('max');
    const tg = adminMenuHelp('telegram');
    expect(max).toContain('Очередь после отказа — кнопка под «Заявками» или слово «очередь»: кому после отказа нужен звонок или замена. Контакты — только в MAX.');
    expect(max).toContain('Кнопка «Взял N» под очередью после отказа');
    // В Telegram кнопок под списками нет и список не показывается: справка не обещает ни кнопки, ни «Взял N» — говорит, где они.
    expect(tg).toContain('Очередь после отказа — слово «очередь»: кому после отказа нужен звонок или замена. Список с контактами и отметка «Взял» — в MAX администратора и на сайте, в «Очереди менеджера».');
    expect(tg).not.toContain('кнопка под «Заявками»');
    expect(tg).not.toContain('Взял N');
  });
});
