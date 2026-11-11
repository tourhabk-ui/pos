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

/**
 * Ответ адресата (30.10): текст → предпросмотр с «Отправить» / «Отменить» →
 * «Отправить». До второго нажатия клиенту ничего не уходит.
 */
async function replyViaDraft(chat: number, text: string) {
  const svc = await import('@/lib/requests/request-chat-service');
  const { unwrapPress } = await import('@/lib/chat-cabinet/signed-payload');
  const before = sent.dm.length;
  const preview = await svc.captureChatText(chat, text);
  expect(preview?.text).toMatch(/Проверьте ответ/);
  expect(preview?.text).toContain(text.replace(/</g, '&lt;'));
  expect(preview?.buttons.map((b) => b.text)).toEqual(['Отправить', 'Отменить']);
  expect(sent.dm.length).toBe(before);
  const raw = (preview!.buttons[0] as { payload: string }).payload;
  const press = unwrapPress(raw);
  if (!press.ok) throw new Error('кнопка «Отправить» не подписана');
  const r = await svc.pressDraft(press.payload, chat);
  // Повтор нажатия ничего не шлёт второй раз.
  const again = await svc.pressDraft(press.payload, chat);
  expect(again.text).toMatch(/уже отправлен, отменён или устарел/);
  return r;
}
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
      const r = await replyViaDraft(OWNER_CHAT, 'Да, ждём с 12:00');
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
      // «Моя поездка» (#2970, 1416): заявка — в чате гостя, не в чужом.
      const links = await import('@/lib/requests/chat-links');
      expect(await links.chatHasRequests('max', GUEST_CHAT)).toBe(true);
      expect(await links.chatHasRequests('max', STRANGER_CHAT)).toBe(false);
      const origin = await pool.query(`SELECT origin FROM chat_request_links WHERE channel = 'max' AND chat_id = $1`, [String(GUEST_CHAT)]);
      expect(origin.rows.map((r) => r.origin)).toEqual(['sq']);
    });

    it('после подключения MAX статус ссылку подключения не даёт', async () => {
      expect((await status.readRequestStatus(key)).max_link).toBeNull();
    });

    it('ответ хозяина уходит в MAX гостя с кнопкой «Написать владельцу»', async () => {
      sent.dm.length = 0;
      await svc.armChatWait('owner', stay(), OWNER_CHAT);
      const r = await replyViaDraft(OWNER_CHAT, 'Баня с 18:00');
      expect(r?.text).toMatch(/Передал гостю в MAX/);
      expect(sent.dm).toHaveLength(1);
      expect(String(sent.dm[0].chatId)).toBe(String(GUEST_CHAT));
      expect(sent.dm[0].text).toContain('Баня с 18:00');
      expect(sent.dm[0].text).not.toContain('Анна');
      expect(sent.dm[0].buttons).toEqual([{ text: 'Написать владельцу', payload: `sq:g:${requestId}` }]);
    });

    it('Telegram хозяина (30.10): кнопка → текст → предпросмотр с маской ПД → «Отправить»; чужой чат черновик не отправит', async () => {
      const TG = 9_100_001;
      await pool.query(`UPDATE partners SET telegram_chat_id = $2 WHERE id = $1`, [partnerId, TG]);
      try {
        sent.dm.length = 0;
        // Из чужого Telegram кнопка не заводит ожидания.
        const foreign = await svc.armChatWait('owner', stay(), 9_100_002, 'telegram');
        expect(foreign.text).toMatch(/адресована не вам/);
        const armed = await svc.armChatWait('owner', stay(), TG, 'telegram');
        expect(armed.text).toMatch(/Напишите ответ гостю/);
        // MAX того же хозяина не ждёт: ожидание — канала, где нажали.
        expect(await svc.captureChatText(OWNER_CHAT, 'не сюда')).toBeNull();
        const preview = await svc.captureChatText(TG, 'Звоните +7 914 123-45-67, жду', 'telegram');
        expect(preview?.text).not.toContain('123-45-67');
        expect(preview?.text).toMatch(/скрыты/);
        expect(sent.dm).toHaveLength(0);
        const { unwrapPress } = await import('@/lib/chat-cabinet/signed-payload');
        const press = unwrapPress((preview!.buttons[0] as { payload: string }).payload);
        if (!press.ok) throw new Error('не подписана');
        // Чужой чат и чужой канал — черновик не их.
        expect((await svc.pressDraft(press.payload, 9_100_002, 'telegram')).text).toMatch(/уже отправлен, отменён или устарел/);
        expect((await svc.pressDraft(press.payload, TG, 'max')).text).toMatch(/уже отправлен, отменён или устарел/);
        const done = await svc.pressDraft(press.payload, TG, 'telegram');
        expect(done.text).toMatch(/Передал гостю в MAX/);
        expect(sent.dm).toHaveLength(1);
        // Клиенту — текст как написан.
        expect(sent.dm[0].text).toContain('+7 914 123-45-67');
        const door = await pool.query(`SELECT door FROM request_messages WHERE body = $1`, ['Звоните +7 914 123-45-67, жду']);
        expect(door.rows).toEqual([{ door: 'telegram' }]);
      } finally {
        await pool.query(`UPDATE partners SET telegram_chat_id = NULL WHERE id = $1`, [partnerId]);
      }
    });

    it('«Отменить» под предпросмотром: ничего не уходит, черновик погашен', async () => {
      sent.dm.length = 0;
      await svc.armChatWait('owner', stay(), OWNER_CHAT);
      const preview = await svc.captureChatText(OWNER_CHAT, 'Передумал');
      const cancel = (preview!.buttons[1] as { payload: string }).payload;
      expect((await svc.pressDraft(cancel, OWNER_CHAT)).text).toMatch(/Не отправил/);
      expect(sent.dm).toHaveLength(0);
      expect((await svc.pressDraft(cancel, OWNER_CHAT)).text).toMatch(/уже отправлен, отменён или устарел/);
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
        'message_in/tourist', 'message_out/partner_user', 'message_out/partner_user', 'message_out/partner_user',
        'message_in/tourist',
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

    it('«занято с … по …» словами хозяина (30.10): ночи объекта без номеров закрыты своим и только своим, гость их видит, заявка на них не пишется, «свободно» открывает', async () => {
      const { setObjectBusy, loadOwnerBusy, handleStayBusyPhrase, objectBusyNightsSql } = await import('@/lib/stay/busy-flow');
      const acc = await pool.query<{ id: string }>(`SELECT accommodation_id::text AS id FROM stay_requests WHERE id = $1`, [requestId]);
      const accId = acc.rows[0].id;
      const other = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_public, is_verified) VALUES ('Соседний дом', 'stay', '{}', FALSE, FALSE) RETURNING id`,
      );
      // Чужой партнёр: объект не его — ни строки.
      expect(await setObjectBusy({ partnerId: other.rows[0].id, accommodationId: accId, from: '2099-07-10', to: '2099-07-12', action: 'block', via: 'max', db: pool }))
        .toEqual({ outcome: 'not_yours' });
      expect((await pool.query(`SELECT 1 FROM accommodation_availability WHERE accommodation_id = $1`, [accId])).rows).toEqual([]);

      // Хозяин фразой (разбор 02.11): только «Понял так» + «Записать» — до нажатия ни строки.
      const said = await handleStayBusyPhrase({ partnerId, category: 'stay', text: 'занято с 10 по 12 июля 2099', today: '2099-07-01', via: 'max', db: pool });
      expect(said!.text).toContain('Понял так: «Кутха» занято с 10.07.2099 по 12.07.2099 (3 ночи)');
      expect(said!.buttons![0]![0]!.payload).toBe(`cb:b:w:${accId}:20990710:20990712`);
      expect((await pool.query(`SELECT 1 FROM accommodation_availability WHERE accommodation_id = $1`, [accId])).rows).toEqual([]);
      // Вопрос не пишет и не перехватывается.
      expect(await handleStayBusyPhrase({ partnerId, category: 'stay', text: 'Свободно ли 10 июля 2099?', today: '2099-07-01', via: 'max', db: pool })).toBeNull();
      // «Записать»: уровень объекта (room_id IS NULL), повтор того же — не дубль (ON CONFLICT по 721).
      expect(await setObjectBusy({ partnerId, accommodationId: accId, from: '2099-07-10', to: '2099-07-12', action: 'block', via: 'max', db: pool }))
        .toMatchObject({ outcome: 'saved', name: 'Кутха' });
      await setObjectBusy({ partnerId, accommodationId: accId, from: '2099-07-11', to: '2099-07-13', action: 'block', via: 'telegram', db: pool });
      const rows = await pool.query<{ date: string; room_id: string | null; is_blocked: boolean; block_reason: string }>(
        `SELECT date::text, room_id, is_blocked, block_reason FROM accommodation_availability WHERE accommodation_id = $1 ORDER BY date`, [accId],
      );
      expect(rows.rows.map((r) => r.date)).toEqual(['2099-07-10', '2099-07-11', '2099-07-12', '2099-07-13']);
      expect(rows.rows.every((r) => r.room_id === null && r.is_blocked)).toBe(true);
      expect(rows.rows[1].block_reason).toBe('хозяин: занято (telegram)');

      // Экран «Занято» хозяина и чтение гостем — одни и те же ночи.
      expect(await loadOwnerBusy(partnerId, '2099-07-01', pool)).toEqual([{ id: accId, name: 'Кутха', dates: ['2099-07-10', '2099-07-11', '2099-07-12', '2099-07-13'] }]);
      const guest = await pool.query<{ night: string }>(`${objectBusyNightsSql('$1::uuid', '$2::date', '$3::date')} ORDER BY av.date`, [accId, '2099-07-12', '2099-07-20']);
      expect(guest.rows.map((r) => r.night)).toEqual(['2099-07-12', '2099-07-13']);

      // Заявка на закрытые даты не пишется и называет даты; с открытых — пишется.
      // Объект — на витрине (гейт модерации, lib/stay/moderation): иначе исход «не принимает», а не «занято».
      await pool.query(`UPDATE accommodations SET is_active = TRUE, moderation_status = 'approved' WHERE id = $1`, [accId]);
      const { submitStayRequest } = await import('@/lib/stay/stay-request-service');
      const { PD_CONSENT_STAY_VERSION } = await import('@/lib/legal/pd-consent');
      const consent = { at: new Date().toISOString(), ip: '203.0.113.9', source: 'stay-request', version: PD_CONSENT_STAY_VERSION };
      const base = { accommodationId: accId, guests: 2, guestName: 'Пётр Гость', guestPhone: '+79990003344', comment: null, consent: consent as never, door: 'form' as const };
      const before = Number((await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM stay_requests WHERE accommodation_id = $1`, [accId])).rows[0].n);
      const busy = await submitStayRequest({ ...base, checkIn: '2099-07-12', checkOut: '2099-07-15', nights: 3 });
      expect(busy).toEqual({ ok: false, reason: 'busy', busyDates: ['2099-07-12', '2099-07-13'] });
      const after = Number((await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM stay_requests WHERE accommodation_id = $1`, [accId])).rows[0].n);
      expect(after).toBe(before);

      // «Свободно» снимает только блоки объекта в отрезке.
      const freeAsk = await handleStayBusyPhrase({ partnerId, category: 'stay', text: 'свободно с 12 по 13 июля 2099', today: '2099-07-01', via: 'max', db: pool });
      expect(freeAsk!.text).toContain('Понял так: «Кутха» свободно с 12.07.2099 по 13.07.2099');
      expect(freeAsk!.buttons![0]![0]!.payload).toBe(`cb:b:r:${accId}:20990712:20990713`);
      await setObjectBusy({ partnerId, accommodationId: accId, from: '2099-07-12', to: '2099-07-13', action: 'release', via: 'max', db: pool });
      const left = await pool.query<{ date: string }>(
        `SELECT date::text FROM accommodation_availability WHERE accommodation_id = $1 AND is_blocked ORDER BY date`, [accId],
      );
      expect(left.rows.map((r) => r.date)).toEqual(['2099-07-10', '2099-07-11']);
      expect((await submitStayRequest({ ...base, checkIn: '2099-07-12', checkOut: '2099-07-15', nights: 3 })).ok).toBe(true);
    });

    it('подбор планера по заявке хозяину (08.11): объект без номеров в зоне ночёвки — вариант; без зоны, в закрытую ночь, с номером — нет', async () => {
      const { findRequestLodgingForStay, findLodgingForStay } = await import('@/lib/planner/trip-extras-data');
      const accId = (await pool.query<{ id: string }>(`SELECT accommodation_id::text AS id FROM stay_requests WHERE id = $1`, [requestId])).rows[0].id;
      const at = (checkIn: string, checkOut: string, zone: 'avachinsky' | 'eastern' = 'avachinsky') => ({ zone, checkIn, checkOut, nights: 2 });
      // В базе рядом и «Кутха» витрины (1179, зона с 1411) — судим только свой объект.
      type Found = Awaited<ReturnType<typeof findRequestLodgingForStay>>;
      const ours = (r: Found) => (r.state === 'ok' ? r.items.filter((i) => i.id === accId) : []);
      // Зоны нет — не предлагается: зону не угадывают (1031).
      await pool.query(`UPDATE accommodations SET planner_zone = NULL WHERE id = $1`, [accId]);
      expect(ours(await findRequestLodgingForStay(at('2099-08-01', '2099-08-03')))).toEqual([]);
      await pool.query(`UPDATE accommodations SET planner_zone = 'avachinsky' WHERE id = $1`, [accId]);
      const found = await findRequestLodgingForStay(at('2099-08-01', '2099-08-03'));
      expect(found.state).toBe('ok');
      expect(ours(found)).toEqual([expect.objectContaining({ id: accId, name: 'Кутха', type: 'guesthouse' })]);
      // «Кутха» витрины (1179) после 1411 — тоже в подборе Авачинской зоны: ради этого миграция.
      expect(found.state === 'ok' && found.items.some((i) => i.id !== accId && i.name === 'Кутха')).toBe(true);
      // Подбор по номерам этот объект не видит — номеров на платформе нет.
      const byRooms = await findLodgingForStay(at('2099-08-01', '2099-08-03'), 2);
      expect(byRooms.state === 'ok' ? byRooms.items.filter((i) => i.id === accId) : []).toEqual([]);
      // Ночь 10.07, закрытая хозяином выше, — объекта в подборе нет; другая зона — тоже.
      expect(ours(await findRequestLodgingForStay(at('2099-07-09', '2099-07-11')))).toEqual([]);
      expect(ours(await findRequestLodgingForStay(at('2099-08-01', '2099-08-03', 'eastern')))).toEqual([]);
      // Живой номер — занятость считают номера, и объект уходит из подбора по заявке.
      const room = await pool.query<{ id: string }>(
        `INSERT INTO accommodation_rooms (accommodation_id, name, room_type, max_guests, available_rooms, price_per_night, is_active)
         VALUES ($1, 'Дом целиком', 'family', 10, 1, 28000, TRUE) RETURNING id`, [accId],
      );
      expect(ours(await findRequestLodgingForStay(at('2099-08-01', '2099-08-03')))).toEqual([]);
      await pool.query(`DELETE FROM accommodation_rooms WHERE id = $1`, [room.rows[0].id]);
      await pool.query(`UPDATE accommodations SET planner_zone = NULL WHERE id = $1`, [accId]);
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
      const r = await replyViaDraft(CARRIER_CHAT, 'Подача в 7:00 у гостиницы');
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
      const back = await replyViaDraft(CARRIER_CHAT, 'Возьмём вторую машину');
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

  // ── «Моя поездка»: связь «чат ↔ заявка» (#2970, миграция 1416) ─────────────

  describe('связь «чат ↔ заявка» (1416)', () => {
    const CHAT = 9_300_001;
    const OTHER = 9_300_002;
    let links: typeof import('@/lib/requests/chat-links');
    let key = '';
    let keyId = '';

    beforeAll(async () => {
      links = await import('@/lib/requests/chat-links');
      const lead = await leads.createLeadDetailed({
        name: 'Анна Туристка', phone: '+79995550101', comment: 'Тур на вулкан, двое',
        route_title: 'Авачинский', source_url: 'https://vedarai.ru/kuzmich',
        pd_consent: consentOf('operator'), source_data: { source: 'kuzmich_max' }, skip_ai_processing: true,
      });
      const issued = await status.issueRequestKeyRecord({ leadId: lead!.id }, 'create_lead', { opensChat: false });
      key = issued!.key;
      keyId = issued!.keyId!;
    });

    it('ключ, полученный в чате, связывается один раз; чужой чат и другой канал заявки не видят', async () => {
      expect(await links.linkChatToKeys('max', CHAT, [key], 'created')).toBe(1);
      expect(await links.linkChatToKeys('max', CHAT, [key], 'status_link')).toBe(0);
      expect(await links.chatLinkedKeyIds('max', CHAT)).toEqual([keyId]);
      expect(await links.chatLinkedKeyIds('max', OTHER)).toEqual([]);
      expect(await links.chatLinkedKeyIds('telegram', CHAT)).toEqual([]);
      expect(await links.chatHasRequests('max', CHAT)).toBe(true);
    });

    it('неизвестный ключ связи не даёт, пустой список — ничего не пишет', async () => {
      expect(await links.linkChatToKeys('telegram', OTHER, ['A'.repeat(32)], 'created')).toBe(0);
      expect(await links.linkChatToKeys('telegram', OTHER, [], 'created')).toBe(0);
      expect(await links.chatHasRequests('telegram', OTHER)).toBe(false);
    });

    it('истёкший ключ уводит заявку из списка и новой связи не даёт', async () => {
      await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [keyId]);
      expect(await links.chatLinkedKeyIds('max', CHAT)).toEqual([]);
      expect(await links.linkChatToKeys('telegram', CHAT, [key], 'handoff')).toBe(0);
      await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() + INTERVAL '90 days' WHERE id = $1`, [keyId]);
    });

    it('погашенный код между каналами связывает выданный ключ с этим чатом Telegram', async () => {
      const handoff = await import('@/lib/requests/handoff');
      const code = await handoff.issueHandoffCode(key);
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      const reply = await handoff.handoffReply(code!, 'telegram', String(OTHER));
      expect(reply).toMatch(/Заявка найдена в этом канале/);
      const r = await pool.query(
        `SELECT l.origin, k.lead_id::text AS lead FROM chat_request_links l JOIN agent_request_keys k ON k.id = l.key_id
          WHERE l.channel = 'telegram' AND l.chat_id = $1`, [String(OTHER)]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].origin).toBe('handoff');
      const own = await pool.query(`SELECT lead_id::text AS lead FROM agent_request_keys WHERE id = $1`, [keyId]);
      expect(r.rows[0].lead).toBe(own.rows[0].lead);
    });

    it('«Моя поездка»: заявки чата со статусом и обстановкой на ближайшую дату; одна заявка — одна строка', async () => {
      const myTrip = await import('@/lib/requests/my-trip');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const opId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact) VALUES ('Оператор поездки', 'operator', '{}') RETURNING id`,
      )).rows[0].id;
      const tourId = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, latitude, longitude)
         VALUES ('Сплав по Быстрой', 15000, $1, 53.1, 158.6) RETURNING id`, [opId],
      )).rows[0].id;
      const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 2);
      const soon = d.toISOString().slice(0, 10);
      const lead = await leads.createLeadDetailed({
        name: 'Пётр Сплав', phone: '+79995550202', comment: 'Сплав, двое', route_title: 'Сплав по Быстрой',
        source_url: 'https://vedarai.ru/kuzmich', pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tour_id: tourId, date: soon }, skip_ai_processing: true,
      });
      const TRIP_CHAT = 9_300_010;
      const k1 = await status.issueRequestKeyRecord({ leadId: lead!.id }, 'create_booking_request', { opensChat: false });
      const k2 = await status.issueRequestKeyRecord({ leadId: lead!.id }, 'handoff:max', { opensChat: false });
      expect(await links.linkChatToKeys('max', TRIP_CHAT, [k1!.key], 'created')).toBe(1);
      expect(await links.linkChatToKeys('max', TRIP_CHAT, [k2!.key], 'handoff')).toBe(1);

      // Источники обстановки без сети: прогноз не загрузился, лента пуста, оценки зоны нет.
      const sources = async () => ({
        forecast: async () => { throw new Error('прогноз недоступен в тесте'); },
        officials: async () => [],
        zone: async () => null,
      });
      const trip = await myTrip.loadMyTrip('max', TRIP_CHAT, { sources: sources as never });
      expect(trip.outcome).toBe('ok');
      if (trip.outcome !== 'ok') return;
      expect(trip.items).toHaveLength(1);
      expect(trip.items[0]).toMatchObject({ what: 'Сплав по Быстрой', date: soon });
      expect(trip.items[0].human.length).toBeGreaterThan(0);
      expect(trip.items[0].situation).toMatchObject({ kind: 'line', date: soon });
      // Прогноз не загрузился — «не смог проверить», не «спокойно».
      expect((trip.items[0].situation as { text: string }).text).toMatch(/не смог проверить/);
      const text = myTrip.myTripText(trip);
      expect(text).not.toContain('+7999');
      expect(text).not.toContain('Пётр');

      expect(await myTrip.loadMyTrip('max', TRIP_CHAT + 1)).toEqual({ outcome: 'none' });
      expect(await myTrip.loadMyTrip('telegram', TRIP_CHAT)).toEqual({ outcome: 'none' });
    });

    it('«Написать оператору» (#2970, шаг 3): кнопка под списком; право — связь чата; чужой чат и чужая переписка — нет', async () => {
      // Кнопка-запись подписывается; без ключа подписи в окружении теста она ушла бы голой.
      process.env.CALLBACK_SIGNING_SECRET ??= 'pg-test-signing';
      const myTrip = await import('@/lib/requests/my-trip');
      const write = await import('@/lib/requests/my-trip-write');
      const { unwrapPress } = await import('@/lib/chat-cabinet/signed-payload');
      const opId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ('Оператор переписки', 'operator', '{}', 9300099) RETURNING id`,
      )).rows[0].id;
      const lead = await leads.createLeadDetailed({
        name: 'Ольга Пишет', phone: '+79995550303', comment: 'Вулкан, трое', route_title: 'Горелый',
        source_url: 'https://vedarai.ru/kuzmich', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'kuzmich_max' }, skip_ai_processing: true,
      });
      const A = 9_300_021;
      const B = 9_300_022;
      const fresh = await status.issueRequestKeyRecord({ leadId: lead!.id }, 'create_lead', { opensChat: true });
      expect(await links.linkChatToKeys('max', A, [fresh!.key], 'created')).toBe(1);

      // Кнопка — в ответе «Моей поездки» этого чата; в Telegram кнопки нет, есть строка.
      const msg = await myTrip.myTripMessage('max', A);
      expect(msg.buttons).toHaveLength(1);
      expect(msg.buttons[0]!.text).toBe('Написать оператору');
      const press = unwrapPress(msg.buttons[0]!.payload);
      expect(press.ok).toBe(true);
      const payload = press.ok ? press.payload : '';
      expect(write.parseMyTripWrite(payload)).toEqual({ kind: 'lead', id: lead!.id });

      // Чат без связи с заявкой — «не подключена», переписка не открыта.
      expect((await write.pressMyTripWrite(payload, B)).text).toMatch(/не подключена к этому чату/);
      expect((await pool.query(`SELECT guest_max_chat_id FROM leads WHERE id = $1`, [lead!.id])).rows[0].guest_max_chat_id).toBeNull();

      // Свой чат — чат подключён к заявке, следующее сообщение ждёт отправки.
      const reply = await write.pressMyTripWrite(payload, A);
      expect(reply.text).not.toMatch(/не подключена|Не удалось/);
      expect(String((await pool.query(`SELECT guest_max_chat_id FROM leads WHERE id = $1`, [lead!.id])).rows[0].guest_max_chat_id)).toBe(String(A));
      const waits = await pool.query(
        `SELECT side, status FROM request_chat_waits WHERE channel = 'max' AND chat_id = $1 AND lead_id = $2::uuid`, [String(A), lead!.id]);
      expect(waits.rows).toEqual([{ side: 'guest', status: 'waiting' }]);

      // Второй чат со связью той же заявки переписку у первого не забирает.
      expect(await links.linkChatToKeys('max', B, [fresh!.key], 'status_link')).toBe(1);
      expect((await write.pressMyTripWrite(payload, B)).text).toMatch(/не подключена к этому чату/);
      expect(String((await pool.query(`SELECT guest_max_chat_id FROM leads WHERE id = $1`, [lead!.id])).rows[0].guest_max_chat_id)).toBe(String(A));

      // Ключ без переписки (повтор заявки) — только статус: «по этой ссылке переписки нет».
      const lead2 = await leads.createLeadDetailed({
        name: 'Ольга Повтор', phone: '+79995550404', comment: 'Повтор', route_title: 'Горелый',
        source_url: 'https://vedarai.ru/kuzmich', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'kuzmich_max' }, skip_ai_processing: true,
      });
      const repeat = await status.issueRequestKeyRecord({ leadId: lead2!.id }, 'create_lead', { opensChat: false });
      expect(await links.linkChatToKeys('max', A, [repeat!.key], 'created')).toBe(1);
      const repeatPayload = write.myTripWritePayload({ kind: 'lead', id: lead2!.id });
      expect((await write.pressMyTripWrite(repeatPayload, A)).text).toMatch(/переписки нет/);
      expect((await pool.query(`SELECT guest_max_chat_id FROM leads WHERE id = $1`, [lead2!.id])).rows[0].guest_max_chat_id).toBeNull();
      // И в списке у такой заявки кнопки нет.
      const after = await myTrip.myTripMessage('max', A);
      expect(after.buttons.map((b) => b.text)).toEqual(['Написать оператору · 2']);
      expect(myTrip.myTripText(await myTrip.loadMyTrip('telegram', A), { channel: 'telegram' })).not.toContain('Написать оператору');
    });

    it('«Изменить дату» (#2970, шаг 3): свободные даты на людей заявки; до ответа оператора — сразу, после — просьбой', async () => {
      process.env.CALLBACK_SIGNING_SECRET ??= 'pg-test-signing';
      const myTrip = await import('@/lib/requests/my-trip');
      const dates = await import('@/lib/requests/my-trip-date');
      const { unwrapPress } = await import('@/lib/chat-cabinet/signed-payload');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const day = (n: number) => {
        const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const short = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
      const [D0, D1, D2, D3, D4] = [day(10), day(12), day(14), day(16), day(18)];
      const opId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ('Оператор дат', 'operator', '{}', 9300199) RETURNING id`,
      )).rows[0].id;
      const tourId = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants) VALUES ('Горелый & кратер', 9000, $1, 12) RETURNING id`, [opId],
      )).rows[0].id;
      // D0 — дата заявки; D2 — одно место на двоих; D3 — отменена. Свободны на двоих D1 и D4.
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled) VALUES
           ($1, $2::date, 10, false), ($1, $3::date, 5, false), ($1, $4::date, 1, false), ($1, $5::date, 8, true), ($1, $6::date, 6, false)`,
        [tourId, D0, D1, D2, D3, D4],
      );
      const comment = `[Заявка на бронь] Тур "Горелый & кратер" (ID${tourId}), дата ${D0}, участников 2. С детьми`;
      const lead = await leads.createLeadDetailed({
        name: 'Ирина Дата', phone: '+79995550505', comment, route_title: 'Горелый & кратер',
        source_url: 'mcp://vedar/booking', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourId, date: D0, participants: 2 },
        skip_ai_processing: true,
      });
      const A = 9_300_031;
      const B = 9_300_032;
      const TG = 7_300_031;
      const fresh = await status.issueRequestKeyRecord({ leadId: lead!.id }, 'create_booking_request', { opensChat: true });
      expect(await links.linkChatToKeys('max', A, [fresh!.key], 'created')).toBe(1);
      expect(await links.linkChatToKeys('telegram', TG, [fresh!.key], 'status_link')).toBe(1);
      // Чат с ключом ПОВТОРА той же заявки видит статус, но дату не меняет.
      const repeat = await status.issueRequestKeyRecord({ leadId: lead!.id }, 'create_booking_request', { opensChat: false });
      expect(await links.linkChatToKeys('max', B, [repeat!.key], 'created')).toBe(1);

      // Кнопки под списком: в MAX — «Написать» и «Изменить дату», в Telegram — только дата, у повтора — ничего.
      expect((await myTrip.myTripMessage('max', A)).buttons.map((b) => b.text)).toEqual(['Написать оператору', 'Изменить дату']);
      const tg = await myTrip.myTripMessage('telegram', TG);
      expect(tg.buttons.map((b) => b.text)).toEqual(['Изменить дату']);
      expect((await myTrip.myTripMessage('max', B)).buttons).toEqual([]);
      const menuPayload = tg.buttons[0]!.payload;
      expect((await dates.pressMyTripDate(menuPayload, 'max', B)).text).toMatch(/не подключена к этому чату/);

      // Даты — свободные на двоих, без текущей, без отменённой и без одного места.
      const menu = await dates.pressMyTripDate(menuPayload, 'telegram', TG);
      expect(menu.text).toMatch(/выбранная дата сразу встанет в заявку/);
      expect(menu.buttons.map((b) => b.text)).toEqual([`${short(D1)} · мест 5`, `${short(D4)} · мест 6`]);
      const pickOf = (b: (typeof menu.buttons)[number]) => {
        const p = unwrapPress('payload' in b ? b.payload : '');
        return p.ok ? p.payload : '';
      };

      // Оператор не ответил — дата в заявке и в строке для оператора меняется сразу; журнал и сообщение оператору.
      sent.pd.length = 0;
      const changed = await dates.pressMyTripDate(pickOf(menu.buttons[0]!), 'telegram', TG);
      expect(changed.text).toMatch(/^Дата в заявке изменена: тур «Горелый &amp; кратер», теперь /);
      const row = (await pool.query(`SELECT source_data->>'date' AS date, comment FROM leads WHERE id = $1`, [lead!.id])).rows[0];
      expect(row.date).toBe(D1);
      expect(row.comment).toBe(`[Заявка на бронь] Тур "Горелый & кратер" (ID${tourId}), дата ${D1}, участников 2. С детьми`);
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.text).toContain('Турист перенёс заявку на другую дату');
      expect(String(sent.pd[0]!.to?.maxChatId)).toBe('9300199');
      expect(sent.pd[0]!.text).not.toMatch(/Ирина|79995550505/);
      const journal = async () => (await pool.query(
        `SELECT actor, action, details FROM lead_activity_log WHERE lead_id = $1 AND action LIKE 'date_change%' ORDER BY id`, [lead!.id],
      )).rows;
      expect(await journal()).toEqual([
        { actor: 'tourist', action: 'date_changed', details: { from: D0, to: D1, channel: 'telegram', delivery: 'max' } },
      ]);
      // Статус заявки называет новую дату.
      const trip = await myTrip.loadMyTrip('max', A);
      expect(trip.outcome === 'ok' && trip.items[0]!.date).toBe(D1);

      // Оператор ответил кнопкой — условная запись больше не проходит, даже с верной прежней датой.
      await pool.query(
        `INSERT INTO partner_incoming_answers (partner_id, subject_kind, subject_id, answer) VALUES ($1, 'lead', $2, 'accept')`,
        [opId, lead!.id],
      );
      const blocked = await pool.query(dates.MY_TRIP_DATE_CHANGE_SQL, [lead!.id, D4, D1, 'max']);
      expect(blocked.rows).toEqual([]);
      // Теперь выбор даты — просьба оператору; дата в заявке прежняя.
      const menu2 = await dates.pressMyTripDate(menuPayload, 'max', A);
      expect(menu2.text).toMatch(/Оператор уже ответил по заявке, поэтому дату меняет он/);
      // Прежняя D0 снова в списке: дата заявки теперь D1.
      expect(menu2.buttons.map((b) => b.text)).toEqual([`${short(D0)} · мест 10`, `${short(D4)} · мест 6`]);
      sent.pd.length = 0;
      const asked = await dates.pressMyTripDate(pickOf(menu2.buttons[1]!), 'max', A);
      expect(asked.text).toMatch(/просьба перенести на .* ему отправлена/);
      expect(sent.pd[0]!.text).toContain('Турист просит перенести заявку');
      expect((await pool.query(`SELECT source_data->>'date' AS date FROM leads WHERE id = $1`, [lead!.id])).rows[0].date).toBe(D1);
      expect((await journal()).map((r) => [r.action, r.details])).toEqual([
        ['date_changed', { from: D0, to: D1, channel: 'telegram', delivery: 'max' }],
        ['date_change_requested', { from: D1, to: D4, channel: 'max', delivery: 'max' }],
      ]);

      // Сутки считаются по журналу: две записи — ещё можно, три — хватит.
      const lim = await pool.query<{ date_actions: number; answered: boolean }>(dates.MY_TRIP_DATE_LEAD_SQL, ['max', String(A), lead!.id]);
      expect(lim.rows[0]).toMatchObject({ date_actions: 2, answered: true });
      await dates.pressMyTripDate(pickOf(menu2.buttons[0]!), 'max', A);
      expect((await dates.pressMyTripDate(menuPayload, 'max', A)).text).toMatch(/за сутки уже меняли/);

      // Лиды и календарь этой сцены не мешают соседним.
      await pool.query(`DELETE FROM tour_availability WHERE operator_tour_id = $1::bigint`, [tourId]);
    });

    it('удалили заявку — связи ушли вместе с её ключами', async () => {
      const own = await pool.query(`SELECT lead_id::text AS lead FROM agent_request_keys WHERE id = $1`, [keyId]);
      await pool.query(`DELETE FROM agent_request_keys WHERE lead_id = $1::uuid`, [own.rows[0].lead]);
      const left = await pool.query(`SELECT count(*)::int AS n FROM chat_request_links WHERE chat_id IN ($1, $2)`, [String(CHAT), String(OTHER)]);
      expect(left.rows[0].n).toBe(0);
    });
  });
});
