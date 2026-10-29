/**
 * Кабинет в чате на настоящем PostgreSQL (миграция 1351; слово владельца
 * 30.10 «всё сразу + Telegram»).
 *
 * Судится своим кодом на схеме прода, от нажатия до строки в базе:
 *  - «Дозвонился» пишет касание в ленту клиента ЭТОЙ карточки, повтор за две
 *    минуты второй строки не даёт; чужой клиент — ни строки;
 *  - «Завтра 10:00» заводит задачу клиенту на 10:00 по Камчатке, повтор —
 *    вторую не заводит;
 *  - «Готово» и «На завтра» меняют задачу карточки чата; задача другой
 *    карточки остаётся как была;
 *  - «Найти клиента»: одно ожидание на чат; кнопка гасит ожидание причины
 *    отказа брони и сообщения по заявке; поиск уступает кнопке, нажатой
 *    позже; найденный клиент — только своей карточки;
 *  - утренняя сводка: кандидаты по камчатской дате, кабинет чата — старшая
 *    карточка, замок `sending` — один на сутки, снятие возвращает в очередь;
 *  - миграция 1351 повторяется без вреда, а ожидание не из MAX база не примет.
 * Подменены только отправка и чтение «Входящих» сводки — судится база.
 *
 * Своя база `chat_cabinet_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: vi.fn(async () => ({ channel: 'max', delivered: true, reason: 'доставлено в MAX' })),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[chat-cabinet.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'chat_cabinet_test';
const CHAT = 8_101;
const OTHER_CHAT = 8_102;
/** 30.10 12:00 по Камчатке. */
const NOW = Date.UTC(2026, 9, 30, 0, 0);

withPg('кабинет в чате на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let svc: typeof import('@/lib/chat-cabinet/service');
  let digest: typeof import('@/lib/chat-cabinet/digest');
  let pay: typeof import('@/lib/chat-cabinet/payload')['cabinetPayload'];
  let partnerId = '';
  let otherId = '';
  let youngerId = '';
  let contactId = '';
  let foreignContactId = '';
  let userId = '';

  const press = (payload: string, nowMs = NOW) =>
    svc.handleCabinetPress({ channel: 'max', chatId: CHAT, privateChat: true, payload, nowMs });

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    svc = await import('@/lib/chat-cabinet/service');
    digest = await import('@/lib/chat-cabinet/digest');
    pay = (await import('@/lib/chat-cabinet/payload')).cabinetPayload;

    userId = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('cab-op@example.com', 'Оператор кабинета', 'x', 'operator') RETURNING id`,
    )).rows[0]!.id;
    partnerId = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, max_chat_id, created_at)
       VALUES ('Кабинетный', 'operator', '{}', $1, $2, NOW() - INTERVAL '10 days') RETURNING id`, [userId, CHAT],
    )).rows[0]!.id;
    // Вторая, младшая карточка на том же чате: кабинет чата — старшая.
    youngerId = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, max_chat_id, created_at)
       VALUES ('Младшая', 'guide', '{}', $1, NOW()) RETURNING id`, [CHAT],
    )).rows[0]!.id;
    otherId = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ('Чужой', 'operator', '{}', $1) RETURNING id`, [OTHER_CHAT],
    )).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (partner_id, display_name, phone, phone_e164, origin)
       VALUES ($1, 'Анна Петрова', '+79140001122', '+79140001122', 'manual') RETURNING id`, [partnerId],
    )).rows[0]!.id;
    foreignContactId = (await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (partner_id, display_name, origin) VALUES ($1, 'Анна Чужая', 'manual') RETURNING id`, [otherId],
    )).rows[0]!.id;
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  const events = async (cid: string) => (await pool.query<{ kind: string; title: string; actor_kind: string; actor_user_id: string | null }>(
    `SELECT kind, title, actor_kind, actor_user_id::text AS actor_user_id FROM crm_events WHERE contact_id = $1 ORDER BY id`, [cid],
  )).rows;

  it('миграция 1351 повторяется без вреда; ожидание не из MAX и чужой статус база не примет', async () => {
    const sql = readFileSync(join(process.cwd(), 'migrations', '1351_chat_cabinet.sql'), 'utf8');
    await pool.query(sql);
    await expect(pool.query(
      `INSERT INTO chat_cabinet_waits (channel, chat_id, partner_id, expires_at) VALUES ('telegram', 1, $1, NOW())`, [partnerId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO chat_cabinet_waits (channel, chat_id, partner_id, status, expires_at) VALUES ('max', 1, $1, 'used', NOW())`, [partnerId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('карточка чата — старшая: кабинет открывается её данными', async () => {
    const s = await press(pay.clients());
    expect(s.text).toContain('Всего: 1.');
    expect(s.rows.flat().map((b) => b.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^Анна П\. · \d\d\.\d\d$/)]));
    expect(JSON.stringify(s)).not.toContain('Чужая');
  });

  it('«Дозвонился» — касание в ленту клиента своей карточки её аккаунтом; повтор за две минуты не пишется', async () => {
    const first = await press(pay.touch('reached', contactId));
    expect(first.text).toContain('Записал в ленту клиента: «Звонок: дозвонился».');
    const again = await press(pay.touch('reached', contactId));
    expect(again.text).toContain('уже записан только что');
    expect(await events(contactId)).toEqual([{ kind: 'call', title: 'Звонок: дозвонился', actor_kind: 'partner_user', actor_user_id: userId }]);
    // Другой итог — другая запись.
    await press(pay.touch('agreed', contactId));
    expect((await events(contactId)).map((e) => e.kind)).toEqual(['call', 'note']);
  });

  it('чужой клиент — «нет в вашей CRM», ни события, ни задачи', async () => {
    expect((await press(pay.touch('reached', foreignContactId))).text).toContain('Такого клиента в вашей CRM нет');
    expect((await press(pay.remind('tomorrow', foreignContactId))).text).toContain('Такого клиента в вашей CRM нет');
    expect(await events(foreignContactId)).toEqual([]);
    const t = await pool.query(`SELECT 1 FROM crm_tasks WHERE contact_id = $1`, [foreignContactId]);
    expect(t.rowCount).toBe(0);
  });

  it('«Завтра 10:00» — задача клиенту на 10:00 по Камчатке; повтор вторую не заводит', async () => {
    await press(pay.remind('tomorrow', contactId));
    const again = await press(pay.remind('tomorrow', contactId));
    expect(again.text).toContain('уже есть — вторую не завожу');
    const { rows } = await pool.query<{ title: string; due: string; origin: string; created_by: string | null }>(
      `SELECT title, to_char(due_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD HH24:MI') AS due, origin, created_by::text AS created_by
         FROM crm_tasks WHERE contact_id = $1`, [contactId],
    );
    expect(rows).toEqual([{ title: 'Связаться с клиентом', due: '2026-10-31 10:00', origin: 'manual', created_by: userId }]);
  });

  it('«На завтра» и «Готово» — только задача карточки чата; чужая остаётся как была', async () => {
    const mine = (await pool.query<{ id: string }>(
      `INSERT INTO crm_tasks (partner_id, title, due_at, reminded_at, reminder_channel)
       VALUES ($1, 'Счёт группе', $2, NOW(), 'max') RETURNING id`, [partnerId, new Date(NOW + 3 * 3_600_000).toISOString()],
    )).rows[0]!.id;
    const theirs = (await pool.query<{ id: string }>(
      `INSERT INTO crm_tasks (partner_id, title, due_at) VALUES ($1, 'Чужая задача', $2) RETURNING id`, [otherId, new Date(NOW).toISOString()],
    )).rows[0]!.id;

    const moved = await press(pay.taskTomorrow(mine));
    expect(moved.text).toContain('Перенёс «Счёт группе» на завтра, 10:00.');
    const after = (await pool.query<{ due: string; reminded: boolean }>(
      `SELECT to_char(due_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD HH24:MI') AS due, reminded_at IS NOT NULL AS reminded
         FROM crm_tasks WHERE id = $1`, [mine],
    )).rows[0];
    // Новый срок — новое напоминание (lib/crm/tasks updateTask).
    expect(after).toEqual({ due: '2026-10-31 10:00', reminded: false });

    expect((await press(pay.taskDone(theirs))).text).toContain('не найдена среди ваших');
    expect((await press(pay.taskTomorrow(theirs))).text).toContain('не найдена среди ваших');
    const t = (await pool.query<{ done: boolean; due: string }>(
      `SELECT done_at IS NOT NULL AS done, due_at::text AS due FROM crm_tasks WHERE id = $1`, [theirs],
    )).rows[0];
    expect(t?.done).toBe(false);

    const done = await press(pay.taskDone(mine));
    expect(done.text).toContain('Готово: «Счёт группе».');
    const row = (await pool.query<{ done_by: string | null }>(`SELECT done_by::text AS done_by FROM crm_tasks WHERE id = $1`, [mine])).rows[0];
    expect(row?.done_by).toBe(userId);
    expect((await press(pay.taskDone(mine))).text).toContain('уже закрыта');
  });

  describe('поиск клиента', () => {
    const waits = async () => (await pool.query<{ status: string }>(
      `SELECT status FROM chat_cabinet_waits WHERE chat_id = $1 ORDER BY created_at, id`, [CHAT],
    )).rows.map((r) => r.status);
    const reasonWait = async () => (await pool.query<{ id: string }>(
      `INSERT INTO partner_chat_actions (partner_id, channel, chat_id, subject_kind, subject_id, action, status, expires_at)
       VALUES ($1, 'max', $2, 'booking', '501', 'cancel', 'awaiting_reason', NOW() + INTERVAL '15 minutes') RETURNING id`,
      [partnerId, CHAT],
    )).rows[0]!.id;
    const partner = async () => {
      const { findPartnerByChat } = await import('@/lib/kuzmich/operator-chat');
      const r = await findPartnerByChat('max', CHAT);
      if (r.outcome !== 'found') throw new Error('карточка чата не найдена');
      return r.partner;
    };

    it('кнопка гасит ожидание причины отказа брони; одно ожидание поиска на чат', async () => {
      const reason = await reasonWait();
      await press(pay.search());
      await press(pay.search());
      expect(await waits()).toEqual(['superseded', 'waiting']);
      const r = await pool.query<{ status: string }>(`SELECT status FROM partner_chat_actions WHERE id = $1`, [reason]);
      expect(r.rows[0]?.status).toBe('superseded');
    });

    it('следующий текст — запрос: свой клиент найден, чужой с тем же именем — нет; ожидание исполнено', async () => {
      const s = await svc.captureCabinetSearch({ chatId: CHAT, partner: await partner(), text: 'анна' });
      expect(s?.text).toContain('Найдено: 1.');
      expect(s?.rows.flat().map((b) => b.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^Анна П\. · /)]));
      expect(JSON.stringify(s)).not.toContain('Чужая');
      expect((await waits()).at(-1)).toBe('used');
      // Ожидание исполнено — следующий текст не запрос.
      expect(await svc.captureCabinetSearch({ chatId: CHAT, partner: await partner(), text: 'анна' })).toBeNull();
    });

    it('кнопка, нажатая после поиска, главная: поиск уступает и гаснет', async () => {
      await press(pay.search());
      // Чуть позже — «Отклонить» под бронью: её ожидание создано после поиска.
      await new Promise((r) => setTimeout(r, 15));
      await reasonWait();
      expect(await svc.captureCabinetSearch({ chatId: CHAT, partner: await partner(), text: 'анна' })).toBeNull();
      expect((await waits()).at(-1)).toBe('superseded');
    });

    it('«не надо» — отмена; кнопка «Не надо» — тоже', async () => {
      await press(pay.search());
      const s = await svc.captureCabinetSearch({ chatId: CHAT, partner: await partner(), text: 'Не надо' });
      expect(s?.text).toContain('Поиск отменён.');
      expect((await waits()).at(-1)).toBe('cancelled');
      await press(pay.search());
      expect((await press(pay.searchCancel())).text).toContain('Поиск отменён.');
      expect((await waits()).at(-1)).toBe('cancelled');
    });
  });

  describe('утренняя сводка', () => {
    /** 30.10 08:12 по Камчатке. */
    const AT = new Date(Date.UTC(2026, 9, 29, 20, 12));

    it('кандидаты: кабинет чата — старшая карточка; после строки сводки — не кандидат до следующих суток', async () => {
      const { rows } = await pool.query<{ partner_id: string; max_cabinet: boolean }>(digest.DIGEST_CANDIDATES_SQL, ['2026-10-30', 50]);
      const byId = new Map(rows.map((r) => [r.partner_id, r.max_cabinet]));
      expect(byId.get(partnerId)).toBe(true);
      expect(byId.get(youngerId)).toBe(false);
      expect(byId.get(otherId)).toBe(true);

      const claim = await pool.query(digest.DIGEST_CLAIM_SQL, [partnerId, '2026-10-30', 'sending']);
      expect(claim.rowCount).toBe(1);
      expect((await pool.query(digest.DIGEST_CLAIM_SQL, [partnerId, '2026-10-30', 'sending'])).rowCount).toBe(0);
      await pool.query(digest.DIGEST_RELEASE_SQL, [partnerId, '2026-10-30']);
      expect((await pool.query(digest.DIGEST_CLAIM_SQL, [partnerId, '2026-10-30', 'sending'])).rowCount).toBe(1);
      await pool.query(digest.DIGEST_FINISH_SQL, [partnerId, '2026-10-30', 'max']);
      // Итог записан — снятие его не трогает.
      await pool.query(digest.DIGEST_RELEASE_SQL, [partnerId, '2026-10-30']);
      const left = await pool.query<{ partner_id: string }>(digest.DIGEST_CANDIDATES_SQL, ['2026-10-30', 50]);
      expect(left.rows.map((r) => r.partner_id)).not.toContain(partnerId);
      const tomorrow = await pool.query<{ partner_id: string }>(digest.DIGEST_CANDIDATES_SQL, ['2026-10-31', 50]);
      expect(tomorrow.rows.map((r) => r.partner_id)).toContain(partnerId);
      await expect(pool.query(digest.DIGEST_CLAIM_SQL, [otherId, '2026-10-30', 'late'])).rejects.toMatchObject({ code: '23514' });
    });

    it('прогон целиком: настоящие задачи и строки, отправка подменена', async () => {
      await pool.query(`DELETE FROM crm_chat_digests`);
      const r = await digest.runMorningDigest(AT, { sendTelegram: async () => true });
      expect(r.window).toBe(true);
      expect(r.query_failed).toBe(false);
      const rows = await pool.query<{ partner_id: string; channel: string }>(
        `SELECT partner_id::text AS partner_id, channel FROM crm_chat_digests WHERE digest_date = '2026-10-30'`,
      );
      const by = new Map(rows.rows.map((x) => [x.partner_id, x.channel]));
      // У кабинетной задача по клиенту — на завтра, «Счёт группе» закрыт, входящих нет: сводка не нужна.
      expect(by.get(partnerId)).toBe('empty');
      expect(by.get(youngerId)).toBe('unreachable');
      // Чужая карточка: её задача на сегодня — сводка ушла в MAX.
      expect(by.get(otherId)).toBe('max');
      // Второй прогон того же утра — никому второй сводки.
      const again = await digest.runMorningDigest(AT, { sendTelegram: async () => true });
      expect(again.sent_max + again.sent_tg + again.sent_stub).toBe(0);
    });
  });
});
