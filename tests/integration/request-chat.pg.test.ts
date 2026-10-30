/**
 * Переписка адресата заявки и клиента на настоящем PostgreSQL (1349, 1350;
 * слово владельца 30.10: «Единый чат для всех»).
 *
 * Судится весь путь своим кодом на схеме прода, для обеих целей:
 *  - заявка на жильё: ключ статуса → страница заявки, сообщение гостя → MAX
 *    хозяина с кнопкой «Ответить гостю», кнопка → ожидание → следующий текст
 *    хозяина уходит гостю, «Старт» гостя по ключу подключает его чат и не
 *    перезаписывает чужой, «отмена» гасит ожидание, чужой чат на кнопку не
 *    пускается;
 *  - лид перевозчику: повтор лида узнаётся на базе (`created: false`), и его
 *    ключ переписку НЕ открывает — ни страницей, ни «Стартом», ни статусом для
 *    помощника; ключ новой заявки открывает; кнопка «Ответить клиенту»
 *    работает только из чата адресата; своя проба и лид без адресата
 *    переписки не имеют.
 * CRM: заявка — клиент адресата, сообщения ложатся в ленту без текста,
 * «Входящие» видят ответ в переписке. Миграция 1350 повторяется без вреда, а
 * сообщение без цели или с двумя целями база не примет.
 * Подменена только отправка (MAX и pd-alert) и рабочий чат админа: судится
 * то, что им передано.
 *
 * Своя база `request_chat_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase } from '../helpers/pg-schema';

const sent = vi.hoisted(() => ({
  pd: [] as Array<{ text: string; stub: string; buttons?: unknown[]; to?: { maxChatId?: unknown } }>,
  dm: [] as Array<{ chatId: unknown; text: string; buttons?: unknown[] }>,
  /** Рабочий чат платформы не принимает — проверка «не получил и оператор». */
  adminFails: false,
}));

vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: vi.fn(async (p: { text: string; stub: string; buttons?: unknown[]; to?: { maxChatId?: unknown } }) => {
    sent.pd.push(p);
    if (!p.to && sent.adminFails) return { channel: 'none', delivered: false, reason: 'рабочий чат не настроен' };
    return p.to?.maxChatId
      ? { channel: 'max', delivered: true, reason: 'доставлено в MAX' }
      : { channel: 'max', delivered: true, reason: 'рабочий чат' };
  }),
}));

vi.mock('@/lib/notifications/max-channel', () => ({
  maxSendDm: vi.fn(async (chatId: unknown, text: string, opts?: { buttons?: unknown[] }) => {
    sent.dm.push({ chatId, text, buttons: opts?.buttons });
    return { ok: true };
  }),
}));

// Рабочий чат админа о новом лиде (createLead) — сеть, не предмет этого файла.
vi.mock('@/lib/notifications/telegram-channel', () => ({
  notifyAdminNewLead: vi.fn(async () => undefined),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[request-chat.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'request_chat_test';
const OWNER_CHAT = 7001;
const GUEST_CHAT = 7002;
const STRANGER_CHAT = 7003;
const CARRIER_CHAT = 7004;
const CLIENT_CHAT = 7005;
const OTHER_PARTNER_CHAT = 7006;

withPg('переписка по заявке на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let svc: typeof import('@/lib/requests/request-chat-service');
  let status: typeof import('@/lib/mcp/request-status');
  let leads: typeof import('@/lib/leads/create');
  let consentOf: (purpose: 'carrier' | 'operator') => import('@/lib/legal/pd-consent').PdConsentRecord | null;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    svc = await import('@/lib/requests/request-chat-service');
    status = await import('@/lib/mcp/request-status');
    leads = await import('@/lib/leads/create');
    const { buildConsentRecord } = await import('@/lib/legal/pd-consent');
    consentOf = (purpose) => buildConsentRecord(true, '203.0.113.9', 'transfer-page', purpose);
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  // ── Заявка на жильё (1349) ──────────────────────────────────────────────────

  describe('заявка на жильё', () => {
    let partnerId = '';
    let requestId = '';
    let key = '';
    const stay = () => ({ kind: 'stay' as const, id: requestId });

    beforeAll(async () => {
      const p = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_public, is_verified, max_chat_id)
         VALUES ('Кутха', 'stay', '{"phone":"+70000000001"}', FALSE, FALSE, $1) RETURNING id`, [OWNER_CHAT],
      );
      partnerId = p.rows[0].id;
      const acc = await pool.query<{ id: string }>(
        `INSERT INTO accommodations (name, type, coordinates, contact_phone, partner_id)
         VALUES ('Кутха', 'guesthouse', '{"lat":53.0,"lng":158.6}', '+70000000001', $1) RETURNING id`, [partnerId],
      );
      const { PD_CONSENT_STAY_VERSION } = await import('@/lib/legal/pd-consent');
      const sr = await pool.query<{ id: string }>(
        `INSERT INTO stay_requests (accommodation_id, check_in_date, check_out_date, guests, guest_name, guest_phone,
                                    pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version, door)
         VALUES ($1, '2099-07-10', '2099-07-12', 6, 'Анна Гостева', '+79990001122',
                 NOW(), '203.0.113.9', 'stay-request', $2, 'form') RETURNING id`,
        [acc.rows[0].id, PD_CONSENT_STAY_VERSION],
      );
      requestId = sr.rows[0].id;
      key = (await status.issueRequestKey({ stayRequestId: requestId }, status.STAY_FORM_KEY_NAME, { opensChat: true })) ?? '';
    });

    it('ключ формы выдан, открывает переписку и даёт согласие «владельцу жилья»', async () => {
      expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(await status.readConsentPurpose(key)).toBe('stay');
      const k = await pool.query(`SELECT opens_chat FROM agent_request_keys WHERE stay_request_id = $1`, [requestId]);
      expect(k.rows).toEqual([{ opens_chat: true }]);
    });

    it('страница: переписка пуста, адресат — владелец, без имени и телефона гостя', async () => {
      const r = await svc.readRequestChat(key);
      expect(r.outcome).toBe('ok');
      if (r.outcome !== 'ok') return;
      expect(r.messages).toEqual([]);
      expect(r.guestBound).toBe(false);
      expect(r.ownerOnMax).toBe(true);
      expect(r.facts).toMatchObject({ target: 'stay', title: 'Кутха', role: 'stay', people: 6 });
      const json = JSON.stringify(r);
      expect(json).not.toContain('Анна');
      expect(json).not.toContain('+7999');
    });

    it('неверный ключ и ключ не той формы — не переписка', async () => {
      expect((await svc.readRequestChat('x')).outcome).toBe('bad_key');
      expect((await svc.readRequestChat('A'.repeat(32))).outcome).toBe('not_found');
    });

    it('сообщение гостя со страницы уходит в MAX хозяина с кнопкой «Ответить гостю»', async () => {
      sent.pd.length = 0;
      const r = await svc.postGuestMessage(stay(), 'Можно заехать в 12?', 'page');
      expect(r).toEqual({ outcome: 'sent', delivery: 'max' });
      expect(sent.pd).toHaveLength(1);
      expect(String(sent.pd[0].to?.maxChatId)).toBe(String(OWNER_CHAT));
      expect(sent.pd[0].text).toContain('Можно заехать в 12?');
      expect(sent.pd[0].text).toContain('Анна Гостева');
      expect(sent.pd[0].stub).not.toContain('Анна');
      expect(sent.pd[0].stub).not.toContain('Можно заехать');
      expect(sent.pd[0].buttons).toEqual([{ text: 'Ответить гостю', payload: `sq:o:${requestId}` }]);
      const m = await pool.query(
        `SELECT author, door, delivery_channel, lead_id FROM request_messages WHERE stay_request_id = $1`, [requestId],
      );
      expect(m.rows).toEqual([{ author: 'guest', door: 'page', delivery_channel: 'max', lead_id: null }]);
    });

    it('CRM: заявка — клиент хозяина, сообщение в ленте без текста', async () => {
      const link = await pool.query(
        `SELECT l.partner_id FROM crm_contact_links l WHERE l.source_kind = 'stay_request' AND l.source_id = $1`, [requestId],
      );
      expect(link.rows).toEqual([{ partner_id: partnerId }]);
      const ev = await pool.query(
        `SELECT kind, actor_kind, title, payload::text AS payload FROM crm_events
          WHERE source_kind = 'stay_request' AND source_id = $1`, [requestId],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0]).toMatchObject({ kind: 'message_in', actor_kind: 'tourist' });
      expect(`${ev.rows[0].title}${ev.rows[0].payload}`).not.toContain('Можно заехать');
    });

    it('«Входящие» хозяина: заявка ждёт ответа', async () => {
      const { INBOX_SQL } = await import('@/lib/crm/inbox-sql');
      const r = await pool.query(INBOX_SQL.stay_request, [partnerId, new Date(Date.now() - 7 * 86400_000)]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ item_id: requestId, title: 'Кутха', waiting: true, responded_at: null, people: 6 });
    });

    it('кнопка хозяина из чужого чата не заводит ожидания', async () => {
      const r = await svc.armChatWait('owner', stay(), STRANGER_CHAT);
      expect(r.text).toMatch(/адресована не вам/);
      expect(await svc.captureChatText(STRANGER_CHAT, 'привет')).toBeNull();
    });

    it('без кнопки текст хозяина гостю не уходит', async () => {
      expect(await svc.captureChatText(OWNER_CHAT, 'запиши звонок Анне')).toBeNull();
    });

    it('кнопка меню и команда при ожидании — не сообщение гостю, ожидание остаётся', async () => {
      await svc.armChatWait('owner', stay(), OWNER_CHAT);
      expect(await svc.captureChatText(OWNER_CHAT, 'Входящие')).toBeNull();
      expect(await svc.captureChatText(OWNER_CHAT, '/start')).toBeNull();
      const cancelled = await svc.captureChatText(OWNER_CHAT, '/cancel');
      expect(cancelled?.text).toMatch(/Не отправляю/);
    });

    it('кнопка → ответ хозяина; гость без MAX видит его на странице', async () => {
      sent.dm.length = 0;
      const armed = await svc.armChatWait('owner', stay(), OWNER_CHAT);
      expect(armed.text).toMatch(/Напишите ответ гостю/);
      const r = await svc.captureChatText(OWNER_CHAT, 'Да, ждём с 12:00');
      expect(r?.text).toMatch(/MAX гость пока не подключил/);
      expect(r?.buttons).toEqual([{ text: 'Ответить гостю', payload: `sq:o:${requestId}` }]);
      expect(sent.dm).toHaveLength(0);
      // Ожидание погасло: следующий текст — снова обычным путём.
      expect(await svc.captureChatText(OWNER_CHAT, 'ещё')).toBeNull();
      const page = await svc.readRequestChat(key);
      expect(page.outcome === 'ok' && page.messages.map((m) => [m.author, m.body])).toEqual([
        ['guest', 'Можно заехать в 12?'], ['owner', 'Да, ждём с 12:00'],
      ]);
    });

    it('статус для помощника (MCP, A2A): владелец ответил, текста нет, есть ссылка подключить MAX', async () => {
      const v = await status.readRequestStatus(key);
      expect(v.partner_replies).toBe(1);
      expect(v.partner_last_reply_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(v.max_link).toMatch(new RegExp(`\\?start=sq_${key}$`));
      expect(v.human).toMatch(/Владелец уже ответил/);
      expect(JSON.stringify(v)).not.toContain('ждём с 12:00');
      expect(JSON.stringify(v)).not.toContain('Можно заехать');
    });

    it('«Входящие»: после ответа хозяина заявка не ждёт', async () => {
      const { INBOX_SQL } = await import('@/lib/crm/inbox-sql');
      const r = await pool.query(INBOX_SQL.stay_request, [partnerId, new Date(Date.now() - 7 * 86400_000)]);
      expect(r.rows[0].waiting).toBe(false);
      expect(r.rows[0].responded_at).not.toBeNull();
    });

    it('«Старт» гостя по ключу подключает чат и присылает ответ владельца; чужой чат не перезаписывает', async () => {
      const replies = await svc.bindGuestChat(key, GUEST_CHAT);
      expect(replies[0].text).toMatch(/Готово/);
      expect(replies.map((r) => r.text).join('\n')).toContain('Да, ждём с 12:00');
      expect(replies.at(-1)?.buttons).toEqual([{ text: 'Написать владельцу', payload: `sq:g:${requestId}` }]);
      const again = await svc.bindGuestChat(key, STRANGER_CHAT);
      expect(again[0].text).toMatch(/уже подключён другой чат/);
      const row = await pool.query(`SELECT guest_max_chat_id::text AS c FROM stay_requests WHERE id = $1`, [requestId]);
      expect(row.rows[0].c).toBe(String(GUEST_CHAT));
    });

    it('после подключения MAX статус ссылку подключения не даёт', async () => {
      expect((await status.readRequestStatus(key)).max_link).toBeNull();
    });

    it('ответ хозяина уходит в MAX гостя с кнопкой «Написать владельцу»', async () => {
      sent.dm.length = 0;
      await svc.armChatWait('owner', stay(), OWNER_CHAT);
      const r = await svc.captureChatText(OWNER_CHAT, 'Баня с 18:00');
      expect(r?.text).toMatch(/Передал гостю в MAX/);
      expect(sent.dm).toHaveLength(1);
      expect(String(sent.dm[0].chatId)).toBe(String(GUEST_CHAT));
      expect(sent.dm[0].text).toContain('Баня с 18:00');
      expect(sent.dm[0].text).not.toContain('Анна');
      expect(sent.dm[0].buttons).toEqual([{ text: 'Написать владельцу', payload: `sq:g:${requestId}` }]);
    });

    it('гость пишет из MAX после кнопки; «отмена» гасит ожидание', async () => {
      sent.pd.length = 0;
      await svc.armChatWait('guest', stay(), GUEST_CHAT);
      const cancelled = await svc.captureChatText(GUEST_CHAT, 'отмена');
      expect(cancelled?.text).toMatch(/Не отправляю/);
      expect(sent.pd).toHaveLength(0);
      await svc.armChatWait('guest', stay(), GUEST_CHAT);
      const r = await svc.captureChatText(GUEST_CHAT, 'Спасибо, будем к 12');
      expect(r?.text).toMatch(/Передал владельцу/);
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0].text).toContain('Спасибо, будем к 12');
    });

    it('кнопка гостя из чужого чата не заводит ожидания', async () => {
      const r = await svc.armChatWait('guest', stay(), STRANGER_CHAT);
      expect(r.text).toMatch(/не подключена к этому чату/);
    });

    it('карточка клиента и задел CRM читают заявку', async () => {
      const { SOURCE_SUMMARY_SQL } = await import('@/lib/crm/contact-queries');
      const s = await pool.query(SOURCE_SUMMARY_SQL.stay_request, [[requestId]]);
      expect(s.rows[0]).toMatchObject({ title: 'Кутха', status: 'answered', people: 6, person_name: 'Анна Гостева' });
      const ev = await pool.query<{ kind: string; actor_kind: string }>(
        `SELECT kind, actor_kind FROM crm_events WHERE source_kind = 'stay_request' AND source_id = $1 ORDER BY occurred_at, id`,
        [requestId],
      );
      expect(ev.rows.map((e) => `${e.kind}/${e.actor_kind}`)).toEqual([
        'message_in/tourist', 'message_out/partner_user', 'message_out/partner_user', 'message_in/tourist',
      ]);
      const { UNLINKED_PAGE_SQL } = await import('@/lib/crm/source-specs');
      const u = await pool.query(UNLINKED_PAGE_SQL.stay_request, ['00000000-0000-0000-0000-000000000000', 10]);
      expect(u.rows).toEqual([]);
    });

    it('кнопка хозяина «Свободно, беру» (30.10): ответ записан один раз, своим, гостю ушёл словами хозяина, заявка не ждёт', async () => {
      const { answerStayRequest } = await import('@/lib/stay/owner-answer-flow');
      const manager: string[] = [];
      const notify = async (t: string) => { manager.push(t); };
      // Чужой партнёр — не его заявка, ничего не записано.
      const other = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_public, is_verified) VALUES ('Другой дом', 'stay', '{}', FALSE, FALSE) RETURNING id`,
      );
      const alien = await answerStayRequest({
        partner: { partnerId: other.rows[0].id, partnerName: 'Другой дом' }, requestId, answer: 'free', via: 'max', db: pool, notifyManager: notify,
      });
      expect(alien.tell).toEqual({ kind: 'not_yours' });
      expect(manager).toEqual([]);

      const first = await answerStayRequest({
        partner: { partnerId, partnerName: 'Кутха' }, requestId, answer: 'free', via: 'max', db: pool, notifyManager: notify,
      });
      expect(first.tell.kind).toBe('answered');
      expect(first.facts).toEqual({ accommodationName: 'Кутха', checkIn: '2099-07-10', checkOut: '2099-07-12', guests: 6 });
      const row = await pool.query<{ owner_answer: string; via: string; at: string | null }>(
        `SELECT owner_answer, owner_answer_via AS via, owner_answered_at::text AS at FROM stay_requests WHERE id = $1`, [requestId],
      );
      expect(row.rows[0]).toMatchObject({ owner_answer: 'free', via: 'max' });
      expect(row.rows[0].at).not.toBeNull();
      // Гостю — словами хозяина, в переписку (видно на странице заявки).
      const last = await pool.query<{ author: string; body: string }>(
        `SELECT author, body FROM request_messages WHERE stay_request_id = $1 ORDER BY created_at DESC LIMIT 1`, [requestId],
      );
      expect(last.rows[0].author).toBe('owner');
      expect(last.rows[0].body).toContain('«Кутха»: свободно, ждём вас с 10.07.2099 по 12.07.2099');
      expect(last.rows[0].body).not.toMatch(/Анна|79990001122/);
      // Менеджеру — факт без имени и телефона гостя.
      expect(manager).toHaveLength(1);
      expect(manager[0]).toContain('ответил «свободно, беру»');
      expect(manager[0]).not.toMatch(/Анна|79990001122/);

      // Второе нажатие первое не переписывает.
      const again = await answerStayRequest({
        partner: { partnerId, partnerName: 'Кутха' }, requestId, answer: 'busy', via: 'telegram', db: pool, notifyManager: notify,
      });
      expect(again.tell).toEqual({ kind: 'already', answer: 'free' });
      expect(manager).toHaveLength(1);

      // «Входящие» и напоминание: заявка больше не ждёт.
      const { INBOX_SQL } = await import('@/lib/crm/inbox-sql');
      const inbox = await pool.query(INBOX_SQL.stay_request, [partnerId, new Date(Date.now() - 7 * 86400_000)]);
      expect(inbox.rows[0].waiting).toBe(false);
      const { INBOX_REMIND_SQL } = await import('@/lib/crm/inbox-reminders');
      const due = await pool.query(INBOX_REMIND_SQL.stay_request, [new Date(Date.now() + 3 * 3600_000).toISOString(), 120, 24]);
      expect(due.rows).toEqual([]);
    });

    it('удалили заявку — переписка и ожидания ушли с ней', async () => {
      await pool.query(`DELETE FROM stay_requests WHERE id = $1`, [requestId]);
      const m = await pool.query(`SELECT count(*)::int AS n FROM request_messages WHERE stay_request_id = $1`, [requestId]);
      const w = await pool.query(`SELECT count(*)::int AS n FROM request_chat_waits WHERE stay_request_id = $1`, [requestId]);
      expect(m.rows[0].n).toBe(0);
      expect(w.rows[0].n).toBe(0);
    });
  });

  // ── Лид перевозчику (1350) ──────────────────────────────────────────────────

  describe('заявка на машину перевозчику', () => {
    let carrierId = '';
    let leadId = '';
    let key = '';
    let repeatKey = '';
    const lead = () => ({ kind: 'lead' as const, id: leadId });
    const PHONE = '+79990003344';
    const COMMENT = '[Заявка на машину] «Шатун», с 2099-10-30, Авачинский перевал, человек: 12';

    beforeAll(async () => {
      carrierId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ('Шатун', 'transfer', '{}', $1) RETURNING id`,
        [CARRIER_CHAT],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ('Чужой оператор', 'operator', '{}', $1)`,
        [OTHER_PARTNER_CHAT],
      );
    });

    const createCharterLead = () => leads.createLeadDetailed({
      name: 'Иван Заказчик', phone: PHONE, comment: COMMENT,
      route_title: 'Вахтовка: Авачинский перевал', operator_id: carrierId,
      source_url: 'https://vedarai.ru/transfers/shatun', pd_consent: consentOf('carrier'),
      source_data: { source: 'transfer_page', kind: 'charter', passengers: 12 },
      skip_ai_processing: true,
    });

    it('новая заявка — created: true; повтор того же телефона и текста — прежний лид, created: false', async () => {
      const first = await createCharterLead();
      expect(first).toMatchObject({ created: true });
      leadId = first?.id ?? '';
      const again = await createCharterLead();
      expect(again).toEqual({ id: leadId, created: false });
      const n = await pool.query(`SELECT count(*)::int AS n FROM leads WHERE phone = $1`, [PHONE]);
      expect(n.rows[0].n).toBe(1);
      key = (await status.issueRequestKey({ leadId }, status.CHARTER_FORM_KEY_NAME, { opensChat: first?.created === true })) ?? '';
      repeatKey = (await status.issueRequestKey({ leadId }, status.CHARTER_FORM_KEY_NAME, { opensChat: again?.created === true })) ?? '';
      expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(repeatKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(await status.readConsentPurpose(key)).toBe('carrier');
    });

    it('ключ повтора — только статус: ни страницы переписки, ни отправки, ни «Старта»', async () => {
      expect((await svc.readRequestChat(repeatKey)).outcome).toBe('no_chat');
      expect((await svc.requestTargetByKey(repeatKey)).outcome).toBe('no_chat');
      const bound = await svc.bindGuestChat(repeatKey, STRANGER_CHAT);
      expect(bound[0].text).toMatch(/По этой ссылке переписки нет/);
      const row = await pool.query(`SELECT guest_max_chat_id FROM leads WHERE id = $1`, [leadId]);
      expect(row.rows[0].guest_max_chat_id).toBeNull();
      const v = await status.readRequestStatus(repeatKey);
      expect(v.state).not.toBe('unknown');
      expect(v.partner_replies).toBeNull();
      expect(v.max_link).toBeNull();
    });

    it('ключ новой заявки: переписка с перевозчиком пуста, без имени и телефона клиента', async () => {
      const r = await svc.readRequestChat(key);
      expect(r.outcome).toBe('ok');
      if (r.outcome !== 'ok') return;
      // Число людей — записанное дверью (passengers), а не group_size по умолчанию.
      expect(r.facts).toMatchObject({
        target: 'lead', title: 'Вахтовка: Авачинский перевал', role: 'carrier', counterpartName: 'Шатун', people: 12,
      });
      expect(r.messages).toEqual([]);
      expect(r.ownerOnMax).toBe(true);
      const json = JSON.stringify(r);
      expect(json).not.toContain('Иван');
      expect(json).not.toContain(PHONE);
    });

    it('сообщение клиента со страницы — в MAX перевозчика с кнопкой «Ответить клиенту»', async () => {
      sent.pd.length = 0;
      const t = await svc.requestTargetByKey(key);
      expect(t).toEqual({ outcome: 'ok', target: lead() });
      const r = await svc.postGuestMessage(lead(), 'Во сколько подача?', 'page');
      expect(r).toEqual({ outcome: 'sent', delivery: 'max' });
      expect(sent.pd).toHaveLength(1);
      expect(String(sent.pd[0].to?.maxChatId)).toBe(String(CARRIER_CHAT));
      expect(sent.pd[0].text).toContain('Сообщение клиента по заявке: Вахтовка: Авачинский перевал');
      expect(sent.pd[0].text).toContain('Клиент: Иван Заказчик');
      expect(sent.pd[0].stub).not.toContain('Иван');
      expect(sent.pd[0].stub).not.toContain('подача');
      expect(sent.pd[0].buttons).toEqual([{ text: 'Ответить клиенту', payload: `lq:o:${leadId}` }]);
      const m = await pool.query(
        `SELECT author, door, delivery_channel, stay_request_id FROM request_messages WHERE lead_id = $1`, [leadId],
      );
      expect(m.rows).toEqual([{ author: 'guest', door: 'page', delivery_channel: 'max', stay_request_id: null }]);
    });

    it('CRM перевозчика: лид — его клиент, сообщение в ленте без текста; «Входящие» — ждёт ответа', async () => {
      const link = await pool.query(`SELECT partner_id FROM crm_contact_links WHERE source_kind = 'lead' AND source_id = $1`, [leadId]);
      expect(link.rows).toEqual([{ partner_id: carrierId }]);
      const ev = await pool.query(
        `SELECT kind, actor_kind, payload::text AS payload FROM crm_events WHERE source_kind = 'lead' AND source_id = $1 AND kind = 'message_in'`,
        [leadId],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0].actor_kind).toBe('tourist');
      expect(ev.rows[0].payload).not.toContain('подача');
      const { INBOX_SQL } = await import('@/lib/crm/inbox-sql');
      const r = await pool.query(INBOX_SQL.lead, [carrierId, new Date(Date.now() - 7 * 86400_000)]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ item_id: leadId, waiting: true, responded_at: null, people: 12 });
    });

    it('кнопка «Ответить клиенту» из чата другого партнёра не заводит ожидания', async () => {
      const r = await svc.armChatWait('owner', lead(), OTHER_PARTNER_CHAT);
      expect(r.text).toMatch(/адресована не вам/);
      expect(await svc.captureChatText(OTHER_PARTNER_CHAT, 'Могу дешевле')).toBeNull();
    });

    it('кнопка перевозчика → ответ клиенту; клиент без MAX видит его на странице', async () => {
      sent.dm.length = 0;
      const armed = await svc.armChatWait('owner', lead(), CARRIER_CHAT);
      expect(armed.text).toMatch(/^Напишите ответ клиенту по заявке «Вахтовка: Авачинский перевал»/);
      const r = await svc.captureChatText(CARRIER_CHAT, 'Подача в 7:00 у гостиницы');
      expect(r?.text).toMatch(/MAX клиент пока не подключил/);
      expect(r?.buttons).toEqual([{ text: 'Ответить клиенту', payload: `lq:o:${leadId}` }]);
      expect(sent.dm).toHaveLength(0);
      const page = await svc.readRequestChat(key);
      expect(page.outcome === 'ok' && page.messages.map((m) => [m.author, m.body])).toEqual([
        ['guest', 'Во сколько подача?'], ['owner', 'Подача в 7:00 у гостиницы'],
      ]);
    });

    it('«Входящие»: ответ в переписке — заявка не ждёт, хотя статус лида ещё «новая»', async () => {
      const l = await pool.query(`SELECT status FROM leads WHERE id = $1`, [leadId]);
      expect(l.rows[0].status).toBe('new');
      const { INBOX_SQL } = await import('@/lib/crm/inbox-sql');
      const r = await pool.query(INBOX_SQL.lead, [carrierId, new Date(Date.now() - 7 * 86400_000)]);
      expect(r.rows[0].waiting).toBe(false);
      expect(r.rows[0].responded_at).not.toBeNull();
    });

    it('статус для помощника: адресат ответил — число без текста и ссылка MAX; ключу повтора — ничего', async () => {
      const v = await status.readRequestStatus(key);
      expect(v.kind).toBe('lead');
      expect(v.partner_replies).toBe(1);
      expect(v.partner_last_reply_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(v.max_link).toMatch(new RegExp(`\\?start=sq_${key}$`));
      expect(v.human).toMatch(/Адресат заявки ответил в переписке \(сообщений: 1\)/);
      expect(JSON.stringify(v)).not.toContain('Подача в 7:00');
      const r = await status.readRequestStatus(repeatKey);
      expect(r.partner_replies).toBeNull();
      expect(r.human).not.toMatch(/ответил в переписке/);
    });

    it('«Старт» клиента по ключу подключает чат к лиду и присылает ответ перевозчика', async () => {
      const replies = await svc.bindGuestChat(key, CLIENT_CHAT);
      expect(replies[0].text).toMatch(/Готово: ответы по заявке «Вахтовка: Авачинский перевал» \(Перевозчик «Шатун»\)/);
      expect(replies.map((r) => r.text).join('\n')).toContain('Подача в 7:00 у гостиницы');
      expect(replies.at(-1)?.buttons).toEqual([{ text: 'Написать перевозчику', payload: `lq:g:${leadId}` }]);
      const again = await svc.bindGuestChat(key, STRANGER_CHAT);
      expect(again[0].text).toMatch(/уже подключён другой чат/);
      const row = await pool.query(`SELECT guest_max_chat_id::text AS c FROM leads WHERE id = $1`, [leadId]);
      expect(row.rows[0].c).toBe(String(CLIENT_CHAT));
      expect((await status.readRequestStatus(key)).max_link).toBeNull();
    });

    it('клиент пишет из MAX после кнопки «Написать перевозчику»; ответ перевозчика уходит ему в MAX', async () => {
      sent.pd.length = 0;
      sent.dm.length = 0;
      expect((await svc.armChatWait('guest', lead(), STRANGER_CHAT)).text).toMatch(/не подключена к этому чату/);
      await svc.armChatWait('guest', lead(), CLIENT_CHAT);
      const r = await svc.captureChatText(CLIENT_CHAT, 'Нас будет 14');
      expect(r?.text).toMatch(/Передал перевозчику/);
      expect(sent.pd).toHaveLength(1);
      expect(String(sent.pd[0].to?.maxChatId)).toBe(String(CARRIER_CHAT));
      await svc.armChatWait('owner', lead(), CARRIER_CHAT);
      const back = await svc.captureChatText(CARRIER_CHAT, 'Возьмём вторую машину');
      expect(back?.text).toMatch(/Передал клиенту в MAX/);
      expect(sent.dm).toHaveLength(1);
      expect(String(sent.dm[0].chatId)).toBe(String(CLIENT_CHAT));
      expect(sent.dm[0].text).toContain('Перевозчик «Шатун»');
      expect(sent.dm[0].text).not.toContain('Иван');
      expect(sent.dm[0].buttons).toEqual([{ text: 'Написать перевозчику', payload: `lq:g:${leadId}` }]);
    });

    it('длинная переписка: страница показывает последние 200 сообщений, новые не прячутся за старыми', async () => {
      await pool.query(
        `INSERT INTO request_messages (lead_id, author, door, body, created_at)
         SELECT $1::uuid, 'owner', 'max', 'старое ' || g, NOW() + make_interval(secs => g)
           FROM generate_series(1, 205) g`,
        [leadId],
      );
      const r = await svc.readRequestChat(key);
      expect(r.outcome).toBe('ok');
      if (r.outcome !== 'ok') return;
      expect(r.messages).toHaveLength(200);
      expect(r.messages.at(-1)?.body).toBe('старое 205');
      expect(r.messages[0].body).toBe('старое 6');
      await pool.query(`DELETE FROM request_messages WHERE lead_id = $1 AND body LIKE 'старое %'`, [leadId]);
    });

    it('своя проба и лид без адресата — переписки нет, и это сказано', async () => {
      const self = await leads.createLeadDetailed({
        name: 'Проба', phone: '+79990005566', comment: 'проба формы перевозчика', operator_id: carrierId,
        pd_consent: consentOf('carrier'), is_self: true, skip_ai_processing: true,
      });
      const selfKey = (await status.issueRequestKey({ leadId: self?.id ?? '' }, status.CHARTER_FORM_KEY_NAME, { opensChat: true })) ?? '';
      expect((await svc.readRequestChat(selfKey)).outcome).toBe('no_counterpart');
      // Числа людей дверь не дала — его нет, а не «1».
      const people = await pool.query(`SELECT ${(await import('@/lib/leads/lead-people')).leadPeopleSql('l')} AS n FROM leads l WHERE l.id = $1`, [self?.id]);
      expect(people.rows[0].n).toBeNull();
      expect((await svc.armChatWait('owner', { kind: 'lead', id: self?.id ?? '' }, CARRIER_CHAT)).text).toMatch(/нет адресата/);

      const managed = await leads.createLeadDetailed({
        name: 'Мария', phone: '+79990007788', comment: 'подберите тур на вулкан', pd_consent: consentOf('operator'),
        skip_ai_processing: true,
      });
      const managedTarget = { kind: 'lead' as const, id: managed?.id ?? '' };
      // Ключ инструмента подбора (create_lead) переписку не открывает, и страница
      // говорит почему: заявку ведёт менеджер, а не «это повтор».
      const managedKey = (await status.issueRequestKey({ leadId: managed?.id ?? '' }, 'create_lead')) ?? '';
      expect((await svc.readRequestChat(managedKey)).outcome).toBe('no_counterpart');
      expect((await svc.bindGuestChat(managedKey, STRANGER_CHAT))[0].text).toMatch(/ведёт менеджер Ведара/);
      expect(await svc.postGuestMessage(managedTarget, 'Есть новости?', 'page')).toEqual({ outcome: 'no_counterpart' });
      const n = await pool.query(`SELECT count(*)::int AS n FROM request_messages WHERE lead_id = $1`, [managed?.id]);
      expect(n.rows[0].n).toBe(0);
    });

    it('удалили лид — переписка и ожидания ушли с ним', async () => {
      await svc.armChatWait('owner', lead(), CARRIER_CHAT);
      await pool.query(`DELETE FROM leads WHERE id = $1`, [leadId]);
      const m = await pool.query(`SELECT count(*)::int AS n FROM request_messages WHERE lead_id = $1`, [leadId]);
      const w = await pool.query(`SELECT count(*)::int AS n FROM request_chat_waits WHERE lead_id = $1`, [leadId]);
      expect(m.rows[0].n).toBe(0);
      expect(w.rows[0].n).toBe(0);
    });
  });

  // ── Соседние потоки чата и честные исходы (ревью 30.10) ────────────────────

  describe('соседние потоки чата и честные исходы', () => {
    const PARTNER_CHAT = 7101;
    const CLIENT = 7102;
    let partnerId = '';
    let lead = { kind: 'lead' as const, id: '' };

    beforeAll(async () => {
      partnerId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ('Гид соседних потоков', 'guide', '{}', $1) RETURNING id`,
        [PARTNER_CHAT],
      )).rows[0].id;
      const created = await leads.createLeadDetailed({
        name: 'Ольга', phone: '+79990006677', comment: 'Толбачик, двое', route_title: 'Толбачик',
        operator_id: partnerId, pd_consent: consentOf('operator'), skip_ai_processing: true,
      });
      lead = { kind: 'lead', id: created?.id ?? '' };
      const key = (await status.issueRequestKey({ leadId: lead.id }, status.LEAD_FORM_KEY_NAME, { opensChat: true })) ?? '';
      expect((await svc.bindGuestChat(key, CLIENT))[0].text).toMatch(/Готово/);
    });

    const actionRow = (status: string) => pool.query<{ id: string }>(
      `INSERT INTO partner_chat_actions (partner_id, channel, chat_id, subject_kind, subject_id, action, status, expires_at)
       VALUES ($1, 'max', $2, 'booking', '501', 'cancel', $3, NOW() + INTERVAL '15 minutes') RETURNING id::text AS id`,
      [partnerId, PARTNER_CHAT, status],
    );
    const waitStatus = async (chat: number) => (await pool.query<{ status: string }>(
      `SELECT status FROM request_chat_waits WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 1`, [chat],
    )).rows[0]?.status;

    it('кнопка «Ответить клиенту» снимает ожидание причины отказа брони — и говорит об этом', async () => {
      const a = await actionRow('awaiting_reason');
      const r = await svc.armChatWait('owner', lead, PARTNER_CHAT);
      expect(r.text).toMatch(/Напишите ответ клиенту/);
      expect(r.text).toMatch(/Ожидание причины отклонения брони снято/);
      const row = await pool.query(`SELECT status FROM partner_chat_actions WHERE id = $1`, [a.rows[0].id]);
      expect(row.rows[0].status).toBe('superseded');
      expect(await svc.captureChatText(PARTNER_CHAT, 'отмена')).not.toBeNull();
    });

    it('«Отклонить» после кнопки — следующий текст причина отказа, клиенту он не уходит', async () => {
      sent.dm.length = 0;
      await svc.armChatWait('owner', lead, PARTNER_CHAT);
      const a = await actionRow('awaiting_reason');
      expect(await svc.captureChatText(PARTNER_CHAT, 'Турист заболел, тур переносится')).toBeNull();
      expect(sent.dm).toHaveLength(0);
      expect(await waitStatus(PARTNER_CHAT)).toBe('superseded');
      await pool.query(`UPDATE partner_chat_actions SET status = 'cancelled' WHERE id = $1`, [a.rows[0].id]);
    });

    it('контроль выхода: «вернулся» при открытом контроле и просьба поставить контроль — не гиду', async () => {
      sent.pd.length = 0;
      const reg = await pool.query<{ id: string }>(
        `INSERT INTO route_registrations (route_name, start_date, end_date, group_size, leader_name, leader_phone,
                                          emergency_contact_name, emergency_contact_phone, tourist_chat_channel, tourist_chat_id,
                                          expected_return_at)
         VALUES ('Толбачик', CURRENT_DATE, CURRENT_DATE + 1, 2, 'Ольга', '+79990006677', 'Маша', '+79990008899',
                 'max', $1, NOW() + INTERVAL '1 day') RETURNING id::text AS id`,
        [CLIENT],
      );
      await svc.armChatWait('guest', lead, CLIENT);
      expect(await svc.captureChatText(CLIENT, 'Вернулся')).toBeNull();
      expect(await waitStatus(CLIENT)).toBe('superseded');
      await pool.query(`DELETE FROM route_registrations WHERE id = $1`, [reg.rows[0].id]);

      // Без открытого контроля «вернулся» — обычное сообщение гиду, а просьба
      // поставить контроль уходит контролю всегда.
      await svc.armChatWait('guest', lead, CLIENT);
      expect((await svc.captureChatText(CLIENT, 'вернулся'))?.text).toMatch(/Передал гиду/);
      await svc.armChatWait('guest', lead, CLIENT);
      expect(await svc.captureChatText(CLIENT, 'Поставьте меня на контроль выхода до 18:00')).toBeNull();
      expect(sent.pd).toHaveLength(1);
    });

    it('сообщение клиента, которое не получил ни адресат, ни оператор Ведара, — так и сказано', async () => {
      const silent = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact) VALUES ('Прокат без MAX', 'cars', '{}') RETURNING id`,
      )).rows[0].id;
      const created = await leads.createLeadDetailed({
        name: 'Пётр', phone: '+79990007788', comment: 'Прадо на три дня', operator_id: silent,
        pd_consent: consentOf('operator'), skip_ai_processing: true,
      });
      const target = { kind: 'lead' as const, id: created?.id ?? '' };
      sent.adminFails = true;
      try {
        const r = await svc.postGuestMessage(target, 'Можно забрать в аэропорту?', 'page');
        expect(r).toEqual({ outcome: 'sent', delivery: 'no_address', relayed: false });
      } finally {
        sent.adminFails = false;
      }
      expect(await svc.postGuestMessage(target, 'Ещё вопрос', 'page')).toEqual({ outcome: 'sent', delivery: 'no_address', relayed: true });
    });

    it('клиенту негде прочитать ответ (нет MAX, ссылка истекла) — кнопка не обещает, ответ говорит правду', async () => {
      const created = await leads.createLeadDetailed({
        name: 'Нина', phone: '+79990009911', comment: 'Мутновский', operator_id: partnerId,
        pd_consent: consentOf('operator'), skip_ai_processing: true,
      });
      const target = { kind: 'lead' as const, id: created?.id ?? '' };
      await status.issueRequestKey({ leadId: target.id }, status.LEAD_FORM_KEY_NAME, { opensChat: true });
      // Ключ повтора жив, но переписку не открывает — он не в счёт.
      await status.issueRequestKey({ leadId: target.id }, status.LEAD_FORM_KEY_NAME, { opensChat: false });
      expect((await svc.armChatWait('owner', target, PARTNER_CHAT)).text).toMatch(/Напишите ответ клиенту/);
      await svc.captureChatText(PARTNER_CHAT, 'отмена');
      await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE lead_id = $1 AND opens_chat`, [target.id]);
      expect((await svc.armChatWait('owner', target, PARTNER_CHAT)).text).toMatch(/прочитать негде.*ничего не отправлено/);
      expect(await waitStatus(PARTNER_CHAT)).not.toBe('waiting');
      const r = await svc.postOwnerMessage(target, 'Перезвоню вечером');
      expect(r).toEqual({ outcome: 'sent', delivery: 'no_address', pageVisible: false });
    });
  });

  // ── Схема (1350) ────────────────────────────────────────────────────────────

  it('сообщение без цели или с двумя целями база не принимает (23514)', async () => {
    const none = pool.query(`INSERT INTO request_messages (author, door, body) VALUES ('guest', 'page', 'x')`);
    await expect(none).rejects.toMatchObject({ code: '23514' });
    const w = pool.query(
      `INSERT INTO request_chat_waits (channel, chat_id, side, expires_at) VALUES ('max', 1, 'owner', NOW() + INTERVAL '1 hour')`,
    );
    await expect(w).rejects.toMatchObject({ code: '23514' });
  });

  it('прежние имена — изменяемые представления: код 1349 (окно выката, откат) пишет и читает как раньше', async () => {
    const { PD_CONSENT_STAY_VERSION } = await import('@/lib/legal/pd-consent');
    const acc = await pool.query<{ id: string }>(`SELECT id FROM accommodations LIMIT 1`);
    const sr = (await pool.query<{ id: string }>(
      `INSERT INTO stay_requests (accommodation_id, check_in_date, check_out_date, guests, guest_name, guest_phone,
                                  pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version, door)
       VALUES ($1, '2099-09-10', '2099-09-12', 2, 'Гость прежнего кода', '+79990001010',
               NOW(), '203.0.113.9', 'stay-request', $2, 'form') RETURNING id`,
      [acc.rows[0].id, PD_CONSENT_STAY_VERSION],
    )).rows[0].id;
    // Ровно те запросы, что шлёт код 1349.
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO stay_request_messages (stay_request_id, author, door, body) VALUES ($1::uuid, 'guest', 'page', 'Старый путь')
       RETURNING id::text AS id`, [sr],
    );
    await pool.query(`UPDATE stay_request_messages SET delivery_channel = 'max', delivery_reason = 'ок' WHERE id = $1::uuid`, [ins.rows[0].id]);
    const viaNew = await pool.query(`SELECT body, delivery_channel, lead_id FROM request_messages WHERE id = $1::uuid`, [ins.rows[0].id]);
    expect(viaNew.rows[0]).toEqual({ body: 'Старый путь', delivery_channel: 'max', lead_id: null });
    await pool.query(
      `INSERT INTO stay_chat_waits (channel, chat_id, stay_request_id, side, expires_at)
       VALUES ('max', 7201, $1::uuid, 'guest', NOW() + make_interval(mins => 30))`, [sr],
    );
    const w = await pool.query(`SELECT side FROM stay_chat_waits WHERE chat_id = 7201 AND status = 'waiting' AND expires_at > NOW()`);
    expect(w.rows).toEqual([{ side: 'guest' }]);
    // Лиды старому коду не видны: представления — только жильё.
    const leaked = await pool.query(`SELECT count(*)::int AS n FROM stay_request_messages WHERE stay_request_id IS NULL`);
    expect(leaked.rows[0].n).toBe(0);
    await pool.query(`DELETE FROM stay_requests WHERE id = $1::uuid`, [sr]);
  });

  it('миграция 1350 повторяется без вреда: таблицы и проверки на месте, ключи жилья открывают переписку', async () => {
    // Ключ жилья, выданный до 1350: колонка пришла с FALSE по умолчанию.
    const { PD_CONSENT_STAY_VERSION } = await import('@/lib/legal/pd-consent');
    const acc = await pool.query<{ id: string }>(`SELECT id FROM accommodations LIMIT 1`);
    const sr = await pool.query<{ id: string }>(
      `INSERT INTO stay_requests (accommodation_id, check_in_date, check_out_date, guests, guest_name, guest_phone,
                                  pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version, door)
       VALUES ($1, '2099-08-10', '2099-08-12', 2, 'Гость до 1350', '+79990009900',
               NOW(), '203.0.113.9', 'stay-request', $2, 'form') RETURNING id`,
      [acc.rows[0].id, PD_CONSENT_STAY_VERSION],
    );
    await pool.query(
      `INSERT INTO agent_request_keys (key_hash, stay_request_id, tool_name, expires_at, opens_chat)
       VALUES ($1, $2, 'stay-request-form', NOW() + INTERVAL '1 day', FALSE)`,
      ['f'.repeat(64), sr.rows[0].id],
    );
    const sql = readFileSync(join(process.cwd(), 'migrations/1350_request_chat_all.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const old = await pool.query(`SELECT opens_chat FROM agent_request_keys WHERE stay_request_id = $1`, [sr.rows[0].id]);
    expect(old.rows).toEqual([{ opens_chat: true }]);
    const t = await pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
        WHERE c.relkind = 'r' AND c.relname IN ('request_messages', 'request_chat_waits', 'stay_request_messages', 'stay_chat_waits')
        ORDER BY 1`,
    );
    expect(t.rows.map((r) => r.name)).toEqual(['request_chat_waits', 'request_messages']);
    const v = await pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c WHERE c.relkind = 'v' AND c.relname IN ('stay_request_messages', 'stay_chat_waits') ORDER BY 1`,
    );
    expect(v.rows.map((r) => r.name)).toEqual(['stay_chat_waits', 'stay_request_messages']);
    const checks = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname IN ('request_messages_one_target', 'request_chat_waits_one_target') ORDER BY 1`,
    );
    expect(checks.rows.map((r) => r.conname)).toEqual(['request_chat_waits_one_target', 'request_messages_one_target']);
    const k = await pool.query(`SELECT count(*)::int AS n FROM agent_request_keys WHERE stay_request_id IS NOT NULL AND NOT opens_chat`);
    expect(k.rows[0].n).toBe(0);
  });
});
