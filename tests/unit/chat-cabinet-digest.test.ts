/**
 * Утренняя сводка кабинета в чате (lib/chat-cabinet/digest) — вызовом, с
 * подменёнными базой, чтением и отправкой. SQL кандидатов, замка и снятия
 * судит tests/integration/chat-cabinet.pg.test.ts.
 *
 * Держит:
 *  - только окно 08:00–12:00 по Камчатке; вне его база не спрашивается;
 *  - один раз в камчатские сутки: замок `sending` до отправки, итог после,
 *    отказ отправки снимает замок (повтор — в следующем прогоне);
 *  - нечего сказать — молчим (`empty`); чат — кабинет другой карточки или
 *    пилот проката — не шлём (`unreachable`); чтение не удалось — не шлём и
 *    не ставим замок (`read_failed`), это не «ничего нет»;
 *  - ПД: в MAX — через sendPdAlert, заглушка — только в Telegram-кабинет этой
 *    карточки и без заголовков задач и имён; кабинет только в Telegram —
 *    сводка без ПД с кнопками кабинета;
 *  - отправка бросила — замок снят, как при отказе;
 *  - прогон без единой сводки при отказах считает, разобран ли сегодня хоть
 *    один кабинет (`done_today`): одному недоступному чату шаг не краснеет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DigestCandidate, DigestFacts } from '@/lib/chat-cabinet/digest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
const D = await import('@/lib/chat-cabinet/digest');

const PID = '11111111-1111-4111-8111-111111111111';
/** 30.10 08:12 по Камчатке. */
const AT = new Date(Date.UTC(2026, 9, 29, 20, 12));

function cand(over: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    partner_id: PID, category: 'guide', slug: 'g', user_id: 'u', profile_status: null,
    max_chat_id: '9001', telegram_chat_id: '7001', max_cabinet: true, telegram_cabinet: true, sells_tours: true, ...over,
  };
}

function facts(over: Partial<DigestFacts> = {}): DigestFacts {
  return {
    inbox: {
      category: 'guide', failed: [], chat: { state: 'none' }, not_here: [],
      response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
      items: [
        { kind: 'operator_booking', id: '501', created_at: '2026-10-29T00:00:00Z', title: 'Пещеры', date: '2026-11-05', people: 2, contact_id: 'c', contact_name: 'Анна Петрова', waiting_minutes: 600 },
        { kind: 'lead', id: 'l1', created_at: '2026-10-29T00:00:00Z', title: 'Толбачик', date: null, people: null, contact_id: null, contact_name: null, waiting_minutes: 50 },
      ],
    },
    due: [{
      id: 't1', title: 'Перезвонить Анне <x>', details: null, due_at: '2026-10-29T23:00:00.000Z', done_at: null,
      contact: { id: 'c', display_name: 'Анна Петрова' }, created_at: '2026-10-28T00:00:00Z', reminder: null,
    }],
    overdue: 0,
    ...over,
  };
}

function fakeDb(candidates: DigestCandidate[], claim = 1) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql === D.DIGEST_CANDIDATES_SQL) return { rows: candidates, rowCount: candidates.length };
    if (sql === D.DIGEST_CLAIM_SQL) return { rows: [], rowCount: claim };
    return { rows: [], rowCount: 1 };
  });
  return { db: { query } as never, calls };
}

const claimed = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.filter((c) => c.sql === D.DIGEST_CLAIM_SQL).map((c) => c.params[2]);
const finished = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.filter((c) => c.sql === D.DIGEST_FINISH_SQL).map((c) => c.params[2]);
const released = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.filter((c) => c.sql === D.DIGEST_RELEASE_SQL).length;

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

describe('окно', () => {
  it('до 08:00 и с 12:00 по Камчатке — база не спрашивается; 11:59 — ещё окно', async () => {
    for (const at of [new Date(Date.UTC(2026, 9, 29, 19, 59)), new Date(Date.UTC(2026, 9, 30, 0, 0))]) {
      const { db, calls } = fakeDb([cand()]);
      const r = await D.runChatDigest(at, { db, read: vi.fn(), sendPd: vi.fn(), sendTelegram: vi.fn() });
      expect(r.window).toBe(false);
      expect(calls).toEqual([]);
    }
    const { db } = fakeDb([]);
    const late = await D.runChatDigest(new Date(Date.UTC(2026, 9, 29, 23, 59)), { db, read: vi.fn(), sendPd: vi.fn(), sendTelegram: vi.fn() });
    expect(late.window).toBe(true);
  });

  it('в окне — кандидаты по камчатской дате (30.10, а не 29.10 сервера)', async () => {
    const { db, calls } = fakeDb([]);
    const r = await D.runChatDigest(AT, { db, read: vi.fn(), sendPd: vi.fn(), sendTelegram: vi.fn() });
    expect(r.window).toBe(true);
    expect(calls[0]!.params).toEqual(['2026-10-30', D.DIGEST_BATCH, 'morning']);
  });

  it('окно этого часа — время, выбранное партнёром (1354): днём 13–17, вечером 18–22; в 12 и после 22 — ни одного', async () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 9, 29, hour - 12 + (hour < 12 ? 24 : 0), 5));
    for (const [hour, slot] of [[13, 'day'], [16, 'day'], [18, 'evening'], [21, 'evening']] as const) {
      const { db, calls } = fakeDb([]);
      const r = await D.runChatDigest(at(hour), { db, read: vi.fn(), sendPd: vi.fn(), sendTelegram: vi.fn() });
      expect(r, String(hour)).toMatchObject({ window: true, slot });
      expect(calls[0]!.params[2]).toBe(slot);
    }
    for (const hour of [12, 17, 22, 23]) {
      const { db, calls } = fakeDb([]);
      const r = await D.runChatDigest(at(hour), { db, read: vi.fn(), sendPd: vi.fn(), sendTelegram: vi.fn() });
      expect(r, String(hour)).toMatchObject({ window: false, slot: null });
      expect(calls).toEqual([]);
    }
  });

  it('заголовок — по окну: утром «Доброе утро», днём и вечером без него', () => {
    expect(D.digestText(facts(), 'telegram', AT.getTime())).toMatch(/^<b>Доброе утро\. Кабинет на сегодня<\/b>/);
    expect(D.digestText(facts(), 'telegram', AT.getTime(), 'day')).toMatch(/^<b>Кабинет: что ждёт сейчас<\/b>/);
    expect(D.digestText(facts(), 'telegram', AT.getTime(), 'evening')).toMatch(/^<b>Кабинет: итог дня<\/b>/);
  });
});

describe('MAX', () => {
  it('ПД — только в MAX через sendPdAlert, с кнопками кабинета; заглушка — без заголовков задач и имён; итог записан', async () => {
    const { db, calls } = fakeDb([cand()]);
    const sendPd = vi.fn(async () => ({ channel: 'max' as const, delivered: true, reason: '' }));
    const r = await D.runChatDigest(AT, { db, read: async () => facts(), sendPd, sendTelegram: vi.fn() });
    expect(r).toMatchObject({ candidates: 1, sent_max: 1, failed: 0 });
    expect(claimed(calls)).toEqual(['sending']);
    expect(finished(calls)).toEqual(['max']);
    const p = (sendPd.mock.calls[0] as unknown as [{ text: string; stub: string; buttons: Array<{ payload?: string; url?: string }>; to: unknown }])[0];
    expect(p.to).toEqual({ maxChatId: '9001', telegramChatId: '7001' });
    expect(p.text).toContain('Ждут ответа: 2 — Бронь тура 1, Заявка на подбор 1.');
    expect(p.text).toContain('Дольше всех ждёт: 10 ч.');
    expect(p.text).toContain('• Перезвонить Анне &lt;x&gt; — сегодня 11:00 · Анна П.');
    expect(p.text).not.toContain('Петрова');
    expect(p.stub).not.toMatch(/Перезвонить|Анна/);
    expect(p.stub).toContain('Задачи на сегодня: 1, из них просрочено: 0.');
    expect(p.buttons.map((b) => b.payload ?? b.url)).toEqual(['cb:n:i', 'cb:n:t', 'cb:n:g', 'https://vedarai.ru/hub/guide']);
  });

  it('MAX не принял, ушла заглушка — итог «telegram»; не ушло никуда — замок снят, повтор в следующем прогоне', async () => {
    let { db, calls } = fakeDb([cand()]);
    let r = await D.runChatDigest(AT, {
      db, read: async () => facts(), sendTelegram: vi.fn(),
      sendPd: async () => ({ channel: 'telegram-stub' as const, delivered: false, reason: '' }),
    });
    expect(r.sent_stub).toBe(1);
    expect(finished(calls)).toEqual(['telegram']);
    ({ db, calls } = fakeDb([cand()]));
    r = await D.runChatDigest(AT, {
      db, read: async () => facts(), sendTelegram: vi.fn(),
      sendPd: async () => ({ channel: 'none' as const, delivered: false, reason: 'MAX отказал' }),
    });
    expect(r.failed).toBe(1);
    expect(finished(calls)).toEqual([]);
    expect(released(calls)).toBe(1);
  });

  it('заглушка — только в Telegram-кабинет этой карточки: чужой Telegram-чат не получает ничего', async () => {
    const { db } = fakeDb([cand({ telegram_cabinet: false })]);
    const sendPd = vi.fn(async () => ({ channel: 'max' as const, delivered: true, reason: '' }));
    await D.runChatDigest(AT, { db, read: async () => facts(), sendPd, sendTelegram: vi.fn() });
    expect((sendPd.mock.calls[0] as unknown as [{ to: unknown }])[0].to).toEqual({ maxChatId: '9001', telegramChatId: null });
  });
});

describe('Telegram и молчание', () => {
  it('кабинет только в Telegram — сводка без ПД, кнопки кабинета; не ушла — замок снят', async () => {
    let { db, calls } = fakeDb([cand({ max_chat_id: null, max_cabinet: false })]);
    const sendTelegram = vi.fn(async () => true);
    const sendPd = vi.fn();
    const r = await D.runChatDigest(AT, { db, read: async () => facts(), sendPd, sendTelegram });
    expect(r.sent_tg).toBe(1);
    expect(sendPd).not.toHaveBeenCalled();
    const [chatId, text, kb] = sendTelegram.mock.calls[0] as unknown as [string, string, { inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>> }];
    expect(chatId).toBe('7001');
    expect(text).not.toMatch(/Перезвонить|Анна|Петрова/);
    expect(kb.inline_keyboard.flat().map((b) => b.callback_data ?? b.url)).toEqual(['cb:n:i', 'cb:n:t', 'cb:n:g', 'https://vedarai.ru/hub/guide']);
    expect(finished(calls)).toEqual(['telegram']);
    ({ db, calls } = fakeDb([cand({ max_chat_id: null, max_cabinet: false })]));
    await D.runChatDigest(AT, { db, read: async () => facts(), sendPd, sendTelegram: async () => false });
    expect(released(calls)).toBe(1);
  });

  it('ждать нечего — «empty» без сообщения; не кабинет своего чата и пилот проката — «unreachable»', async () => {
    const quiet = facts({ inbox: { ...facts().inbox, items: [] }, due: [] });
    const { db, calls } = fakeDb([
      cand(),
      cand({ partner_id: '22222222-2222-4222-8222-222222222222', max_cabinet: false, telegram_cabinet: false }),
      cand({ partner_id: '33333333-3333-4333-8333-333333333333', category: 'transfer', slug: 'laguna-prokat' }),
    ]);
    const sendPd = vi.fn();
    const read = vi.fn(async () => quiet);
    const r = await D.runChatDigest(AT, { db, read, sendPd, sendTelegram: vi.fn() });
    expect(r).toMatchObject({ empty: 1, unreachable: 2, sent_max: 0 });
    expect(claimed(calls)).toEqual(['empty', 'unreachable', 'unreachable']);
    expect(sendPd).not.toHaveBeenCalled();
    // Не кабинет — данные не читаются вовсе.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('вид входящих не прочитался — сводка говорит об этом, а не «ответа никто не ждёт»', async () => {
    const f = facts({ inbox: { ...facts().inbox, items: [], failed: ['lead'] }, due: [] });
    expect(D.digestHasNews(f)).toBe(true);
    const text = D.digestText(f, 'telegram', AT.getTime());
    expect(text).toContain('Не прочиталось: Заявка на подбор — это не «ничего нет».');
    expect(text).not.toContain('Ответа никто не ждёт.');
  });
});

describe('отказы', () => {
  it('чтение не удалось — без замка и без сообщения; соседний прогон уже взял — не шлём', async () => {
    let { db, calls } = fakeDb([cand()]);
    const sendPd = vi.fn();
    let r = await D.runChatDigest(AT, { db, read: async () => null, sendPd, sendTelegram: vi.fn() });
    expect(r.read_failed).toBe(1);
    expect(claimed(calls)).toEqual([]);
    ({ db, calls } = fakeDb([cand()], 0));
    r = await D.runChatDigest(AT, { db, read: async () => facts(), sendPd, sendTelegram: vi.fn() });
    expect(sendPd).not.toHaveBeenCalled();
    expect(r.sent_max).toBe(0);
  });

  it('список кабинетов не прочитался — query_failed; отказ одного кабинета не останавливает остальных', async () => {
    const broken = { query: vi.fn(async () => { throw Object.assign(new Error('x'), { code: '57P01' }); }) } as never;
    const r1 = await D.runChatDigest(AT, { db: broken, read: vi.fn(), sendPd: vi.fn(), sendTelegram: vi.fn() });
    expect(r1.query_failed).toBe(true);

    const two = [cand(), cand({ partner_id: '22222222-2222-4222-8222-222222222222' })];
    let first = true;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql === D.DIGEST_CANDIDATES_SQL) return { rows: two, rowCount: 2 };
        if (sql === D.DIGEST_FINISH_SQL && first) { first = false; throw Object.assign(new Error('y'), { code: '40001' }); }
        return { rows: [], rowCount: 1 };
      }),
    } as never;
    const r2 = await D.runChatDigest(AT, {
      db, read: async () => facts(), sendTelegram: vi.fn(),
      sendPd: async () => ({ channel: 'max' as const, delivered: true, reason: '' }),
    });
    expect(r2.sent_max).toBe(2);
    expect(r2.failed).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('40001');
    // Сводки в прогоне ушли — разобранное за день не считается.
    expect(r2.done_today).toBeNull();
  });

  it('отправка бросила — замок снят, повтор в следующем прогоне', async () => {
    const { db, calls } = fakeDb([cand()]);
    const r = await D.runChatDigest(AT, {
      db, read: async () => facts(), sendTelegram: vi.fn(),
      sendPd: async () => { throw new TypeError('сеть'); },
    });
    expect(r.failed).toBe(1);
    expect(finished(calls)).toEqual([]);
    expect(released(calls)).toBe(1);
  });

  it('прогон ничего не разослал при отказах — счёт разобранных за день; сводка дошла — не считает', async () => {
    const counted = (n: number | 'throw') => {
      const calls: string[] = [];
      const db = {
        query: vi.fn(async (sql: string) => {
          calls.push(sql);
          if (sql === D.DIGEST_CANDIDATES_SQL) return { rows: [cand()], rowCount: 1 };
          if (sql === D.DIGEST_DONE_TODAY_SQL) {
            if (n === 'throw') throw Object.assign(new Error('z'), { code: '57P01' });
            return { rows: [{ n }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }),
      } as never;
      return { db, calls };
    };
    const none = async () => ({ channel: 'none' as const, delivered: false, reason: 'бот заблокирован' });
    let x = counted(3);
    let r = await D.runChatDigest(AT, { db: x.db, read: async () => facts(), sendTelegram: vi.fn(), sendPd: none });
    expect(r).toMatchObject({ failed: 1, done_today: 3 });
    x = counted(0);
    r = await D.runChatDigest(AT, { db: x.db, read: async () => facts(), sendTelegram: vi.fn(), sendPd: none });
    expect(r.done_today).toBe(0);
    x = counted('throw');
    r = await D.runChatDigest(AT, { db: x.db, read: async () => facts(), sendTelegram: vi.fn(), sendPd: none });
    expect(r.done_today).toBeNull();
    x = counted(5);
    r = await D.runChatDigest(AT, {
      db: x.db, read: async () => facts(), sendTelegram: vi.fn(),
      sendPd: async () => ({ channel: 'max' as const, delivered: true, reason: '' }),
    });
    expect(r.done_today).toBeNull();
    expect(x.calls).not.toContain(D.DIGEST_DONE_TODAY_SQL);
  });
});
