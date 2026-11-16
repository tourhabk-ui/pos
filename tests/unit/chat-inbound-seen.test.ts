/**
 * Учёт входящих апдейтов Telegram и MAX в базе (#3433 п. 1, слово владельца
 * 16.11 «Оба шага»): повтор узнаётся и после перезапуска; апдейт, брошенный
 * упавшим запуском, подхватывается один раз; сообщение Telegram лежит в строке
 * до отметки «обработано». База, не ответившая вовремя, — «не смог», и решает
 * память процесса. Вызовом lib/chat/inbound-seen; таблица — в памяти теста,
 * SQL проверен на PostgreSQL 16 (PR). Вебхуки — в telegram-webhook-kuzmich-brain,
 * bound-chat-live-booking и max-verified-press.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInboundTable } from '../helpers/inbound-table';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.query(...a) } }));

const {
  recordInboundInDb, isRepeatedInbound, admitInbound, markInboundDone, claimStaleTelegram, inboundBootId,
} = await import('@/lib/chat/inbound-seen');

const db = createInboundTable();
const table = db.rows;
const leftBy = db.leftBy;
const fakeTable = async (sql: unknown, p: unknown[] = []) => {
  const res = db.handle(sql, p);
  if (res) return res;
  throw new Error(`неожиданный запрос: ${String(sql)}`);
};

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db.clear();
  m.query.mockReset();
  m.query.mockImplementation(fakeTable);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  errorLog.mockRestore();
});

const ME = inboundBootId();

describe('recordInboundInDb: новый, повтор, не смог', () => {
  it('первая доставка — new, вторая — repeat; источники не смешиваются', async () => {
    expect(await recordInboundInDb('telegram', '101')).toBe('new');
    expect(await recordInboundInDb('telegram', '101')).toBe('repeat');
    expect(await recordInboundInDb('max_message', '101')).toBe('new');
    expect(await recordInboundInDb('max_callback', '101')).toBe('new');
  });

  it('запуск — один на процесс, и строка помечена им', async () => {
    expect(inboundBootId()).toBe(ME);
    await recordInboundInDb('max_message', 'mid.abc');
    expect(m.query.mock.calls[0][1]).toEqual(['max_message', 'mid.abc', ME, null, 15]);
  });

  it('сообщение кладётся в строку, только когда его передали', async () => {
    await recordInboundInDb('telegram', '5', { payload: { update_id: 5, message: { text: 'привет' } } });
    expect(table.get('telegram:5')?.payload).toEqual({ update_id: 5, message: { text: 'привет' } });
    await recordInboundInDb('max_callback', 'cb');
    expect(table.get('max_callback:cb')?.payload).toBeNull();
  });

  it('отказ базы — unknown, в логе код отказа', async () => {
    m.query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    expect(await recordInboundInDb('telegram', '7')).toBe('unknown');
    expect(String(errorLog.mock.calls[0][0])).toMatch(/\[chat\/inbound-seen\].*42P01/);
  });

  it('ответ не той формы — unknown, а не «повтор»', async () => {
    for (const res of [{ rows: [] }, { rows: [{ hits: null }] }, { rows: [{}, {}] }, undefined]) {
      m.query.mockResolvedValueOnce(res);
      expect(await recordInboundInDb('telegram', '8')).toBe('unknown');
    }
  });

  it('база молчит дольше двух секунд — unknown, вебхук не ждёт', async () => {
    vi.useFakeTimers();
    m.query.mockReturnValueOnce(new Promise(() => undefined));
    const verdict = recordInboundInDb('telegram', '9');
    await vi.advanceTimersByTimeAsync(2001);
    expect(await verdict).toBe('unknown');
  });

  it('пустой или слишком длинный ключ — unknown без запроса', async () => {
    expect(await recordInboundInDb('telegram', '')).toBe('unknown');
    expect(await recordInboundInDb('telegram', 'x'.repeat(201))).toBe('unknown');
    expect(m.query).not.toHaveBeenCalled();
  });

  it('по ходу записи: строки старше суток удаляются, неподобранные сообщения стираются', async () => {
    for (let i = 0; i < 100; i++) await recordInboundInDb('telegram', `c${i}`);
    const sqls = m.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.filter((s) => s.startsWith('DELETE')).join()).toContain("interval '1 day'");
    expect(sqls.some((s) => /SET payload = NULL/.test(s) && !/processed_at = now\(\)/.test(s))).toBe(true);
  });
});

describe('апдейт, брошенный упавшим запуском', () => {
  it('повтор MAX после падения — подхватывается один раз; третья доставка — повтор', async () => {
    leftBy('dead-boot', 'max_message', 'mid-1');
    expect(await recordInboundInDb('max_message', 'mid-1')).toBe('new');
    expect(table.get('max_message:mid-1')).toMatchObject({ boot_id: ME, attempts: 1 });
    expect(await recordInboundInDb('max_message', 'mid-1')).toBe('repeat');
  });

  it('обработанный, свой незаконченный, старше 15 минут, уже подхваченный — повтор', async () => {
    leftBy('dead-boot', 'max_message', 'done', { processed: true });
    leftBy(ME, 'max_message', 'running');
    leftBy('dead-boot', 'max_message', 'old', { ageMin: 20 });
    leftBy('dead-boot', 'max_message', 'poison', { attempts: 1 });
    for (const key of ['done', 'running', 'old', 'poison']) {
      expect(await recordInboundInDb('max_message', key), key).toBe('repeat');
    }
  });

  it('отметка «обработано» — только своей строки; сообщение стирается', async () => {
    await recordInboundInDb('telegram', '11', { payload: { update_id: 11, message: { text: 'x' } } });
    await markInboundDone('telegram', '11');
    expect(table.get('telegram:11')).toMatchObject({ processed: true, payload: null });

    leftBy('other-boot', 'telegram', '12', { payload: { update_id: 12 } });
    await markInboundDone('telegram', '12');
    expect(table.get('telegram:12')).toMatchObject({ processed: false, payload: { update_id: 12 } });
  });

  it('подбор Telegram: только чужие незаконченные с сообщением, свежие, один раз', async () => {
    leftBy('dead-boot', 'telegram', '21', { payload: { update_id: 21 } });
    leftBy('dead-boot', 'telegram', '22', { payload: { update_id: 22 }, ageMin: 20 });
    leftBy('dead-boot', 'telegram', '23', { payload: null });
    leftBy(ME, 'telegram', '24', { payload: { update_id: 24 } });
    leftBy('dead-boot', 'max_message', '25', { payload: { x: 1 } });

    const first = await claimStaleTelegram();
    expect(first).toEqual({ ok: true, items: [{ key: '21', payload: { update_id: 21 } }] });
    expect(table.get('telegram:22')?.payload).toBeNull(); // поздно подбирать — стёрто
    expect(await claimStaleTelegram()).toEqual({ ok: true, items: [] });
  });

  it('подбор: база не ответила — ok:false, а не «нечего подбирать»', async () => {
    m.query.mockRejectedValue(new Error('down'));
    expect(await claimStaleTelegram()).toEqual({ ok: false });
  });
});

describe('память процесса, затем база', () => {
  it('память видела — повтор без похода в базу', async () => {
    expect(await isRepeatedInbound('telegram', '1', () => true)).toBe(true);
    expect(await admitInbound('telegram', '1', () => true)).toBe('repeat');
    expect(m.query).not.toHaveBeenCalled();
  });

  it('после перезапуска память пуста, база помнит — повтор', async () => {
    expect(await isRepeatedInbound('telegram', '2', () => false)).toBe(false);
    expect(await isRepeatedInbound('telegram', '2', () => false)).toBe(true);
  });

  it('база не ответила — решает память: не видела — не повтор', async () => {
    m.query.mockRejectedValue(new Error('down'));
    expect(await admitInbound('telegram', '3', () => false)).toBe('unknown');
    expect(await isRepeatedInbound('telegram', '3', () => false)).toBe(false);
  });
});
