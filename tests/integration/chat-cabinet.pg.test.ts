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
 *  - «Найти клиента»: одно ожидание на чат, и два одновременных нажатия —
 *    оба «жду запрос», без ложного отказа; кнопка гасит ожидание причины
 *    отказа брони и сообщения по заявке; другая кнопка кабинета гасит поиск;
 *    кнопке брони, нажатой позже, поиск уступает и запрос никуда не отдаёт;
 *    найденный клиент — только своей карточки;
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

    it('кнопка брони, нажатая после поиска, главная: поиск гаснет, а текст не уходит ни в поиск, ни дальше', async () => {
      await press(pay.search());
      // Чуть позже — «Отклонить» под бронью: её ожидание создано после поиска.
      await new Promise((r) => setTimeout(r, 15));
      await reasonWait();
      expect(await svc.awaitsCabinetSearch(CHAT)).toBe(true);
      const s = await svc.captureCabinetSearch({ chatId: CHAT, partner: await partner(), text: 'анна' });
      expect(s?.text).toContain('Поиск клиента снят');
      expect(s?.text).not.toContain('Найдено');
      expect((await waits()).at(-1)).toBe('superseded');
      expect(await svc.awaitsCabinetSearch(CHAT)).toBe(false);
    });

    it('другая кнопка кабинета («Задачи») снимает поиск: следующий текст — не запрос', async () => {
      await press(pay.search());
      expect(await svc.awaitsCabinetSearch(CHAT)).toBe(true);
      await press(pay.tasks());
      expect((await waits()).at(-1)).toBe('superseded');
      expect(await svc.captureCabinetSearch({ chatId: CHAT, partner: await partner(), text: 'запиши звонок Анне' })).toBeNull();
    });

    it('два одновременных «Найти клиента» (повтор апдейта) — оба «жду запрос», ожидание одно', async () => {
      const [a, b] = await Promise.all([press(pay.search()), press(pay.search())]);
      for (const x of [a, b]) {
        expect(x.text).toContain('<b>Найти клиента</b>');
        expect(x.text).not.toContain('База не ответила');
      }
      const n = await pool.query(`SELECT 1 FROM chat_cabinet_waits WHERE chat_id = $1 AND status = 'waiting'`, [CHAT]);
      expect(n.rowCount).toBe(1);
      await press(pay.searchCancel());
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
      const { rows } = await pool.query<{ partner_id: string; max_cabinet: boolean }>(digest.DIGEST_CANDIDATES_SQL, ['2026-10-30', 50, 'morning']);
      const byId = new Map(rows.map((r) => [r.partner_id, r.max_cabinet]));
      expect(byId.get(partnerId)).toBe(true);
      expect(byId.get(youngerId)).toBe(false);
      expect(byId.get(otherId)).toBe(true);

      const claim = await pool.query(digest.DIGEST_CLAIM_SQL, [partnerId, '2026-10-30', 'sending']);
      expect(claim.rowCount).toBe(1);
      expect((await pool.query(digest.DIGEST_CLAIM_SQL, [partnerId, '2026-10-30', 'sending'])).rowCount).toBe(0);
      await pool.query(digest.DIGEST_RELEASE_SQL, [partnerId, '2026-10-30']);
      expect((await pool.query(digest.DIGEST_CLAIM_SQL, [partnerId, '2026-10-30', 'sending'])).rowCount).toBe(1);
      // «Отправляется» — не разобран: счёт дня его не видит.
      expect((await pool.query<{ n: number }>(digest.DIGEST_DONE_TODAY_SQL, ['2026-10-30'])).rows[0]?.n).toBe(0);
      await pool.query(digest.DIGEST_FINISH_SQL, [partnerId, '2026-10-30', 'max']);
      expect((await pool.query<{ n: number }>(digest.DIGEST_DONE_TODAY_SQL, ['2026-10-30'])).rows[0]?.n).toBe(1);
      // Итог записан — снятие его не трогает.
      await pool.query(digest.DIGEST_RELEASE_SQL, [partnerId, '2026-10-30']);
      const left = await pool.query<{ partner_id: string }>(digest.DIGEST_CANDIDATES_SQL, ['2026-10-30', 50, 'morning']);
      expect(left.rows.map((r) => r.partner_id)).not.toContain(partnerId);
      const tomorrow = await pool.query<{ partner_id: string }>(digest.DIGEST_CANDIDATES_SQL, ['2026-10-31', 50, 'morning']);
      expect(tomorrow.rows.map((r) => r.partner_id)).toContain(partnerId);
      await expect(pool.query(digest.DIGEST_CLAIM_SQL, [otherId, '2026-10-30', 'late'])).rejects.toMatchObject({ code: '23514' });
    });

    it('прогон целиком: настоящие задачи и строки, отправка подменена', async () => {
      await pool.query(`DELETE FROM crm_chat_digests`);
      const r = await digest.runChatDigest(AT, { sendTelegram: async () => true });
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
      const again = await digest.runChatDigest(AT, { sendTelegram: async () => true });
      expect(again.sent_max + again.sent_tg + again.sent_stub).toBe(0);
    });

    it('время сводки (1353): кнопка пишет карточке чата; кандидат — только в своё окно; «не присылать» — никогда', async () => {
      const at = (slot: string) => pool.query<{ partner_id: string }>(digest.DIGEST_CANDIDATES_SQL, ['2026-11-02', 50, slot]);
      const ids = async (slot: string) => (await at(slot)).rows.map((r) => r.partner_id);
      // Строки нет — утром.
      expect(await ids('morning')).toContain(otherId);
      expect(await ids('evening')).not.toContain(otherId);
      const chosen = await svc.handleCabinetPress({ channel: 'max', chatId: OTHER_CHAT, privateChat: true, payload: pay.digestSet('evening'), nowMs: NOW });
      expect(chosen.text).toContain('вечером, с 18:00');
      const row = (await pool.query<{ digest: string }>(`SELECT digest FROM chat_cabinet_settings WHERE partner_id = $1`, [otherId])).rows[0];
      expect(row?.digest).toBe('evening');
      expect(await ids('morning')).not.toContain(otherId);
      expect(await ids('evening')).toContain(otherId);
      // Повтор того же нажатия — та же строка, не вторая.
      await svc.handleCabinetPress({ channel: 'max', chatId: OTHER_CHAT, privateChat: true, payload: pay.digestSet('off'), nowMs: NOW });
      const all = await pool.query(`SELECT 1 FROM chat_cabinet_settings WHERE partner_id = $1`, [otherId]);
      expect(all.rowCount).toBe(1);
      for (const slot of ['morning', 'day', 'evening']) expect(await ids(slot)).not.toContain(otherId);
      await expect(pool.query(
        `INSERT INTO chat_cabinet_settings (partner_id, digest) VALUES ($1, 'night')`, [partnerId],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('менеджер команды и счёт (1353)', () => {
    const MEMBER_CHAT = 8_201;
    let memberUser = '';
    let memberRow = '';

    beforeAll(async () => {
      memberUser = (await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role) VALUES ('cab-mgr@example.com', 'Менеджер кабинета', 'x', 'operator') RETURNING id`,
      )).rows[0]!.id;
      memberRow = (await pool.query<{ id: string }>(
        `INSERT INTO operator_members (partner_id, user_id, status, accepted_at, max_chat_id, channel_bound_at)
         VALUES ($1, $2, 'active', NOW(), $3, NOW()) RETURNING id`, [partnerId, memberUser, MEMBER_CHAT],
      )).rows[0]!.id;
    });

    it('чат менеджера — его карточка оператора и его аккаунт; снят — чата нет', async () => {
      const { findMemberByChat } = await import('@/lib/operators/member-chat');
      const found = await findMemberByChat('max', MEMBER_CHAT);
      expect(found).toMatchObject({ outcome: 'found', member: { memberId: memberRow, partner: { partnerId, userId: memberUser } } });
      expect(await findMemberByChat('telegram', MEMBER_CHAT)).toEqual({ outcome: 'none' });
      await pool.query(`UPDATE operator_members SET status = 'revoked', revoked_at = NOW() WHERE id = $1`, [memberRow]);
      expect(await findMemberByChat('max', MEMBER_CHAT)).toEqual({ outcome: 'none' });
      await pool.query(`UPDATE operator_members SET status = 'active', revoked_at = NULL WHERE id = $1`, [memberRow]);
    });

    it('один чат у менеджеров двух команд — «не смог проверить», а не чей-то кабинет', async () => {
      const { findMemberByChat } = await import('@/lib/operators/member-chat');
      const otherUser = (await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role) VALUES ('cab-mgr2@example.com', 'Второй', 'x', 'operator') RETURNING id`,
      )).rows[0]!.id;
      const twin = (await pool.query<{ id: string }>(
        `INSERT INTO operator_members (partner_id, user_id, status, accepted_at, max_chat_id, channel_bound_at)
         VALUES ($1, $2, 'active', NOW(), $3, NOW()) RETURNING id`, [otherId, otherUser, MEMBER_CHAT],
      )).rows[0]!.id;
      expect(await findMemberByChat('max', MEMBER_CHAT)).toEqual({ outcome: 'unavailable' });
      await pool.query(`DELETE FROM operator_members WHERE id = $1`, [twin]);
    });

    it('кнопка из чата менеджера: «Готово» пишет менеджер; сводку он не настраивает; счёт — с местом member', async () => {
      const task = (await pool.query<{ id: string }>(
        `INSERT INTO crm_tasks (partner_id, title, due_at) VALUES ($1, 'Счёт менеджеру', $2) RETURNING id`,
        [partnerId, new Date(NOW + 3_600_000).toISOString()],
      )).rows[0]!.id;
      const m = (payload: string) => svc.handleCabinetPress({ channel: 'max', chatId: MEMBER_CHAT, privateChat: true, payload, nowMs: NOW });
      expect((await m(pay.taskDone(task))).text).toContain('Готово: «Счёт менеджеру».');
      const done = (await pool.query<{ done_by: string | null }>(`SELECT done_by::text AS done_by FROM crm_tasks WHERE id = $1`, [task])).rows[0];
      expect(done?.done_by).toBe(memberUser);
      await m(pay.digestSet('off'));
      const set = await pool.query(`SELECT 1 FROM chat_cabinet_settings WHERE partner_id = $1`, [partnerId]);
      expect(set.rowCount).toBe(0);
      const usage = await pool.query<{ seat: string; action: string; outcome: string; n: number }>(
        `SELECT seat, action, outcome, n FROM chat_cabinet_usage WHERE partner_id = $1 AND seat = 'member' ORDER BY action`, [partnerId],
      );
      expect(usage.rows).toEqual([
        { seat: 'member', action: 'digest_set', outcome: 'ok', n: 1 },
        { seat: 'member', action: 'task_done', outcome: 'ok', n: 1 },
      ]);
    });

    it('счёт: повтор того же дня складывается в одну строку; день — камчатский; лишнее место база не примет', async () => {
      const before = (await pool.query<{ n: number }>(
        `SELECT COALESCE(SUM(n), 0)::int AS n FROM chat_cabinet_usage WHERE partner_id = $1 AND action = 'clients' AND seat = 'owner'`, [partnerId],
      )).rows[0]!.n;
      await press(pay.clients());
      await press(pay.clients());
      const rows = (await pool.query<{ day: string; n: number }>(
        `SELECT day::text AS day, n FROM chat_cabinet_usage WHERE partner_id = $1 AND action = 'clients' AND seat = 'owner'`, [partnerId],
      )).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ day: '2026-10-30', n: before + 2 });
      const { CABINET_USAGE_SQL } = await import('@/lib/chat-cabinet/usage');
      await expect(pool.query(CABINET_USAGE_SQL, ['2026-10-30', partnerId, 'guest', 'max', 'tasks', 'ok'])).rejects.toMatchObject({ code: '23514' });
    });

    it('перепись: числа на настоящей схеме, без чатов и текстов', async () => {
      process.env.CRON_SECRET = 'census-secret-for-test';
      const { NextRequest } = await import('next/server');
      const { GET } = await import('@/app/api/cron/chat-cabinet-census/route');
      const res = await GET(new NextRequest('http://localhost/api/cron/chat-cabinet-census?days=400', {
        headers: { authorization: 'Bearer census-secret-for-test' },
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, { refused?: boolean; data?: unknown }> & { days: number; totals: { ok: number } | null };
      expect(body.days).toBe(90);
      for (const k of ['by_action', 'by_day', 'by_partner', 'reachable_partners', 'reachable_members', 'digests']) {
        expect(body[k]?.refused, k).toBe(false);
      }
      expect(body.totals?.ok).toBeGreaterThan(0);
      expect(body.reachable_members?.data).toBe(1);
      const text = JSON.stringify(body);
      for (const leak of [String(CHAT), String(MEMBER_CHAT), 'Анна', 'Петрова', '+79140001122']) expect(text, leak).not.toContain(leak);
      const unauth = await GET(new NextRequest('http://localhost/api/cron/chat-cabinet-census'));
      expect(unauth.status).toBe(401);
    });
  });
});
