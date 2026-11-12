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

    it('«Отменить заявку» (1427): до ответа оператора — сразу, после — просьбой; отменённую не возвращают, не передают и не считают прежней', async () => {
      process.env.CALLBACK_SIGNING_SECRET ??= 'pg-test-signing';
      const myTrip = await import('@/lib/requests/my-trip');
      const cancel = await import('@/lib/requests/my-trip-cancel');
      const core = await import('@/lib/requests/cancel-request');
      const { unwrapPress } = await import('@/lib/chat-cabinet/signed-payload');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const { changeLeadStatus } = await import('@/lib/leads/owner-lead-status');
      const { FOLLOWUP_LEADS_SQL, FOLLOWUP_LEADS_PARAMS } = await import('@/lib/leads/followup-scope');
      const answers = await import('@/lib/requests/chat-answer');
      const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 20);
      const D0 = d.toISOString().slice(0, 10);
      const ru = `${D0.slice(8, 10)}.${D0.slice(5, 7)}.${D0.slice(0, 4)}`;
      const opId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, slug, max_chat_id) VALUES ('Оператор отмены', 'operator', '{}', 'op-cancel-1427', 9300299) RETURNING id`,
      )).rows[0].id;
      const tourId = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants) VALUES ('Мутновский <кратер>', 9000, $1, 12) RETURNING id`, [opId],
      )).rows[0].id;
      const commentOf = (people: number) => `[Заявка на бронь] Тур "Мутновский <кратер>" (ID${tourId}), дата ${D0}, участников ${people}.`;
      const mk = async (name: string, phone: string, people = 2, extra: Record<string, unknown> = {}) => (await leads.createLeadDetailed({
        name, phone, comment: commentOf(people), route_title: 'Мутновский <кратер>',
        source_url: 'mcp://vedar/booking', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourId, date: D0, participants: people, ...extra },
        skip_ai_processing: true,
      }))!;
      const statusOf = async (lead: string) => (await pool.query<{ status: string; operator_id: string | null }>(
        `SELECT status, operator_id::text AS operator_id FROM leads WHERE id = $1`, [lead],
      )).rows[0]!;
      const journal = async (lead: string) => (await pool.query(
        `SELECT actor, action, details FROM lead_activity_log WHERE lead_id = $1 AND action IN ('client_cancelled', 'cancel_requested') ORDER BY id`, [lead],
      )).rows;
      const yesOf = (r: { buttons: Array<{ text: string } & ({ payload: string } | { url: string })> }) => {
        const b = r.buttons[0]!;
        const p = unwrapPress('payload' in b ? b.payload : '');
        return p.ok ? p.payload : '';
      };
      const A = 9_300_041;
      const B = 9_300_042;
      const TG = 7_300_041;

      // ── 1. Оператор не ответил — заявка отменяется сразу ──────────────────
      const L1 = await mk('Олег Отмена', '+79995550601');
      expect(L1.created).toBe(true);
      const k1 = await status.issueRequestKeyRecord({ leadId: L1.id }, 'create_booking_request', { opensChat: true });
      expect(await links.linkChatToKeys('max', A, [k1!.key], 'created')).toBe(1);
      // Чат с ключом ПОВТОРА видит статус, но не отменяет.
      const repeat = await status.issueRequestKeyRecord({ leadId: L1.id }, 'create_booking_request', { opensChat: false });
      expect(await links.linkChatToKeys('max', B, [repeat!.key], 'created')).toBe(1);

      const list = await myTrip.myTripMessage('max', A);
      expect(list.buttons.map((b) => b.text)).toEqual(['Написать оператору', 'Изменить дату', 'Отменить заявку']);
      expect((await myTrip.myTripMessage('max', B)).buttons).toEqual([]);
      const askPayload = list.buttons[2]!.payload;
      expect((await cancel.pressMyTripCancel(askPayload, 'max', B)).text).toMatch(/не подключена к этому чату/);
      // Тот же номер чата в другом мессенджере — другой чат: связь проверяется с каналом.
      expect((await cancel.pressMyTripCancel(askPayload, 'telegram', A)).text).toMatch(/не подключена к этому чату/);

      // Вопрос говорит, что произойдёт, и ничего не пишет.
      const asked = await cancel.pressMyTripCancel(askPayload, 'max', A);
      expect(asked.text).toBe([
        'Отменить заявку?',
        `Тур «Мутновский &lt;кратер&gt;», ${ru}, участников 2.`,
        'Оператор ещё не ответил — заявка отменится сразу, оператору уйдёт сообщение.',
        'Вернуть отменённую заявку нельзя: понадобится новая.',
        'Передумали — ничего нажимать не нужно.',
      ].join('\n'));
      expect(asked.buttons.map((b) => b.text)).toEqual(['Да, отменить заявку']);
      expect((await statusOf(L1.id)).status).toBe('new');
      expect(await journal(L1.id)).toEqual([]);
      const yes = yesOf(asked);
      expect(yes).toMatch(/^mx:[0-9a-f]{32}$/);
      // «Да» из чата с ключом повтора — не отмена.
      expect((await cancel.pressMyTripCancel(yes, 'max', B)).text).toMatch(/не подключена к этому чату/);
      expect((await statusOf(L1.id)).status).toBe('new');

      sent.pd.length = 0;
      const done = await cancel.pressMyTripCancel(yes, 'max', A);
      expect(done.text).toBe(`Заявка отменена: Тур «Мутновский &lt;кратер&gt;», ${ru}, участников 2. Оператору ушло сообщение. Новую заявку можно оставить здесь же, в чате.`);
      expect((await statusOf(L1.id)).status).toBe('cancelled');
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.text).toContain('Турист отменил заявку');
      expect(sent.pd[0]!.text).toContain(`Тур «Мутновский &lt;кратер&gt;», ${ru}, участников 2.`);
      expect(String(sent.pd[0]!.to?.maxChatId)).toBe('9300299');
      expect(sent.pd[0]!.text).not.toMatch(/Олег|79995550601/);
      expect(await journal(L1.id)).toEqual([
        { actor: 'tourist', action: 'client_cancelled', details: { channel: 'max', from: 'new', delivery: 'max', manager: 'not_needed' } },
      ]);
      // Событие в ленте клиента — от туриста, а не от партнёра.
      const ev = (await pool.query(
        `SELECT actor_kind, payload FROM crm_events WHERE source_kind = 'lead' AND source_id = $1 AND kind = 'status_change' ORDER BY occurred_at DESC LIMIT 1`, [L1.id],
      )).rows[0];
      expect(ev).toMatchObject({ actor_kind: 'tourist', payload: { from: 'new', to: 'cancelled', via: 'max' } });

      // Повтор «Да» и новый вопрос — «уже отменена»; второго сообщения оператору нет.
      sent.pd.length = 0;
      expect((await cancel.pressMyTripCancel(yes, 'max', A)).text).toBe('Заявка уже отменена — ничего не изменено.');
      expect((await cancel.pressMyTripCancel(askPayload, 'max', A)).text).toBe('Заявка уже отменена — ничего не изменено.');
      expect(sent.pd).toHaveLength(0);
      expect(await journal(L1.id)).toHaveLength(1);
      // Вторая запись отмены на ту же заявку базой не принимается (индекс 1427).
      await expect(pool.query(
        `INSERT INTO lead_activity_log (lead_id, actor, action, details) VALUES ($1, 'tourist', 'client_cancelled', '{}')`, [L1.id],
      )).rejects.toMatchObject({ code: '23505' });

      // Статус для ИИ-агента и «Моя поездка»: отменена клиентом — не «бронь отменена»; кнопок даты и отмены больше нет.
      const view = await status.readRequestStatus(k1!.key, { reader: 'agent' });
      expect(view).toMatchObject({ state: 'cancelled', human: 'Заявка отменена клиентом.' });
      const after = await myTrip.myTripMessage('max', A);
      expect(after.text).toContain('Заявка отменена клиентом.');
      expect(after.buttons.map((b) => b.text)).toEqual(['Написать оператору']);
      // Старая кнопка «Изменить дату» под прежним сообщением: заявка закрыта — оператору просьба о переносе не уходит.
      const staleDate = list.buttons[1]!.payload;
      sent.pd.length = 0;
      expect((await (await import('@/lib/requests/my-trip-date')).pressMyTripDate(staleDate, 'max', A)).text)
        .toBe('Заявка закрыта — дату по ней не меняю. Новую поездку можно подобрать здесь же, в чате.');
      expect(sent.pd).toHaveLength(0);

      // Вернуть в работу нельзя: ни статусом из кабинета, ни «Договорились»; заметку — можно.
      const scope = { kind: 'owner' as const, partnerId: opId, claimUnowned: true };
      const actor = { kind: 'partner_user' as const, userId: null };
      const stamp = async (lead: string) => (await pool.query<{ u: string }>(`SELECT updated_at::text AS u FROM leads WHERE id = $1`, [lead])).rows[0]!.u;
      const stamp1 = await stamp(L1.id);
      for (const st of ['contacted', 'qualified', 'converted', 'lost', 'new'] as const) {
        const r = await changeLeadStatus({ leadId: L1.id, status: st, actor, scope, via: 'site' });
        expect(r, st).toMatchObject({ kind: 'ok', changed: false, prevStatus: 'cancelled', lead: { status: 'cancelled' } });
      }
      // Строка заявки при этом не переписывалась вовсе: время правки то же (в списках она не «всплывает»).
      expect(await stamp(L1.id)).toBe(stamp1);
      const noted = await changeLeadStatus({ leadId: L1.id, status: 'contacted', notes: 'звонил, отменил сам', actor, scope, via: 'site' });
      expect(noted).toMatchObject({ kind: 'ok', changed: false, lead: { status: 'cancelled', notes: 'звонил, отменил сам' } });
      expect((await statusOf(L1.id)).status).toBe('cancelled');

      // Ответ оператора кнопкой по отменённой заявке клиенту не уходит: строка сообщения гасится сразу.
      const late = await answers.recordChatAnswer({ partnerId: opId, kind: 'lead', subjectId: L1.id, answer: 'no_seats', reason: null, expectDate: D0 });
      // Запись ответа называет статус заявки: по нему оператору говорят «клиент отменил», а не «принято».
      expect(late).toMatchObject({ ok: true, leadStatus: 'cancelled' });
      expect((await pool.query(`SELECT state, skipped_reason FROM answer_notices WHERE lead_id = $1::uuid`, [L1.id])).rows)
        .toEqual([{ state: 'skipped', skipped_reason: 'lead_closed' }]);

      // Новая заявка тем же телефоном на тот же тур и дату — новая, а не «прежняя» отменённая.
      // Пока новой нет, поиск «прежней» по началу комментария отменённую не находит.
      expect(await leads.findRecentLeadByCommentPrefix('+79995550601', `[Заявка на бронь] Тур "Мутновский <кратер>" (ID${tourId}), дата ${D0}`)).toBeNull();
      const again = await mk('Олег Отмена', '+79995550601');
      expect(again.created).toBe(true);
      expect(again.id).not.toBe(L1.id);
      expect(await leads.findRecentLeadByCommentPrefix('+79995550601', `[Заявка на бронь] Тур "Мутновский <кратер>" (ID${tourId}), дата ${D0}`)).toBe(again.id);

      // Конвейер разбора отмену не затирает: ни «в обработке», ни итогом, ни откатом ошибки, ни «предложение отправлено».
      const ai = await import('@/lib/services/operators/lead-processor.service');
      await expect(ai.leadProcessor.process(L1.id)).rejects.toMatchObject({ name: 'LeadCancelledByClientError' });
      expect((await pool.query(ai.LEAD_AI_START_SQL, [L1.id, 'cancelled'])).rowCount).toBe(0);
      await pool.query(ai.LEAD_AI_DONE_SQL, [77, 'итог разбора', '{}', [], null, L1.id]);
      await pool.query(ai.LEAD_AI_ROLLBACK_SQL, [L1.id]);
      expect((await pool.query(ai.LEAD_PROPOSAL_SENT_SQL, [L1.id, 'cancelled'])).rowCount).toBe(0);
      // Итог разбора записан, статус — нет.
      expect((await pool.query(`SELECT status, ai_score FROM leads WHERE id = $1`, [L1.id])).rows[0]).toEqual({ status: 'cancelled', ai_score: 77 });
      // На живой заявке те же записи работают: новая → в обработке; откат ошибки снимает свою отметку…
      const aiStatus = async () => (await statusOf(again.id)).status;
      expect((await pool.query(ai.LEAD_AI_START_SQL, [again.id, 'cancelled'])).rowCount).toBe(1);
      expect(await aiStatus()).toBe('ai_processing');
      await pool.query(ai.LEAD_AI_ROLLBACK_SQL, [again.id]);
      expect(await aiStatus()).toBe('new');
      // …итог разбора переводит «в обработке» в «разобрана»…
      await pool.query(ai.LEAD_AI_START_SQL, [again.id, 'cancelled']);
      await pool.query(ai.LEAD_AI_DONE_SQL, [50, 'итог', '{}', [], null, again.id]);
      expect(await aiStatus()).toBe('ai_qualified');
      // …а статус, который оператор поставил, пока шёл разбор, не затирают ни итог, ни откат.
      await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [again.id]);
      await pool.query(ai.LEAD_AI_DONE_SQL, [60, 'итог', '{}', [], null, again.id]);
      await pool.query(ai.LEAD_AI_ROLLBACK_SQL, [again.id]);
      expect((await pool.query(`SELECT status, ai_score FROM leads WHERE id = $1`, [again.id])).rows[0]).toEqual({ status: 'contacted', ai_score: 60 });
      expect((await pool.query(ai.LEAD_PROPOSAL_SENT_SQL, [again.id, 'cancelled'])).rowCount).toBe(1);
      expect(await aiStatus()).toBe('proposal_sent');

      // Двери мимо кабинета отменённую тоже не возвращают.
      // Кнопка статуса в рабочем чате: свой исход, статус на месте; у живой заявки и у несуществующей — прежние.
      const { applyLeadStatus, LEAD_STATUS_ACTION_SQL } = await import('@/lib/leads/status-action');
      for (const prefix of ['lead_contacted', 'lead_qualified', 'lead_converted', 'lead_lost']) {
        expect(await applyLeadStatus(prefix, L1.id), prefix).toEqual({ outcome: 'cancelled_by_client' });
      }
      expect((await statusOf(L1.id)).status).toBe('cancelled');
      expect((await pool.query(LEAD_STATUS_ACTION_SQL, ['lost', L1.id, 'cancelled'])).rows).toEqual([{ name: null, prev_status: 'cancelled', updated: false }]);
      expect(await applyLeadStatus('lead_lost', '00000000-0000-4000-8000-000000000000')).toEqual({ outcome: 'not_found' });
      expect(await applyLeadStatus('lead_contacted', again.id)).toEqual({ outcome: 'updated', status: 'contacted', label: 'Связались', name: 'Олег Отмена' });
      expect(await aiStatus()).toBe('contacted');
      // Отправка предложения: отменённой — отказ своими словами, лид не занят; живую захват берёт и помнит прежний статус.
      const delivery = await import('@/lib/leads/proposal-delivery');
      expect(await delivery.sendProposalToClient(L1.id)).toEqual({ ok: false, reason: 'lead_cancelled', message: 'Заявку отменил клиент — предложение не отправляется.' });
      expect((await pool.query(delivery.PROPOSAL_CLAIM_SQL, [L1.id, 'cancelled'])).rows).toEqual([]);
      expect((await statusOf(L1.id)).status).toBe('cancelled');
      expect((await pool.query(delivery.PROPOSAL_CLAIM_SQL, [again.id, 'cancelled'])).rows).toEqual([{ prev_status: 'contacted' }]);
      expect(await aiStatus()).toBe('proposal_sent');
      expect((await pool.query(delivery.PROPOSAL_CLAIM_SQL, [again.id, 'cancelled'])).rows).toEqual([]);
      // Квалификация моделью: только пока заявка всё ещё новая.
      const { LEAD_AGENCY_QUALIFY_SQL } = await import('@/lib/agents/agencies/lead-agency');
      expect((await pool.query(LEAD_AGENCY_QUALIFY_SQL, ['Квалификация: 9/10', L1.id])).rowCount).toBe(0);
      expect((await pool.query(LEAD_AGENCY_QUALIFY_SQL, ['Квалификация: 9/10', again.id])).rowCount).toBe(0);
      expect((await pool.query(`SELECT status, notes FROM leads WHERE id = $1`, [L1.id])).rows[0]).toEqual({ status: 'cancelled', notes: 'звонил, отменил сам' });
      await pool.query(`UPDATE leads SET status = 'new' WHERE id = $1`, [again.id]);
      expect((await pool.query(LEAD_AGENCY_QUALIFY_SQL, ['Квалификация: 9/10', again.id])).rowCount).toBe(1);
      expect((await pool.query(`SELECT status, notes FROM leads WHERE id = $1`, [again.id])).rows[0]).toEqual({ status: 'qualified', notes: 'Квалификация: 9/10' });

      // ── 2. Оператор ответил — отмена только просьбой; заявка и бронь не трогаются ──
      const L2 = await mk('Вера Просьба', '+79995550602', 3);
      const k2 = await status.issueRequestKeyRecord({ leadId: L2.id }, 'create_booking_request', { opensChat: true });
      expect(await links.linkChatToKeys('telegram', TG, [k2!.key], 'created')).toBe(1);
      const ask2 = (await myTrip.myTripMessage('telegram', TG)).buttons.find((b) => b.text === 'Отменить заявку')!.payload;
      // Вопрос задан до ответа оператора…
      const early = await cancel.pressMyTripCancel(ask2, 'telegram', TG);
      expect(early.buttons.map((b) => b.text)).toEqual(['Да, отменить заявку']);
      // …а оператор ответил раньше «Да»: условная запись не проходит, уходит просьба.
      await pool.query(
        `INSERT INTO partner_incoming_answers (partner_id, subject_kind, subject_id, answer, subject_date) VALUES ($1, 'lead', $2, 'accept', $3)`,
        [opId, L2.id, D0],
      );
      expect((await pool.query(core.CANCEL_NOW_SQL, [L2.id, 'telegram'])).rows).toEqual([]);
      sent.pd.length = 0;
      const req = await cancel.pressMyTripCancel(yesOf(early), 'telegram', TG);
      expect(req.text).toBe('Оператор уже ответил по заявке, поэтому отменяет он: просьба ему отправлена. Заявка действует, пока он её не закроет.');
      expect((await statusOf(L2.id)).status).toBe('new');
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.text).toContain('Турист просит отменить заявку');
      expect(sent.pd[0]!.text).not.toMatch(/Вера|79995550602/);
      expect(await journal(L2.id)).toEqual([
        { actor: 'tourist', action: 'cancel_requested', details: { channel: 'telegram', delivery: 'max', manager: 'not_needed' } },
      ]);
      const readRow = async (lead: string) => (await pool.query(
        `SELECT ${core.CANCEL_LEAD_COLUMNS_SQL} FROM leads l ${core.CANCEL_LEAD_JOINS_SQL} WHERE l.id = $1::uuid`, [lead],
      )).rows[0];
      // Запись просьбы помнит, кому дошла, — этим и отвечает повтор.
      expect((await readRow(L2.id)).cancel_request).toEqual({ delivery: 'max', manager: 'not_needed', fresh: true });
      expect(core.priorCancelRequest(await readRow(L2.id))).toBe('operator');
      // Вопрос теперь говорит о просьбе, и вторая просьба не уходит.
      sent.pd.length = 0;
      const ask2b = await cancel.pressMyTripCancel(ask2, 'telegram', TG);
      expect(ask2b.text).toMatch(/^Просьба об отмене по этой заявке уже отправлена оператору/);
      expect(ask2b.buttons).toEqual([]);
      expect((await cancel.pressMyTripCancel(yesOf(early), 'telegram', TG)).text).toMatch(/^Просьба об отмене по этой заявке уже отправлена оператору/);
      expect(sent.pd).toHaveLength(0);
      expect(await journal(L2.id)).toHaveLength(1);
      expect((await pool.query(core.CANCEL_REQUEST_SQL, [L2.id, 'telegram'])).rows).toEqual([]);

      // ── 3. Бронь по заявке — всегда просьба, бронь не тронута ─────────────
      const L3 = await mk('Нина Бронь', '+79995550603', 1);
      const b3 = (await pool.query<{ id: string }>(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status, lead_id, tourist_name, base_total_price, final_price)
         VALUES ($1, $2::date, 1, 'confirmed', $3::uuid, 'Нина Бронь', 9000, 9000) RETURNING id::text`, [tourId, D0, L3.id],
      )).rows[0]!.id;
      await pool.query(`UPDATE leads SET status = 'converted' WHERE id = $1`, [L3.id]);
      const row3 = (await pool.query(`SELECT ${core.CANCEL_LEAD_COLUMNS_SQL} FROM leads l ${core.CANCEL_LEAD_JOINS_SQL} WHERE l.id = $1::uuid`, [L3.id])).rows[0];
      expect(row3).toMatchObject({ status: 'converted', booking_status: 'confirmed', answered: true, cancel_request: null, participants: 1 });
      expect(core.cancelMode(row3)).toBe('request');
      expect((await pool.query(core.CANCEL_NOW_SQL, [L3.id, 'max'])).rows).toEqual([]);
      expect((await pool.query(`SELECT booking_status FROM operator_bookings WHERE id = $1::bigint`, [b3])).rows[0].booking_status).toBe('confirmed');

      // ── 4. Большая группа, переданная другим: адресата нет — отмена сразу, дальше её не раздают ──
      const L4 = await mk('Пётр Группа', '+79995550604', 20, { group_over_seats: true });
      const k4 = await status.issueRequestKeyRecord({ leadId: L4.id }, 'create_booking_request', { opensChat: true });
      const G = 9_300_043;
      expect(await links.linkChatToKeys('max', G, [k4!.key], 'created')).toBe(1);
      await answers.recordChatAnswer({ partnerId: opId, kind: 'lead', subjectId: L4.id, answer: 'no_seats', reason: null, expectDate: D0 });
      // Как крон добивки: адресата нет, отказавшийся — в declined_by; заявка старше двух часов.
      await pool.query(
        `UPDATE leads SET operator_id = NULL, status = 'new', created_at = NOW() - INTERVAL '3 hours',
                source_data = source_data || '{"declined_by":"op-cancel-1427","notified_operators":["op-cancel-1427"]}'::jsonb
          WHERE id = $1`, [L4.id],
      );
      const inFollowup = async () => (await pool.query<{ id: string }>(FOLLOWUP_LEADS_SQL, [...FOLLOWUP_LEADS_PARAMS])).rows.map((r) => r.id);
      expect(await inFollowup()).toContain(L4.id);
      const ask4 = (await myTrip.myTripMessage('max', G)).buttons.find((b) => b.text === 'Отменить заявку')!.payload;
      const q4 = await cancel.pressMyTripCancel(ask4, 'max', G);
      expect(q4.text).toContain('Оператора у заявки сейчас нет — она отменится сразу, и дальше её никому не передадут.');
      sent.pd.length = 0;
      const done4 = await cancel.pressMyTripCancel(yesOf(q4), 'max', G);
      expect(done4.text).toMatch(/^Заявка отменена: .* Оператора у неё не было — дальше её никому не передадут\./);
      expect(await statusOf(L4.id)).toEqual({ status: 'cancelled', operator_id: null });
      // Оператору писать некому — строка без ПД уходит менеджеру (в рабочий чат, без адресата).
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.to).toBeUndefined();
      expect(sent.pd[0]!.text).toContain('Клиент отменил заявку');
      expect(sent.pd[0]!.text).toContain('У заявки нет адресата');
      expect(sent.pd[0]!.text).not.toMatch(/Пётр|79995550604/);
      expect(await journal(L4.id)).toEqual([
        { actor: 'tourist', action: 'client_cancelled', details: { channel: 'max', from: 'new', delivery: 'no_addressee', manager: 'told' } },
      ]);
      // Крон добивки отменённую больше не берёт.
      expect(await inFollowup()).not.toContain(L4.id);
      // Статус заявки — «отменена клиентом», а не прежний ответ отказавшегося оператора.
      expect(await status.readRequestStatus(k4!.key, { reader: 'agent' })).toMatchObject({ state: 'cancelled', human: 'Заявка отменена клиентом.' });

      // ── 5. Отказ оператора закрыл заявку; прошедшая поездка — отменять нечего ──
      const L5 = await mk('Яна Отказ', '+79995550605', 4);
      await pool.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [L5.id]);
      const read5 = async () => (await pool.query(`SELECT ${core.CANCEL_LEAD_COLUMNS_SQL} FROM leads l ${core.CANCEL_LEAD_JOINS_SQL} WHERE l.id = $1::uuid`, [L5.id])).rows[0];
      expect(core.cancelBlock(await read5(), kamchatkaToday())).toBe('closed');
      expect((await pool.query(core.CANCEL_NOW_SQL, [L5.id, 'max'])).rows).toEqual([]);
      expect((await pool.query(core.CANCEL_REQUEST_SQL, [L5.id, 'max'])).rows).toEqual([]);
      await pool.query(`UPDATE leads SET status = 'new', source_data = jsonb_set(source_data, '{date}', '"2020-01-01"') WHERE id = $1`, [L5.id]);
      expect(core.cancelBlock(await read5(), kamchatkaToday())).toBe('past');

      // Ничейную отменённую заявку оператор не занимает первым действием — и статус её не меняет.
      const stamp4 = await stamp(L4.id);
      const claim = await changeLeadStatus({ leadId: L4.id, status: 'contacted', actor, scope, via: 'max' });
      expect(claim).toMatchObject({ kind: 'ok', changed: false, prevStatus: 'cancelled', lead: { status: 'cancelled' } });
      expect(await statusOf(L4.id)).toEqual({ status: 'cancelled', operator_id: null });
      expect(await stamp(L4.id)).toBe(stamp4);
      // Заметка к ничейной отменённой пишется, но своей заявку не делает.
      const noted4 = await changeLeadStatus({ leadId: L4.id, status: 'contacted', notes: 'клиент отменил сам', actor, scope, via: 'site' });
      expect(noted4).toMatchObject({ kind: 'ok', changed: false, lead: { status: 'cancelled', notes: 'клиент отменил сам' } });
      expect(await statusOf(L4.id)).toEqual({ status: 'cancelled', operator_id: null });

      // ── 6. Право: только живой ключ НОВОЙ заявки на тур на дату, не своя проба ──
      const L6 = await mk('Тимур Право', '+79995550606', 2);
      const k6 = await status.issueRequestKeyRecord({ leadId: L6.id }, 'create_booking_request', { opensChat: true });
      const R = 9_300_044;
      expect(await links.linkChatToKeys('max', R, [k6!.key], 'created')).toBe(1);
      const ask6 = cancel.myTripCancelAskPayload(L6.id);
      const canAsk = async () => (await cancel.pressMyTripCancel(ask6, 'max', R)).buttons.length === 1;
      const refused = async () => (await cancel.pressMyTripCancel(ask6, 'max', R)).text;
      const hasCancel = async () => (await myTrip.myTripMessage('max', R)).buttons.some((b) => b.text === 'Отменить заявку');
      expect(await canAsk()).toBe(true);
      expect(await hasCancel()).toBe(true);
      // Ключ другого инструмента (заявка на машину) эту дверь не открывает — и кнопки под списком у него нет.
      await pool.query(`UPDATE agent_request_keys SET tool_name = 'request_charter' WHERE lead_id = $1::uuid`, [L6.id]);
      expect(await refused()).toMatch(/не подключена к этому чату/);
      expect(await hasCancel()).toBe(false);
      await pool.query(`UPDATE agent_request_keys SET tool_name = 'create_booking_request' WHERE lead_id = $1::uuid`, [L6.id]);
      // Истёкший ключ — тоже.
      await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE lead_id = $1::uuid`, [L6.id]);
      expect(await refused()).toMatch(/не подключена к этому чату/);
      await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() + INTERVAL '1 day' WHERE lead_id = $1::uuid`, [L6.id]);
      // Своя проба владельца — не заявка клиента.
      await pool.query(`UPDATE leads SET is_self = TRUE WHERE id = $1`, [L6.id]);
      expect(await refused()).toMatch(/не подключена к этому чату/);
      await pool.query(`UPDATE leads SET is_self = FALSE WHERE id = $1`, [L6.id]);
      expect(await canAsk()).toBe(true);

      // Кнопка под списком: у действующей брони — есть (отмена пойдёт просьбой); у состоявшейся брони и у прошедшей поездки — нет.
      const b6 = (await pool.query<{ id: string }>(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status, lead_id, tourist_name, base_total_price, final_price)
         VALUES ($1, $2::date, 2, 'confirmed', $3::uuid, 'Тимур Право', 18000, 18000) RETURNING id::text`, [tourId, D0, L6.id],
      )).rows[0]!.id;
      expect(await hasCancel()).toBe(true);
      expect((await cancel.pressMyTripCancel(ask6, 'max', R)).text).toMatch(/^Попросить оператора отменить заявку\?/);
      await pool.query(`UPDATE operator_bookings SET booking_status = 'completed' WHERE id = $1::bigint`, [b6]);
      expect(await hasCancel()).toBe(false);
      await pool.query(`DELETE FROM operator_bookings WHERE id = $1::bigint`, [b6]);
      await pool.query(`UPDATE leads SET source_data = jsonb_set(source_data, '{date}', '"2020-01-01"') WHERE id = $1`, [L6.id]);
      expect(await hasCancel()).toBe(false);
      // Поездка сегодня ещё не прошла — отменить можно.
      await pool.query(`UPDATE leads SET source_data = jsonb_set(source_data, '{date}', to_jsonb($2::text)) WHERE id = $1`, [L6.id, kamchatkaToday()]);
      expect(await hasCancel()).toBe(true);
      await pool.query(`UPDATE leads SET source_data = jsonb_set(source_data, '{date}', to_jsonb($2::text)) WHERE id = $1`, [L6.id, D0]);
      expect(await hasCancel()).toBe(true);

      // Дата в заявке не записана — не помеха: кнопка есть (нажатие по такой заявке тоже проходит).
      await pool.query(`UPDATE leads SET source_data = source_data - 'date' WHERE id = $1`, [L6.id]);
      expect(await hasCancel()).toBe(true);
      await pool.query(`UPDATE leads SET source_data = jsonb_set(source_data, '{date}', to_jsonb($2::text)) WHERE id = $1`, [L6.id, D0]);

      // Пояса условной отмены там, где «ответил» не судит (заявка без адресата): отказ, «Договорились» и бронь её не дают.
      await pool.query(`UPDATE leads SET operator_id = NULL, status = 'lost' WHERE id = $1`, [L6.id]);
      expect((await pool.query(core.CANCEL_NOW_SQL, [L6.id, 'max'])).rows).toEqual([]);
      await pool.query(`UPDATE leads SET status = 'converted' WHERE id = $1`, [L6.id]);
      expect((await pool.query(core.CANCEL_NOW_SQL, [L6.id, 'max'])).rows).toEqual([]);
      await pool.query(`UPDATE leads SET status = 'new' WHERE id = $1`, [L6.id]);
      const b6b = (await pool.query<{ id: string }>(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status, lead_id, tourist_name, base_total_price, final_price)
         VALUES ($1, $2::date, 2, 'new', $3::uuid, 'Тимур Право', 18000, 18000) RETURNING id::text`, [tourId, D0, L6.id],
      )).rows[0]!.id;
      expect((await pool.query(core.CANCEL_NOW_SQL, [L6.id, 'max'])).rows).toEqual([]);
      await pool.query(`DELETE FROM operator_bookings WHERE id = $1::bigint`, [b6b]);
      // Без брони и без адресата — отменяется, даже когда статус уже не «ждёт» (крон отдал её менеджеру: «связались»):
      // у ничейной «ответил» не судит. Прежний статус и адресат возвращены записью.
      await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [L6.id]);
      expect((await readRow(L6.id)).answered).toBe(true);
      expect((await pool.query(core.CANCEL_NOW_SQL, [L6.id, 'max'])).rows).toEqual([
        { log_id: expect.stringMatching(/^\d+$/), prev_status: 'contacted', operator_id: null },
      ]);
      expect(await journal(L6.id)).toEqual([
        { actor: 'tourist', action: 'client_cancelled', details: { channel: 'max', from: 'contacted' } },
      ]);

      // Заявка из планера ищет «прежнюю» по отпечатку плана — отменённая клиентом и там не «прежняя».
      const { planForLead } = await import('@/lib/planner/plan-for-lead');
      type PlanDay = Parameters<typeof planForLead>[0][number];
      const pday = (n: number, title: string, extra: Partial<PlanDay> = {}): PlanDay => ({
        day: n, type: 'activity', zone: 'avachinsky', title, activityType: 'volcano', priceFrom: 0, priceTo: 0, ...extra,
      } as PlanDay);
      const tripPlan = planForLead(
        [pday(1, 'Прилёт', { type: 'arrival' }), pday(2, 'Авачинский вулкан'), pday(3, 'Вылет', { type: 'departure' })],
        { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor', arrivalDate: '2030-08-01' },
      );
      const planLead = async () => (await leads.createLeadDetailed({
        name: 'Ася План', phone: '+79995550607', comment: 'Маршрут 2030-08-01 (3 дн.)',
        source_data: { plan: tripPlan, source: 'saved_trip' }, pd_consent: consentOf('operator'), skip_ai_processing: true,
      }))!;
      const p1 = await planLead();
      expect(p1.created).toBe(true);
      expect(await planLead()).toMatchObject({ id: p1.id, created: false });
      await pool.query(`UPDATE leads SET status = 'cancelled' WHERE id = $1`, [p1.id]);
      const p2 = await planLead();
      expect(p2.created).toBe(true);
      expect(p2.id).not.toBe(p1.id);

      // ── 7. Просьба помнит, кому дошла; не дошла никому — заявка в силе, и нажатие отправляет заново ──
      const L7 = await mk('Зоя Доставка', '+79995550608', 2);
      const k7 = await status.issueRequestKeyRecord({ leadId: L7.id }, 'create_booking_request', { opensChat: true });
      const S = 9_300_045;
      expect(await links.linkChatToKeys('max', S, [k7!.key], 'created')).toBe(1);
      await pool.query(
        `INSERT INTO partner_incoming_answers (partner_id, subject_kind, subject_id, answer, subject_date) VALUES ($1, 'lead', $2, 'accept', $3)`,
        [opId, L7.id, D0],
      );
      const ask7 = cancel.myTripCancelAskPayload(L7.id);
      const yes7 = cancel.myTripCancelYesPayload(L7.id);
      const requests7 = async () => (await pool.query(
        `SELECT action, details FROM lead_activity_log WHERE lead_id = $1 AND action LIKE 'cancel_request%' ORDER BY id`, [L7.id],
      )).rows;
      expect((await readRow(L7.id)).cancel_request).toBeNull();
      // У оператора нет чата, рабочий чат платформы не принимает: о просьбе не узнал никто.
      await pool.query(`UPDATE partners SET max_chat_id = NULL WHERE id = $1`, [opId]);
      sent.adminFails = true;
      try {
        for (const n of [1, 2]) {
          const none = await cancel.pressMyTripCancel(yes7, 'max', S);
          expect(none.text).toBe('Оператор уже ответил по заявке, поэтому отменяет он, но передать просьбу сейчас не удалось — ни ему, ни менеджеру Ведара. Заявка остаётся в силе. Нажмите ещё раз через пару минут или напишите оператору, позвоните ему.');
          // Запись ушла из единственных: «уже отправлена» она не станет, и второе нажатие пробует снова.
          expect(await requests7()).toHaveLength(n);
          expect((await readRow(L7.id)).cancel_request).toBeNull();
        }
        expect(await requests7()).toEqual([
          { action: 'cancel_request_undelivered', details: { channel: 'max', delivery: 'none', manager: 'failed' } },
          { action: 'cancel_request_undelivered', details: { channel: 'max', delivery: 'none', manager: 'failed' } },
        ]);
      } finally {
        sent.adminFails = false;
      }
      // Рабочий чат принял, оператор всё ещё без чата: просьба дошла менеджеру — и повтор говорит именно это.
      sent.pd.length = 0;
      const viaManager = await cancel.pressMyTripCancel(yes7, 'max', S);
      expect(viaManager.text).toBe('Оператор уже ответил по заявке, поэтому отменяет он. Сообщить ему сейчас не удалось — просьба передана менеджеру Ведара. Заявка остаётся в силе, пока её не закроют; надёжнее написать оператору или позвонить.');
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.to).toBeUndefined();
      expect(sent.pd[0]!.text).toContain('Клиент просит отменить заявку');
      expect(sent.pd[0]!.text).not.toMatch(/Зоя|79995550608/);
      expect((await readRow(L7.id)).cancel_request).toEqual({ delivery: 'none', manager: 'told', fresh: true });
      sent.pd.length = 0;
      expect((await cancel.pressMyTripCancel(yes7, 'max', S)).text).toBe('Просьба об отмене по этой заявке уже передана менеджеру Ведара — повторно не отправляю. Заявка действует, пока её не закроют.');
      expect((await cancel.pressMyTripCancel(ask7, 'max', S)).text).toMatch(/уже передана менеджеру Ведара/);
      expect(sent.pd).toHaveLength(0);
      expect((await statusOf(L7.id)).status).toBe('new');
      // Дошедшую просьбу «зависшей» не считаем, сколько бы ей ни было.
      await pool.query(`UPDATE lead_activity_log SET created_at = created_at - INTERVAL '10 minutes' WHERE lead_id = $1 AND action = 'cancel_requested'`, [L7.id]);
      expect((await readRow(L7.id)).cancel_request).toEqual({ delivery: 'none', manager: 'told', fresh: false });
      expect((await pool.query(core.CANCEL_REQUEST_RELEASE_SQL, [L7.id])).rowCount).toBe(0);
      await pool.query(`UPDATE lead_activity_log SET details = details || '{"delivery":"telegram","manager":"not_needed"}'::jsonb WHERE lead_id = $1 AND action = 'cancel_requested'`, [L7.id]);
      expect((await pool.query(core.CANCEL_REQUEST_RELEASE_SQL, [L7.id])).rowCount).toBe(0);
      // Запись без исхода (процесс умер между записью и отправкой): свежая — «отправляется» и не освобождается…
      await pool.query(`UPDATE lead_activity_log SET details = '{"channel":"max"}'::jsonb, created_at = NOW() WHERE lead_id = $1 AND action = 'cancel_requested'`, [L7.id]);
      expect((await readRow(L7.id)).cancel_request).toEqual({ delivery: null, manager: null, fresh: true });
      expect((await cancel.pressMyTripCancel(yes7, 'max', S)).text).toMatch(/^Просьба об отмене по этой заявке уже отправляется — второе нажатие ничего не добавило\./);
      expect((await pool.query(core.CANCEL_REQUEST_RELEASE_SQL, [L7.id])).rowCount).toBe(0);
      expect(sent.pd).toHaveLength(0);
      // …а старше срока — освобождается, и просьба уходит заново, теперь оператору.
      await pool.query(`UPDATE lead_activity_log SET created_at = created_at - INTERVAL '3 minutes' WHERE lead_id = $1 AND action = 'cancel_requested'`, [L7.id]);
      expect((await readRow(L7.id)).cancel_request).toEqual({ delivery: null, manager: null, fresh: false });
      expect(core.priorCancelRequest(await readRow(L7.id))).toBe('stale');
      await pool.query(`UPDATE partners SET max_chat_id = 9300299 WHERE id = $1`, [opId]);
      const redo = await cancel.pressMyTripCancel(yes7, 'max', S);
      expect(redo.text).toBe('Оператор уже ответил по заявке, поэтому отменяет он: просьба ему отправлена. Заявка действует, пока он её не закроет.');
      expect(sent.pd).toHaveLength(1);
      expect(String(sent.pd[0]!.to?.maxChatId)).toBe('9300299');
      expect(await requests7()).toEqual([
        { action: 'cancel_request_undelivered', details: { channel: 'max', delivery: 'none', manager: 'failed' } },
        { action: 'cancel_request_undelivered', details: { channel: 'max', delivery: 'none', manager: 'failed' } },
        { action: 'cancel_request_undelivered', details: { channel: 'max' } },
        { action: 'cancel_requested', details: { channel: 'max', delivery: 'max', manager: 'not_needed' } },
      ]);
      // Двух действующих просьб у заявки быть не может (индекс 1427).
      await expect(pool.query(
        `INSERT INTO lead_activity_log (lead_id, actor, action, details) VALUES ($1, 'tourist', 'cancel_requested', '{}')`, [L7.id],
      )).rejects.toMatchObject({ code: '23505' });

      // ── 8. «Договорились» у заявки без адресата: не «сбой», а просьба менеджеру; заявка не тронута ──
      const L8 = await mk('Кира Договор', '+79995550609', 2);
      const k8 = await status.issueRequestKeyRecord({ leadId: L8.id }, 'create_booking_request', { opensChat: true });
      const Q = 9_300_046;
      expect(await links.linkChatToKeys('max', Q, [k8!.key], 'created')).toBe(1);
      await pool.query(`UPDATE leads SET operator_id = NULL, status = 'converted' WHERE id = $1`, [L8.id]);
      const ask8 = (await myTrip.myTripMessage('max', Q)).buttons.find((b) => b.text === 'Отменить заявку')!.payload;
      const q8 = await cancel.pressMyTripCancel(ask8, 'max', Q);
      expect(q8.text).toBe([
        'Попросить отменить заявку?',
        `Тур «Мутновский &lt;кратер&gt;», ${ru}, участников 2.`,
        'По заявке уже есть договорённость, поэтому сразу она не отменяется: просьба уйдёт менеджеру Ведара. Заявка действует, пока её не закроют.',
        'Передумали — ничего нажимать не нужно.',
      ].join('\n'));
      sent.pd.length = 0;
      const r8 = await cancel.pressMyTripCancel(yesOf(q8), 'max', Q);
      expect(r8.text).toBe('По заявке уже есть договорённость, поэтому сразу она не отменяется: просьба об отмене передана менеджеру Ведара. Заявка действует, пока её не закроют.');
      expect(await statusOf(L8.id)).toEqual({ status: 'converted', operator_id: null });
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.to).toBeUndefined();
      expect(sent.pd[0]!.text).toContain('Клиент просит отменить заявку');
      expect(sent.pd[0]!.text).toContain('У заявки нет адресата, но по ней записана бронь или отметка «Договорились»');
      expect(sent.pd[0]!.text).not.toMatch(/Кира|79995550609/);
      expect(await journal(L8.id)).toEqual([
        { actor: 'tourist', action: 'cancel_requested', details: { channel: 'max', delivery: 'no_addressee', manager: 'told' } },
      ]);
      expect((await cancel.pressMyTripCancel(yesOf(q8), 'max', Q)).text).toMatch(/^Просьба об отмене по этой заявке уже передана менеджеру Ведара/);

      await pool.query(`DELETE FROM operator_bookings WHERE id = $1::bigint`, [b3]);
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

      // Кнопки под списком: в MAX — «Написать», «Изменить дату» и «Отменить заявку» (1427), в Telegram — без «Написать», у повтора — ничего.
      expect((await myTrip.myTripMessage('max', A)).buttons.map((b) => b.text)).toEqual(['Написать оператору', 'Изменить дату', 'Отменить заявку']);
      const tg = await myTrip.myTripMessage('telegram', TG);
      expect(tg.buttons.map((b) => b.text)).toEqual(['Изменить дату', 'Отменить заявку']);
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

    it('после «Нет мест» (1422): ответ знает дату, дата меняется сразу, ответ на новую — второй строкой, статус о текущей', async () => {
      process.env.CALLBACK_SIGNING_SECRET ??= 'pg-test-signing';
      const myTrip = await import('@/lib/requests/my-trip');
      const dates = await import('@/lib/requests/my-trip-date');
      const answers = await import('@/lib/requests/chat-answer');
      const { unwrapPress } = await import('@/lib/chat-cabinet/signed-payload');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const day = (n: number) => {
        const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const short = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
      const [D0, D1, D4] = [day(20), day(22), day(28)];
      const partnerOf = async (name: string, maxChat: number) => (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ($1, 'operator', '{}', $2) RETURNING id`, [name, maxChat],
      )).rows[0].id;
      const opId = await partnerOf('Оператор после отказа', 9300299);
      const otherOp = await partnerOf('Другой оператор', 9300298);
      const tourId = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants) VALUES ('Мутновский', 9000, $1, 12) RETURNING id`, [opId],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled) VALUES
           ($1, $2::date, 10, false), ($1, $3::date, 5, false), ($1, $4::date, 6, false)`,
        [tourId, D0, D1, D4],
      );
      const lead = await leads.createLeadDetailed({
        name: 'Ольга Отказ', phone: '+79995550606', comment: `[Заявка на бронь] Тур "Мутновский" (ID${tourId}), дата ${D0}, участников 2.`,
        route_title: 'Мутновский', source_url: 'mcp://vedar/booking', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourId, date: D0, participants: 2 },
        skip_ai_processing: true,
      });
      const C = 9_300_041;
      const fresh = await status.issueRequestKeyRecord({ leadId: lead!.id }, 'create_booking_request', { opensChat: true });
      expect(await links.linkChatToKeys('max', C, [fresh!.key], 'created')).toBe(1);
      const record = (expectDate: string | null | undefined, partnerId = opId) => answers.recordChatAnswer({
        partnerId, kind: 'lead', subjectId: lead!.id, answer: 'no_seats', expectDate,
      });
      const tripItem = async () => {
        const t = await myTrip.loadMyTrip('max', C);
        if (t.outcome !== 'ok') throw new Error('«Моя поездка» не прочиталась');
        return t.items[0]!;
      };

      // «Нет мест» на D0: запись с датой заявки; повтор — «уже», второй строки нет.
      expect(await record(D0)).toMatchObject({ ok: true, already: false, dateChanged: false, subjectDate: D0 });
      expect(await record(D0)).toEqual({ ok: true, already: true, dateChanged: false, subjectDate: D0, leadStatus: 'new' });
      expect((await tripItem()).human).toMatch(/мест нет/);

      // Дата не заперта: ответа «за оператором» нет, D0 — среди отказанных.
      const lr = await pool.query(dates.MY_TRIP_DATE_LEAD_SQL, ['max', String(C), lead!.id]);
      expect(lr.rows[0]).toMatchObject({ answered: false, refused_dates: [D0] });
      const menu = await dates.pressMyTripDate(dates.myTripDateMenuPayload(lead!.id), 'max', C);
      expect(menu.text).toMatch(/Оператор ответил «Нет мест» на .* — выбранная дата сразу встанет в заявку/);
      expect(menu.buttons.map((b) => b.text)).toEqual([`${short(D1)} · мест 5`, `${short(D4)} · мест 6`]);
      const pickOf = (b: (typeof menu.buttons)[number]) => {
        const p = unwrapPress('payload' in b ? b.payload : '');
        return p.ok ? p.payload : '';
      };

      // Выбор D1 — дата в заявке сразу; оператору «после вашего «Нет мест»» с кнопками ответа.
      sent.pd.length = 0;
      expect((await dates.pressMyTripDate(pickOf(menu.buttons[0]!), 'max', C)).text).toMatch(/^Дата в заявке изменена/);
      expect((await pool.query(`SELECT source_data->>'date' AS d FROM leads WHERE id = $1`, [lead!.id])).rows[0].d).toBe(D1);
      expect(sent.pd[0]!.text).toContain('Турист перенёс заявку после вашего «Нет мест»');
      expect(sent.pd[0]!.text).not.toMatch(/Ольга|79995550606/);
      // Статус — о D1: ответа на неё нет, «мест нет» о D0 к ней не относится.
      const after = await tripItem();
      expect(after.date).toBe(D1);
      expect(after.human).not.toMatch(/мест нет/);

      // «Да», нажатое по вопросу о D0, после переноса ответа не пишет.
      expect(await record(D0)).toEqual({ ok: true, already: false, dateChanged: true, subjectDate: D1 });
      // «Нет мест» на D1 — вторая строка; ответ другого партнёра на ту же дату ключ не нарушает, но статус его не читает.
      expect(await record(D1)).toMatchObject({ ok: true, already: false, dateChanged: false, subjectDate: D1 });
      expect((await record(D1, otherOp)).ok).toBe(true);
      const rows = (await pool.query<{ partner_id: string; subject_date: string }>(
        `SELECT partner_id::text, subject_date FROM partner_incoming_answers WHERE subject_id = $1 ORDER BY id`, [lead!.id],
      )).rows;
      expect(rows).toEqual([
        { partner_id: opId, subject_date: D0 }, { partner_id: opId, subject_date: D1 }, { partner_id: otherOp, subject_date: D1 },
      ]);
      // Строка статуса одна (ключ — одна заявка), и она о D1.
      const st = await pool.query(status.REQUEST_STATUS_BY_KEY_IDS_SQL, [[fresh!.keyId]]);
      expect(st.rows).toHaveLength(1);
      expect(st.rows[0]).toMatchObject({ lead_answer: 'no_seats', lead_requested_date: D1 });
      // Меню теперь без D0 и D1; выбрать D0 снова нельзя.
      const menu2 = await dates.pressMyTripDate(dates.myTripDateMenuPayload(lead!.id), 'max', C);
      expect(menu2.buttons.map((b) => b.text)).toEqual([`${short(D4)} · мест 6`]);
      expect((await dates.pressMyTripDate(dates.myTripDatePickPayload(lead!.id, D0), 'max', C)).text)
        .toMatch(/оператор уже ответил «Нет мест» — выберите другую дату/);

      // Ответ без даты у заявки без ISO-даты — одна строка на партнёра (NULLS NOT DISTINCT).
      await pool.query(`UPDATE leads SET source_data = source_data - 'date' WHERE id = $1`, [lead!.id]);
      expect(await record(null)).toMatchObject({ ok: true, already: false, dateChanged: false, subjectDate: null });
      expect(await record(null)).toEqual({ ok: true, already: true, dateChanged: false, subjectDate: null, leadStatus: 'new' });

      await pool.query(`DELETE FROM tour_availability WHERE operator_tour_id = $1::bigint`, [tourId]);
    });

    it('отказ «погода или безопасность» (2в): даты — из проверки на настоящей схеме; прежние отказы по погоде не проверяются и названы числом', async () => {
      process.env.CALLBACK_SIGNING_SECRET ??= 'pg-test-signing';
      const answers = await import('@/lib/requests/chat-answer');
      const notices = await import('@/lib/requests/answer-notice');
      const { datesLine } = await import('@/lib/requests/answer-notice-text');
      const { checkTourDates } = await import('@/lib/trips/date-check');
      const { liveSources } = await import('@/lib/trips/situation-store');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const day = (n: number) => {
        const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      // Прогноз — на сегодня и четыре дня вперёд: D1 — дата заявки, D2 — отказ по погоде в другой
      // заявке, D3 — свободна и в прогнозе, D9 — свободна, но вне прогноза.
      const [D1, D2, D3, D9] = [day(1), day(2), day(3), day(9)];
      const opW = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ('Оператор 2в', 'operator', '{}', 9300599) RETURNING id`,
      )).rows[0].id;
      const place = (await pool.query<{ id: string; ark: string }>(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES (gen_random_uuid(), 'Вилючинский перевал', 52.7, 158.3, gen_random_uuid(), 'mountain', 'avachinsky', TRUE)
         RETURNING id::text AS id, ark_id::text AS ark`,
      )).rows[0];
      await pool.query(
        `INSERT INTO location_real_time_status (agent_route_id, is_open, recommender_status, updated_at)
         VALUES ($1::uuid, TRUE, 'green', (NOW() AT TIME ZONE 'UTC'))`, [place.ark],
      );
      const tourW = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants, is_active, is_published, main_place_id)
         VALUES ('Вилючинский', 9000, $1, 12, true, true, $2::uuid) RETURNING id`, [opW, place.id],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled) VALUES
           ($1, $2::date, 10, false), ($1, $3::date, 10, false), ($1, $4::date, 10, false), ($1, $5::date, 10, false)`,
        [tourW, D1, D2, D3, D9],
      );
      const mk = async (name: string, phone: string, date: string) => (await leads.createLeadDetailed({
        name, phone, comment: `[Заявка на бронь] Тур "Вилючинский" (ID${tourW}), дата ${date}, участников 2.`,
        route_title: 'Вилючинский', source_url: 'mcp://vedar/booking', operator_id: opW, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourW, date, participants: 2 },
        skip_ai_processing: true,
      }))!.id;
      const decline = (lead: string, date: string) => answers.recordChatAnswer({
        partnerId: opW, kind: 'lead', subjectId: lead, answer: 'decline', reason: 'weather', expectDate: date,
      });
      const LA = await mk('Вера Погода', '+79995550911', D1);
      const LB = await mk('Глеб Погода', '+79995550912', D2);
      // Не в счёт: отказ «мест нет» на D3 по этому же туру и отказ по погоде на D3 по ДРУГОМУ туру оператора.
      const LS = await mk('Зоя Места', '+79995550913', D3);
      const sS = await answers.recordChatAnswer({ partnerId: opW, kind: 'lead', subjectId: LS, answer: 'decline', reason: 'seats', expectDate: D3 });
      expect(sS).toMatchObject({ ok: true });
      const tourX = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants, is_active, is_published)
         VALUES ('Другой тур 2в', 9000, $1, 12, true, true) RETURNING id`, [opW],
      )).rows[0].id;
      const LX = (await leads.createLeadDetailed({
        name: 'Иван Другой', phone: '+79995550914', comment: `[Заявка на бронь] Тур "Другой тур 2в" (ID${tourX}), дата ${D3}, участников 2.`,
        route_title: 'Другой тур 2в', source_url: 'mcp://vedar/booking', operator_id: opW, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourX, date: D3, participants: 2 },
        skip_ai_processing: true,
      }))!.id;
      expect(await decline(LX, D3)).toMatchObject({ ok: true });
      const kA = await status.issueRequestKeyRecord({ leadId: LA }, 'create_booking_request', { opensChat: true });
      const CW = 9_300_061;
      expect(await links.linkChatToKeys('max', CW, [kA!.key], 'created')).toBe(1);

      // Сначала оператор отказал по погоде другой заявке — на D2; потом этой — на D1.
      expect(await decline(LB, D2)).toMatchObject({ ok: true });
      await pool.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [LB]);
      const sA = await decline(LA, D1);
      expect(sA).toMatchObject({ ok: true, notice: { state: 'pending' } });
      await pool.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [LA]);
      const noticeId = sA.ok && sA.notice ? sA.notice.id : '0';
      // Строка сообщения знает даты, по которым этот оператор уже отказал по погоде на этом туре.
      const facts = (await pool.query<{ weather_refused_dates: string[] }>(notices.NOTICE_FACTS_SQL, [noticeId])).rows[0]!;
      expect([...facts.weather_refused_dates].sort()).toEqual([D1, D2]);
      // Список считается только для отказа по погоде: у «мест нет» его нет вовсе.
      const seatsNotice = sS.ok && sS.notice ? sS.notice.id : '0';
      expect(seatsNotice).not.toBe('0');
      expect((await pool.query<{ weather_refused_dates: string[] | null }>(notices.NOTICE_FACTS_SQL, [seatsNotice])).rows[0]!.weather_refused_dates).toBeNull();

      // Прогноз — подставной (сети в тесте нет): на D1 ветер, дальше спокойно; оценка зоны — подставная
      // «низкая». Тур, главное место и его статус, лента предупреждений, календарь — из базы.
      const fday = (date: string, windKmh: number) => ({ date, tempMax: null, tempMin: null, precipMm: null, windKmh, weatherCode: 3, description: 'облачно' });
      const sources = {
        ...liveSources(),
        forecast: async () => ({ ok: true as const, days: [fday(D1, 95), fday(D2, 10), fday(D3, 12)] }),
        zone: async () => ({ name: 'Авачинско-Петропавловский', level: 'low' as const }),
      };
      sent.dm.length = 0;
      const o = await notices.deliverAnswerNotice(noticeId, {
        checkDates: (tour, declined, candidates, d) => checkTourDates(tour, declined, candidates, { ...d, sources }),
      });
      expect(o).toEqual({ state: 'delivered', via: 'max', dates: [D3], check: 'confirmed' });
      expect(sent.dm).toHaveLength(1);
      expect(String(sent.dm[0]!.chatId)).toBe(String(CW));
      const text = sent.dm[0]!.text;
      expect(text).toContain('По данным Ведара на вашу дату: погода: ветер до 95 км/ч.');
      expect(text).toContain(`на которые Ведар сейчас не нашёл ни опасной погоды в прогнозе, ни предупреждений: ${datesLine([D3], D1)}.`);
      expect(text).toContain('Проверено: прогноз погоды на дату и уже выпущенные официальные предупреждения по главному месту тура («Вилючинский перевал»); статус места и оценка опасности зоны — на сейчас.');
      // D2 — отказ по погоде в другой заявке: в календаре свободна, но не проверяется и не названа —
      // числом, как и D9 вне прогноза. Слов «в календаре дат нет» при свободных датах нет.
      expect(text).toContain('Другие свободные даты рядом не называю: вне прогноза — 1, уже был отказ по погоде или безопасности — 1.');
      expect(text).not.toContain('в календаре тура на год вперёд нет');
      expect(text).not.toContain(datesLine([D2], D1));
      expect(text).not.toContain(datesLine([D9], D1));
      expect(sent.dm[0]!.buttons ?? []).toEqual([]);

      // Статус места стал жёлтым — следующий такой же отказ дат уже не называет.
      await pool.query(`UPDATE location_real_time_status SET recommender_status = 'yellow' WHERE agent_route_id = $1::uuid`, [place.ark]);
      expect(await checkTourDates(tourW, D1, [D3, D9], { sources })).toEqual({ state: 'place_risk', place: 'Вилючинский перевал', level: 'yellow' });
      await pool.query(`DELETE FROM tour_availability WHERE operator_tour_id = $1::bigint`, [tourW]);
    });

    it('другие компании на дату (4а): после «Нет мест» названы компании с турами к тому же месту, которые могут принять в этот день; отбор и порядок — на настоящей схеме', async () => {
      process.env.CALLBACK_SIGNING_SECRET ??= 'pg-test-signing';
      const answers = await import('@/lib/requests/chat-answer');
      const notices = await import('@/lib/requests/answer-notice');
      const { operatorOutcomeLine, ruDay } = await import('@/lib/requests/answer-notice-text');
      const { loadOtherOffers } = await import('@/lib/requests/other-offers');
      const { loadToursOnDate } = await import('@/lib/tours/nearest-free-date');
      const { OFFER_ORDER_NOTE_ON_DATE_RU } = await import('@/lib/tours/offer-order');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const day = (n: number) => {
        const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const [D, DX] = [day(20), day(25)];
      const partner = async (name: string, chat: number | null = null) => (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ($1, 'operator', '{}', $2) RETURNING id`, [name, chat],
      )).rows[0].id;
      const mkPlace = async (name: string) => (await pool.query<{ id: string }>(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES (gen_random_uuid(), $1, 52.9, 158.7, gen_random_uuid(), 'cape', 'avachinsky', TRUE) RETURNING id::text AS id`, [name],
      )).rows[0].id;
      const place = await mkPlace('Мыс 4а <дальний>');
      const elsewhere = await mkPlace('Другое место 4а');
      const tour = async (op: string, title: string, o: { place?: string | null; published?: boolean; max?: number; season?: [string, string] } = {}) => Number((await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants, is_active, is_published, main_place_id, season_start, season_end)
         VALUES ($1, 9000, $2, $3, true, $4, $5, $6::date, $7::date) RETURNING id`,
        [title, op, o.max ?? 12, o.published ?? true, o.place === undefined ? place : o.place, o.season?.[0] ?? null, o.season?.[1] ?? null],
      )).rows[0].id);
      const slot = (t: number, date: string, slots: number, cancelled = false) => pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled) VALUES ($1, $2::date, $3, $4)`, [t, date, slots, cancelled],
      );
      // Отказавшая компания: её второй тур к месту в список не идёт.
      const opA = await partner('Отказавшая 4а', 9300701);
      const tA = await tour(opA, 'Мыс 4а — отказанный');
      const tA2 = await tour(opA, 'Мыс 4а — её второй тур');
      // Берёт по календарю: два тура с местами на двоих и один — с одним местом.
      const opB = await partner('Берёт по календарю & Ко');
      const tB = await tour(opB, 'Мыс 4а на джипах');
      const tB1 = await tour(opB, 'Мыс 4а — одно место');
      const tB2 = await tour(opB, 'Мыс 4а пешком');
      // Календаря нет вовсе — «дату подтверждает оператор».
      const opC = await partner('По заявке 4а');
      const tC = await tour(opC, 'Мыс 4а по заявке');
      // Не подходят: дата другая; дата закрыта; черновик; вне сезона; другое место; группа больше тура.
      const tD = await tour(await partner('Другая дата 4а'), 'Мыс 4а — другая дата');
      const tE = await tour(await partner('Закрыла дату 4а'), 'Мыс 4а — дата закрыта');
      const tF = await tour(await partner('Черновик 4а'), 'Мыс 4а — черновик', { published: false });
      const tG = await tour(await partner('Не сезон 4а'), 'Мыс 4а — летом', { season: [day(60), day(90)] });
      const tH = await tour(await partner('Другое место 4а'), 'Не к мысу', { place: elsewhere });
      const tI = await tour(await partner('Малая группа 4а'), 'Мыс 4а — один гость', { max: 1 });
      for (const t of [tA, tA2, tB, tB2, tF, tH, tI]) await slot(t, D, 10);
      await slot(tB1, D, 1);
      await slot(tD, DX, 10);
      await slot(tE, D, 10, true);

      // Календарь на дату у набора: хватает мест / дата закрыта / даты нет или мест мало.
      const onDate = await loadToursOnDate([tB, tB1, tB2, tC, tD, tE, tF, tI].map(String), D, 2);
      expect(onDate.state).toBe('ok');
      if (onDate.state !== 'ok') throw new Error('календарь на дату не прочитан');
      expect([...onDate.free].sort()).toEqual([tB, tB2].map(String).sort());
      expect([...onDate.closed]).toEqual([String(tE)]);
      // Одному гостю хватает и тура с одним местом, и тура на одного.
      const forOne = await loadToursOnDate([tB1, tI].map(String), D, 1);
      expect(forOne.state === 'ok' ? [...forOne.free].sort() : null).toEqual([tB1, tI].map(String).sort());

      const read = await loadOtherOffers({ tourId: tA, date: D, people: 2 });
      expect(read.state).toBe('ok');
      if (read.state !== 'ok') throw new Error('другие компании не прочитаны');
      expect(read.placeName).toBe('Мыс 4а <дальний>');
      expect(read.more).toBe(0);
      // Компания с местами в календаре — первой, «по заявке» — второй; остальных нет.
      expect(read.offers.map((o) => [o.partnerName, o.seats, o.moreTours])).toEqual([
        ['Берёт по календарю & Ко', 'calendar', 1],
        ['По заявке 4а', 'by_request', 0],
      ]);
      expect([String(tB), String(tB2)]).toContain(read.offers[0]!.tourId);
      expect(read.offers[1]!.tourId).toBe(String(tC));
      expect(read.offers[0]!.url).toMatch(new RegExp(`/catalog/tours/[a-z0-9-]+\\?date=${D}&guests=2#booking$`));
      // Тур без главного места и несуществующий тур — «нет», а не сбой.
      const loose = await tour(opA, 'Без главного места 4а', { place: null });
      expect(await loadOtherOffers({ tourId: loose, date: D, people: 2 })).toEqual({ state: 'none' });
      expect(await loadOtherOffers({ tourId: 999_999_999, date: D, people: 2 })).toEqual({ state: 'none' });
      // Группа больше любого календаря — по календарю никто, остаётся только «по заявке».
      const big = await loadOtherOffers({ tourId: tA, date: D, people: 11 });
      expect(big.state === 'ok' ? big.offers.map((o) => o.partnerName) : null).toEqual(['По заявке 4а']);

      // Заявка на отказанный тур, чат человека привязан; оператор отвечает «Нет мест».
      const lead = (await leads.createLeadDetailed({
        name: 'Нина Четвёртая', phone: '+79995550941', comment: `[Заявка на бронь] Тур "Мыс 4а — отказанный" (ID${tA}), дата ${D}, участников 2.`,
        route_title: 'Мыс 4а — отказанный', source_url: 'mcp://vedar/booking', operator_id: opA, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tA, date: D, participants: 2 },
        skip_ai_processing: true,
      }))!.id;
      const key = await status.issueRequestKeyRecord({ leadId: lead }, 'create_booking_request', { opensChat: true });
      const CHAT = 9_300_071;
      expect(await links.linkChatToKeys('max', CHAT, [key!.key], 'created')).toBe(1);
      const said = await answers.recordChatAnswer({ partnerId: opA, kind: 'lead', subjectId: lead, answer: 'no_seats', expectDate: D });
      expect(said).toMatchObject({ ok: true, notice: { state: 'pending' } });
      sent.dm.length = 0;
      const o = await notices.deliverAnswerNotice(said.ok && said.notice ? said.notice.id : '0');
      expect(o).toMatchObject({ state: 'delivered', via: 'max', offers: 2 });
      expect(sent.dm).toHaveLength(1);
      expect(String(sent.dm[0]!.chatId)).toBe(String(CHAT));
      const lines = sent.dm[0]!.text.split('\n');
      const head = lines.indexOf(`<b>К месту «Мыс 4а &lt;дальний&gt;» на ${ruDay(D)} — другие компании</b>`);
      expect(head).toBeGreaterThan(0);
      expect(lines[head + 1]).toMatch(/^1\. «Берёт по календарю &amp; Ко» — тур «Мыс 4а (на джипах|пешком)», 9[\s ]000 ₽ [^;]+; в календаре на эту дату места на 2 чел\. есть; у компании к этому месту ещё 1 тур\. Заявка: https?:\/\/\S+#booking$/);
      expect(lines[head + 2]).toMatch(/^2\. «По заявке 4а» — тур «Мыс 4а по заявке», 9[\s ]000 ₽ [^;]+; расписания на Ведаре нет — дату подтверждает оператор\. Заявка: https?:\/\/\S+#booking$/);
      expect(lines[head + 3]).toContain('Это не ответ этих компаний');
      expect(lines[head + 4]).toBe(OFFER_ORDER_NOTE_ON_DATE_RU);
      // Ни отказавшей компании в списке, ни неподходящих туров, ни имени и телефона человека.
      const block = lines.slice(head, head + 5).join('\n');
      expect(block).not.toMatch(/Отказавшая|её второй тур|одно место|другая дата|дата закрыта|черновик|летом|Не к мысу|один гость/);
      expect(sent.dm[0]!.text).not.toMatch(/Нина|79995550941/);
      expect(operatorOutcomeLine(o)).toContain('Ещё туристу названы 2 другие компании с турами к этому месту на эту дату');

      // Статус той же заявки (4а-2): ИИ-агент и страница заявки читают тех же компаний тем же порядком.
      const view = await status.readRequestStatus(key!.key, { reader: 'agent' });
      expect(view.state).toBe('declined');
      expect(view.other_offers).toMatchObject({ state: 'listed', place: 'Мыс 4а <дальний>', date: D, participants: 2, more_companies: 0 });
      expect(view.other_offers!.offers.map((x) => [x.company, x.seats, x.more_tours])).toEqual([
        ['Берёт по календарю & Ко', 'calendar', 1],
        ['По заявке 4а', 'by_request', 0],
      ]);
      expect([String(tB), String(tB2)]).toContain(view.other_offers!.offers[0]!.tour_id);
      expect(view.other_offers!.offers[1]!.tour_id).toBe(String(tC));
      expect(view.other_offers!.offers[0]!.url).toMatch(new RegExp(`\\?date=${D}&guests=2#booking$`));
      expect(view.other_offers!.how).toContain('create_booking_request');
      expect(JSON.stringify(view.other_offers)).not.toMatch(/Нина|79995550941|Отказавшая/);
      // Страница заявки — тот же список, без слов для агента.
      const { pageOtherOffers } = await import('@/lib/requests/other-offers-status');
      expect(pageOtherOffers((await status.readRequestStatus(key!.key, { reader: 'page', seen: true })).other_offers))
        .toEqual((({ how: _how, ...rest }) => rest)(view.other_offers!));

      // Отказ по погоде на той же схеме: других компаний к тому же месту в тот же день не называем.
      const lead2 = (await leads.createLeadDetailed({
        name: 'Олег Четвёртый', phone: '+79995550942', comment: `[Заявка на бронь] Тур "Мыс 4а — её второй тур" (ID${tA2}), дата ${D}, участников 2.`,
        route_title: 'Мыс 4а — её второй тур', source_url: 'mcp://vedar/booking', operator_id: opA, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tA2, date: D, participants: 2 },
        skip_ai_processing: true,
      }))!.id;
      const key2 = await status.issueRequestKeyRecord({ leadId: lead2 }, 'create_booking_request', { opensChat: true });
      expect(await links.linkChatToKeys('max', 9_300_072, [key2!.key], 'created')).toBe(1);
      const said2 = await answers.recordChatAnswer({ partnerId: opA, kind: 'lead', subjectId: lead2, answer: 'decline', reason: 'weather', expectDate: D });
      expect(said2).toMatchObject({ ok: true, notice: { state: 'pending' } });
      await pool.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [lead2]);
      sent.dm.length = 0;
      const o2 = await notices.deliverAnswerNotice(said2.ok && said2.notice ? said2.notice.id : '0', {
        checkDates: async () => ({ state: 'unchecked', why: ['timeout'] }),
      });
      expect(o2).toMatchObject({ state: 'delivered', via: 'max' });
      expect(o2).not.toHaveProperty('offers');
      expect(sent.dm[0]!.text).not.toContain('другие компании');
      // И в статусе этой заявки списка нет: после отказа по погоде замену проверяют, а не перечисляют.
      const view2 = await status.readRequestStatus(key2!.key, { reader: 'agent' });
      expect(view2.state).toBe('declined');
      expect(view2.other_offers).toBeNull();

      await pool.query(`DELETE FROM tour_availability WHERE operator_tour_id = ANY($1::bigint[])`, [[tA, tA2, tB, tB1, tB2, tD, tE, tF, tH, tI]]);
    });

    it('сообщение после ответа (2б, 1424): одно на ответ, в чат заявки, иначе менеджеру; прочли — «звонить не нужно»', async () => {
      process.env.CALLBACK_SIGNING_SECRET ??= 'pg-test-signing';
      const answers = await import('@/lib/requests/chat-answer');
      const notices = await import('@/lib/requests/answer-notice');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const day = (n: number) => {
        const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      // D5 — ближе всех к сегодняшнему дню, но дальше всех от даты заявки.
      const [D0, Dm1, D2, D9, D5] = [day(30), day(29), day(32), day(39), day(5)];
      const opId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ('Оператор 2б', 'operator', '{}', 9300399) RETURNING id`,
      )).rows[0].id;
      const tourId = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants, is_active, is_published)
         VALUES ('Толбачик', 9000, $1, 12, true, true) RETURNING id`, [opId],
      )).rows[0].id;
      // Рядом с D0: D-1 и D+2 ближе, чем D+9; сама D0 и отменённая — не предлагаются.
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled) VALUES
           ($1, $2::date, 10, false), ($1, $3::date, 5, false), ($1, $4::date, 6, false), ($1, $5::date, 6, false),
           ($1, $6::date, 6, false)`,
        [tourId, D0, Dm1, D2, D9, D5],
      );
      const mkLead = async (name: string, phone: string) => (await leads.createLeadDetailed({
        name, phone, comment: `[Заявка на бронь] Тур "Толбачик" (ID${tourId}), дата ${D0}, участников 2.`,
        route_title: 'Толбачик', source_url: 'mcp://vedar/booking', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourId, date: D0, participants: 2 },
        skip_ai_processing: true,
      }))!.id;
      const answer = (lead: string, a: 'no_seats' | 'decline' | 'accept', partnerId = opId) => answers.recordChatAnswer({
        partnerId, kind: 'lead', subjectId: lead, answer: a, reason: a === 'decline' ? 'seats' : null, expectDate: D0,
      });
      const noticeOf = async (lead: string) => (await pool.query(
        `SELECT state, skipped_reason, delivered_via, tried, manager_channel, (manager_alerted_at IS NOT NULL) AS alerted,
                (manager_cleared_at IS NOT NULL) AS cleared FROM answer_notices WHERE lead_id = $1::uuid ORDER BY id`, [lead],
      )).rows;

      // 1. Заявка из чата Кузьмича: ответ «Нет мест» — сообщение в этот чат, с датами рядом кнопками.
      const L1 = await mkLead('Анна Чат', '+79995550801');
      const k1 = await status.issueRequestKeyRecord({ leadId: L1 }, 'create_booking_request', { opensChat: true });
      const C1 = 9_300_051;
      expect(await links.linkChatToKeys('max', C1, [k1!.key], 'created')).toBe(1);
      // Чат с ключом ПОВТОРА той же заявки сообщения не получает.
      const rep = await status.issueRequestKeyRecord({ leadId: L1 }, 'create_booking_request', { opensChat: false });
      expect(await links.linkChatToKeys('max', 9_300_052, [rep!.key], 'created')).toBe(1);
      // Даты рядом — ближайшие к дате заявки, а не к сегодняшнему дню; сама дата и исключённые — нет.
      const { loadFreeDatesNear } = await import('@/lib/tours/nearest-free-date');
      expect(await loadFreeDatesNear(tourId, 2, D0, [D0], 2)).toMatchObject({ state: 'ok', dates: [{ date: Dm1 }, { date: D2 }] });
      expect(await loadFreeDatesNear(tourId, 2, D0, [D0, Dm1, 'не дата'], 1)).toMatchObject({ dates: [{ date: D2 }] });
      await pool.query(`UPDATE operator_tours SET is_published = false WHERE id = $1`, [tourId]);
      expect(await loadFreeDatesNear(tourId, 2, D0, [D0], 4)).toMatchObject({ state: 'ok', dates: [] });
      await pool.query(`UPDATE operator_tours SET is_published = true WHERE id = $1`, [tourId]);
      const targets = (await pool.query(notices.NOTICE_TARGETS_SQL, [L1])).rows;
      expect(targets).toEqual([{ channel: 'max', chat_id: String(C1), can_pick: true }]);

      const s1 = await answer(L1, 'no_seats');
      expect(s1).toMatchObject({ ok: true, already: false, notice: { state: 'pending' } });
      // Повтор нажатия: ответ «уже», второй строки сообщения нет.
      expect(await answer(L1, 'no_seats')).toMatchObject({ already: true });
      expect(await noticeOf(L1)).toHaveLength(1);
      sent.dm.length = 0;
      sent.pd.length = 0;
      const o1 = await notices.deliverAnswerNotice(s1.ok && s1.notice ? s1.notice.id : '0');
      // Четыре ближайшие к дате заявки (по возрастанию): D5 — четвёртая по близости, всё ещё в списке.
      expect(o1).toEqual({ state: 'delivered', via: 'max', dates: [D5, Dm1, D2, D9] });
      expect(sent.dm).toHaveLength(1);
      expect(String(sent.dm[0]!.chatId)).toBe(String(C1));
      expect(sent.dm[0]!.text).toContain('Оператор «Оператор 2б» ответил: на эту дату мест нет.');
      expect(sent.dm[0]!.text).not.toMatch(/Анна|79995550801/);
      expect((sent.dm[0]!.buttons ?? []).length).toBe(5); // четыре даты и «Другие даты»
      expect(sent.pd).toHaveLength(0);
      expect(await noticeOf(L1)).toEqual([expect.objectContaining({ state: 'delivered', delivered_via: 'max' })]);
      // Повторная доставка той же строки ничего не шлёт.
      await notices.deliverAnswerNotice(s1.ok && s1.notice ? s1.notice.id : '0');
      expect(sent.dm).toHaveLength(1);
      // Исход по ответу — для повторного нажатия оператора.
      expect(await notices.readNoticeOutcomeFor(L1, opId, D0)).toMatchObject({ state: 'delivered', via: 'max' });

      // 2. Заявка без чата и без агента: «Отказать» — не доставлено, менеджеру с телефоном сразу.
      const L2 = await mkLead('Борис Безчата', '+79995550802');
      const k2 = await status.issueRequestKeyRecord({ leadId: L2 }, 'create_booking_request', { opensChat: true });
      await pool.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [L2]); // как после «Отказать» (changeLeadStatus)
      // Отказ на уже закрытой заявке — «пропущено»: туристу «оператор отказал» по закрытой не уходит.
      const L3 = await mkLead('Вера Закрыто', '+79995550803');
      await pool.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [L3]);
      expect(await answer(L3, 'decline')).toMatchObject({ notice: { state: 'skipped', skipped: 'lead_closed' } });
      // Ответ не адресата — «пропущено».
      const otherOp = (await pool.query<{ id: string }>(`INSERT INTO partners (name, category, contact) VALUES ('Чужой 2б', 'operator', '{}') RETURNING id`)).rows[0].id;
      const L4 = await mkLead('Глеб Чужой', '+79995550804');
      expect(await answer(L4, 'no_seats', otherOp)).toMatchObject({ notice: { state: 'skipped', skipped: 'not_addressee' } });
      // «Подтвердить» — не из тех ответов, о которых сообщаем.
      const L5 = await mkLead('Дина Да', '+79995550805');
      expect(await answer(L5, 'accept')).toMatchObject({ notice: null });

      await pool.query(`UPDATE leads SET status = 'new' WHERE id = $1`, [L2]);
      const s2 = await answer(L2, 'decline');
      await pool.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [L2]);
      sent.dm.length = 0;
      sent.pd.length = 0;
      const o2 = await notices.deliverAnswerNotice(s2.ok && s2.notice ? s2.notice.id : '0');
      // Подписки агента у заявки с формы нет — и в исходе об агенте ни слова неправды (ревью 2б).
      expect(o2).toEqual({ state: 'undelivered', manager: 'max', why: { broken: false, chat: 'none', agent: 'none' } });
      expect(sent.dm).toHaveLength(0);
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.to).toBeUndefined();
      expect(sent.pd[0]!.text).toContain('+79995550802');
      expect(sent.pd[0]!.stub).not.toMatch(/Борис|79995550802/);
      expect(await noticeOf(L2)).toEqual([expect.objectContaining({ state: 'undelivered', manager_channel: 'max', alerted: true, cleared: false })]);

      // 3. Агент прочитал статус по ключу новой заявки — доставлено; добивка пишет менеджеру «звонить не нужно» один раз.
      await status.readRequestStatus(k2!.key, { reader: 'agent' });
      expect(await noticeOf(L2)).toEqual([expect.objectContaining({ state: 'delivered', delivered_via: 'agent_read' })]);
      sent.pd.length = 0;
      const run = await notices.runAnswerNotices();
      expect(run.status).toBe('ok');
      expect(run.manager_cleared).toBeGreaterThanOrEqual(1);
      expect(sent.pd.filter((p) => p.text.includes('звонить не нужно'))).toHaveLength(1);
      expect(sent.pd.every((p) => !/Борис|79995550802/.test(p.text))).toBe(true);
      expect(await noticeOf(L2)).toEqual([expect.objectContaining({ cleared: true })]);
      sent.pd.length = 0;
      await notices.runAnswerNotices();
      expect(sent.pd.filter((p) => p.text.includes(L2))).toHaveLength(0);

      // Чтение ключом повтора доставкой не считается; страница — только на виду.
      const L6 = await mkLead('Ева Страница', '+79995550806');
      const k6 = await status.issueRequestKeyRecord({ leadId: L6 }, 'create_booking_request', { opensChat: true });
      const k6rep = await status.issueRequestKeyRecord({ leadId: L6 }, 'create_booking_request', { opensChat: false });
      await answer(L6, 'no_seats');
      await status.readRequestStatus(k6rep!.key, { reader: 'agent' });
      await status.readRequestStatus(k6!.key, { reader: 'page', seen: false });
      expect(await noticeOf(L6)).toEqual([expect.objectContaining({ state: 'pending' })]);
      await status.readRequestStatus(k6!.key, { reader: 'page', seen: true });
      expect(await noticeOf(L6)).toEqual([expect.objectContaining({ state: 'delivered', delivered_via: 'page_seen' })]);

      // 4. Сторож застрявшего (ревью 2б: прежняя проверка была пустой) — окно сутки, два рода.
      const L7 = await mkLead('Жанна Обрыв', '+79995550807'); // «ждёт», захват истёк час назад
      const L8 = await mkLead('Захар Безписьма', '+79995550808'); // «не доставлено», менеджеру не ушло
      const L9 = await mkLead('Ия Заглушка', '+79995550809'); // «не доставлено», заглушка менеджеру ушла
      const L10 = await mkLead('Кира Свежая', '+79995550810'); // «ждёт», захват свежий
      const L11 = await mkLead('Лев Позже', '+79995550811'); // дошло после письма, «звонить не нужно» не ушло
      const L12 = await mkLead('Мила Старая', '+79995550812'); // «ждёт», но строке двое суток
      const L13 = await mkLead('Нина Сбой', '+79995550813'); // «ждёт» после двух обрывов — третий разбор уходит менеджеру
      for (const L of [L7, L8, L9, L10, L11, L12, L13]) expect(await answer(L, 'no_seats')).toMatchObject({ notice: { state: 'pending' } });
      const setNotice = (L: string, set: string) => pool.query(`UPDATE answer_notices SET ${set} WHERE lead_id = $1::uuid`, [L]);
      await setNotice(L7, `claimed_until = NOW() - INTERVAL '1 hour'`);
      await setNotice(L8, `state = 'undelivered', tried = 'max:bad_id', manager_channel = 'none', decided_at = NOW() - INTERVAL '1 hour', claimed_until = NULL`);
      await setNotice(L9, `state = 'undelivered', tried = 'max:bad_id', manager_channel = 'telegram-stub',
                           manager_alerted_at = NOW() - INTERVAL '1 hour', decided_at = NOW() - INTERVAL '1 hour', claimed_until = NULL`);
      await setNotice(L11, `state = 'delivered', delivered_via = 'agent_read', delivered_at = NOW() - INTERVAL '1 hour', manager_channel = 'max',
                            manager_alerted_at = NOW() - INTERVAL '2 hours', decided_at = NOW() - INTERVAL '2 hours', claimed_until = NULL`);
      await setNotice(L12, `created_at = NOW() - INTERVAL '2 days', claimed_until = NOW() - INTERVAL '1 hour'`);
      await setNotice(L13, `attempts = 2, claimed_until = NOW() - INTERVAL '1 hour'`);
      // «Дошло» без времени доставки — нарушение CHECK: сторож «звонить не нужно» опирается на delivered_at.
      await expect(setNotice(L10, `state = 'delivered', delivered_via = 'page_seen'`)).rejects.toMatchObject({ code: '23514' });
      const short = (L: string) => L.slice(0, 8);
      const stuckNow = async () => {
        const s = (await pool.query(notices.NOTICE_STUCK_SQL)).rows[0] as { count: string; ids: string | null; uncleared: string; uncleared_ids: string | null };
        return { s, ids: (s.ids ?? '').split(','), unc: (s.uncleared_ids ?? '').split(',') };
      };
      const before = await stuckNow();
      expect(before.ids).toEqual(expect.arrayContaining([short(L7), short(L8)]));
      for (const L of [L9, L10, L11, L12]) expect(before.ids).not.toContain(short(L));
      expect(before.unc).toContain(short(L11));
      for (const L of [L7, L8, L9, L10, L12]) expect(before.unc).not.toContain(short(L));
      expect(Number(before.s.count)).toBeGreaterThanOrEqual(2);

      // Добивка. L8 переросла ответ, пока письмо ждало повтора (заявка стала сделкой) — письма с прежним отказом нет.
      await pool.query(`UPDATE leads SET status = 'converted' WHERE id = $1`, [L8]);
      sent.pd.length = 0;
      const run2 = await notices.runAnswerNotices();
      expect(run2.status).toBe('ok');
      // L7: ждущее с истёкшим захватом взято; попытка записана при разборе; чатов и агента нет — менеджеру с телефоном.
      expect(await noticeOf(L7)).toEqual([expect.objectContaining({ state: 'undelivered', manager_channel: 'max', alerted: true })]);
      expect((await pool.query(`SELECT attempts FROM answer_notices WHERE lead_id = $1::uuid`, [L7])).rows[0].attempts).toBe(1);
      expect(sent.pd.some((p) => p.text.includes('79995550807'))).toBe(true);
      expect(await noticeOf(L8)).toEqual([expect.objectContaining({ state: 'undelivered', manager_channel: 'not_needed', alerted: false })]);
      expect(sent.pd.some((p) => p.text.includes('79995550808'))).toBe(false);
      // L9 (заглушка ушла) добивка не трогает; L11 — «звонить не нужно» один раз.
      expect(sent.pd.some((p) => p.text.includes('79995550809'))).toBe(false);
      expect(await noticeOf(L11)).toEqual([expect.objectContaining({ cleared: true })]);
      // L13: третий разбор — человеку больше не шлём; код в «куда пробовали» проходит CHECK, менеджеру — «неизвестно».
      expect(await noticeOf(L13)).toEqual([expect.objectContaining({ state: 'undelivered', tried: 'retry_exhausted', manager_channel: 'max' })]);
      const l13 = sent.pd.find((p) => p.text.includes('79995550813'));
      expect(l13?.text).toContain('отправка несколько раз обрывалась сбоем — дошло ли что-то до человека, неизвестно');
      expect(sent.dm.some((m) => String(m.text).includes('Нина'))).toBe(false);
      const after = await stuckNow();
      for (const L of [L7, L8, L11, L13]) expect([...after.ids, ...after.unc]).not.toContain(short(L));

      // Отложенное по сроку прогона — назад в очередь без потраченной попытки.
      const n10 = (await pool.query<{ id: string }>(`SELECT id::text AS id FROM answer_notices WHERE lead_id = $1::uuid`, [L10])).rows[0]!.id;
      await pool.query(notices.NOTICE_RELEASE_SQL, [[n10]]);
      expect((await pool.query(`SELECT claimed_until, attempts FROM answer_notices WHERE id = $1::bigint`, [n10])).rows[0])
        .toEqual({ claimed_until: null, attempts: 0 });

      await pool.query(`DELETE FROM tour_availability WHERE operator_tour_id = $1::bigint`, [tourId]);
    });

    it('change_request (12.11): право — у ключа новой заявки на тур; правило, журнал и лимит — те же, что у кнопок', async () => {
      const { changeRequest, CHANGE_CANCEL_LEAD_SQL, CHANGE_DATE_LEAD_SQL } = await import('@/lib/mcp/change-request');
      const { McpUserError } = await import('@/lib/mcp/jsonrpc');
      const { MY_TRIP_DATE_REQUEST_LOG_SQL } = await import('@/lib/requests/my-trip-date');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const day = (n: number) => {
        const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const [D0, D1, D2, D3, D4] = [day(10), day(12), day(14), day(16), day(18)];
      const opId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, slug, max_chat_id) VALUES ('Оператор ключа', 'operator', '{}', 'op-change-key', 9300399) RETURNING id`,
      )).rows[0].id;
      const tourId = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants) VALUES ('Толбачик по ключу', 9000, $1, 12) RETURNING id`, [opId],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled)
         SELECT $1, d::date, 10, false FROM unnest($2::text[]) AS d`, [tourId, [D0, D1, D2, D3, D4]],
      );
      const mk = async (name: string, phone: string, extra: Record<string, unknown> = {}) => (await leads.createLeadDetailed({
        name, phone, comment: `[Заявка на бронь] Тур "Толбачик по ключу" (ID${tourId}), дата ${D0}, участников 2.`,
        route_title: 'Толбачик по ключу', source_url: 'mcp://vedar/booking', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourId, date: D0, participants: 2 },
        skip_ai_processing: true, ...extra,
      }))!;
      const codeOf = async (p: Promise<unknown>) => {
        const e = await p.then(() => null, (x: unknown) => x);
        expect(e).toBeInstanceOf(McpUserError);
        return (e as InstanceType<typeof McpUserError>).code;
      };
      const stateOf = async (lead: string) => (await pool.query<{ status: string; date: string }>(
        `SELECT status, source_data->>'date' AS date FROM leads WHERE id = $1`, [lead],
      )).rows[0]!;
      const journal = async (lead: string) => (await pool.query(
        `SELECT action, details FROM lead_activity_log
          WHERE lead_id = $1 AND action IN ('client_cancelled', 'cancel_requested', 'date_changed', 'date_change_requested') ORDER BY id`, [lead],
      )).rows;
      const rightRows = async (sql: string, k: string) => (await pool.query(sql, [status.requestKeyHash(k)])).rows.length;

      // ── 1. Право — в самом чтении заявки ─────────────────────────────────
      const L1 = await mk('Кира Ключ', '+79995550701');
      const fresh = (await status.issueRequestKeyRecord({ leadId: L1.id }, 'create_booking_request', { opensChat: true }))!;
      const repeat = (await status.issueRequestKeyRecord({ leadId: L1.id }, 'create_booking_request', { opensChat: false }))!;
      const expired = (await status.issueRequestKeyRecord({ leadId: L1.id }, 'create_booking_request', { opensChat: true }))!;
      await pool.query(`UPDATE agent_request_keys SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [expired.keyId]);
      // Своя проба владельца с ключом переписки в жизни не выдаётся — право обязано держать и её.
      const mine = await mk('Своя Проба', '+79995550709', { is_self: true });
      const self = (await status.issueRequestKeyRecord({ leadId: mine.id }, 'create_booking_request', { opensChat: true }))!;
      // Ключ другого инструмента с правом переписки (так выдаёт заявка на машину) — не заявка на тур.
      const charter = (await status.issueRequestKeyRecord({ leadId: L1.id }, 'request_charter', { opensChat: true }))!;
      for (const sql of [CHANGE_CANCEL_LEAD_SQL, CHANGE_DATE_LEAD_SQL]) {
        expect(await rightRows(sql, fresh.key)).toBe(1);
        expect(await rightRows(sql, repeat.key)).toBe(0);
        expect(await rightRows(sql, expired.key)).toBe(0);
        expect(await rightRows(sql, self.key)).toBe(0);
        expect(await rightRows(sql, charter.key)).toBe(0);
        // Ключ заявки на подбор (внешний `key`) — тоже.
        expect(await rightRows(sql, key)).toBe(0);
      }
      // Перенос требует адресата, отмена — нет: заявку без оператора по ключу отменить можно, перенести — нет.
      const lone = await mk('Нина Безадресная', '+79995550708');
      const loneKey = (await status.issueRequestKeyRecord({ leadId: lone.id }, 'create_booking_request', { opensChat: true }))!;
      await pool.query(`UPDATE leads SET operator_id = NULL WHERE id = $1`, [lone.id]);
      expect(await rightRows(CHANGE_CANCEL_LEAD_SQL, loneKey.key)).toBe(1);
      expect(await rightRows(CHANGE_DATE_LEAD_SQL, loneKey.key)).toBe(0);
      expect(await codeOf(changeRequest({ key: loneKey.key, action: 'change_date', date: D1 }, 'mcp'))).toBe('no_addressee');
      expect(await codeOf(changeRequest({ key: charter.key, action: 'cancel' }, 'mcp'))).toBe('not_supported');
      sent.pd.length = 0;
      expect(await codeOf(changeRequest({ key: repeat.key, action: 'cancel' }, 'mcp'))).toBe('status_only_key');
      expect(await codeOf(changeRequest({ key: repeat.key, action: 'cancel', test: true }, 'mcp'))).toBe('status_only_key');
      expect(await codeOf(changeRequest({ key: self.key, action: 'cancel' }, 'mcp'))).toBe('status_only_key');
      expect(await codeOf(changeRequest({ key: expired.key, action: 'cancel' }, 'mcp'))).toBe('key_not_found');
      expect(await codeOf(changeRequest({ key: 'A'.repeat(32), action: 'change_date', date: D1 }, 'mcp'))).toBe('key_not_found');
      expect(await codeOf(changeRequest({ key, action: 'cancel' }, 'mcp'))).toBe('not_supported');
      expect(await stateOf(L1.id)).toEqual({ status: 'new', date: D0 });
      expect(await stateOf(mine.id)).toEqual({ status: 'new', date: D0 });

      // ── 2. Проба: что произошло бы — и ни записи, ни сообщения ───────────
      const dry = await changeRequest({ key: fresh.key, action: 'cancel', test: true }, 'mcp');
      expect(dry).toMatchObject({ outcome: 'would_cancel', changed: false, test: true, told: null, date: D0 });
      const dryDate = await changeRequest({ key: fresh.key, action: 'change_date', date: D1, test: true }, 'mcp');
      expect(dryDate).toMatchObject({ outcome: 'would_change_date', changed: false, test: true, date: D0 });
      expect(await stateOf(L1.id)).toEqual({ status: 'new', date: D0 });
      expect(await journal(L1.id)).toEqual([]);
      expect(sent.pd).toHaveLength(0);

      // ── 3. Перенос до ответа оператора — сразу ───────────────────────────
      const moved = await changeRequest({ key: fresh.key, action: 'change_date', date: D1 }, 'mcp');
      expect(moved).toMatchObject({ action: 'change_date', outcome: 'date_changed', changed: true, test: false, told: 'operator', date: D1 });
      expect(await stateOf(L1.id)).toEqual({ status: 'new', date: D1 });
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.text).toContain('Турист перенёс заявку на другую дату');
      expect(sent.pd[0]!.text).toContain('Передал ИИ-агент туриста по ключу заявки.');
      expect(sent.pd[0]!.text).not.toMatch(/Кира|79995550701/);
      expect(await journal(L1.id)).toEqual([
        { action: 'date_changed', details: { from: D0, to: D1, channel: 'mcp', delivery: 'max' } },
      ]);
      // Статус по тому же ключу видит новую дату.
      expect(await status.readRequestStatus(fresh.key)).toMatchObject({ requested_date: D1 });
      // Дня без выезда в календаре нет — ничего не меняется.
      expect(await changeRequest({ key: fresh.key, action: 'change_date', date: day(11) }, 'mcp'))
        .toMatchObject({ outcome: 'no_seats', changed: false, date: D1 });

      // ── 4. Оператор ответил — просьба; лимит за сутки держит сам запрос ──
      await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [L1.id]);
      sent.pd.length = 0;
      const asked = await changeRequest({ key: fresh.key, action: 'change_date', date: D2 }, 'a2a');
      expect(asked).toMatchObject({ outcome: 'date_change_requested', changed: false, told: 'operator', date: D1 });
      expect(await stateOf(L1.id)).toEqual({ status: 'contacted', date: D1 });
      expect(sent.pd[0]!.text).toContain('Турист просит перенести заявку');
      expect(sent.pd[0]!.text).toContain('Передал ИИ-агент туриста по ключу заявки.');
      expect((await journal(L1.id))[1]).toEqual(
        { action: 'date_change_requested', details: { from: D1, to: D2, channel: 'a2a', delivery: 'max' } },
      );
      // Третье действие за сутки проходит, четвёртое — нет, и оператору не уходит ничего.
      expect(await changeRequest({ key: fresh.key, action: 'change_date', date: D3 }, 'mcp')).toMatchObject({ outcome: 'date_change_requested' });
      sent.pd.length = 0;
      expect(await changeRequest({ key: fresh.key, action: 'change_date', date: D4 }, 'mcp')).toMatchObject({ outcome: 'daily_limit', changed: false, date: D1 });
      expect(await changeRequest({ key: fresh.key, action: 'change_date', date: D4, test: true }, 'mcp')).toMatchObject({ outcome: 'daily_limit', test: true });
      expect(sent.pd).toHaveLength(0);
      // Вызов, прошедший чтение «до лимита» (параллельный), запись всё равно не сделает: условие — в запросе.
      expect((await pool.query(MY_TRIP_DATE_REQUEST_LOG_SQL, [L1.id, D1, D4, 'mcp'])).rows).toEqual([]);
      expect(await journal(L1.id)).toHaveLength(3);

      // ── 5. Отмена после ответа — просьба, заявка в силе; повтор не дублирует ─
      sent.pd.length = 0;
      const wouldAsk = await changeRequest({ key: fresh.key, action: 'cancel', test: true }, 'mcp');
      expect(wouldAsk).toMatchObject({ outcome: 'would_request_cancel', changed: false, test: true });
      expect(sent.pd).toHaveLength(0);
      const cancelAsked = await changeRequest({ key: fresh.key, action: 'cancel' }, 'mcp');
      expect(cancelAsked).toMatchObject({ outcome: 'cancel_requested', changed: false, told: 'operator', date: D1 });
      expect((await stateOf(L1.id)).status).toBe('contacted');
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.text).toContain('Турист просит отменить заявку');
      expect(sent.pd[0]!.text).toContain('Просьбу передал ИИ-агент туриста по ключу заявки.');
      expect(await changeRequest({ key: fresh.key, action: 'cancel' }, 'a2a')).toMatchObject({ outcome: 'cancel_already_requested', changed: false, told: 'operator' });
      expect(sent.pd).toHaveLength(1);

      // ── 6. Отмена до ответа — сразу и навсегда ───────────────────────────
      const L2 = await mk('Лев Ключ', '+79995550702');
      const k2 = (await status.issueRequestKeyRecord({ leadId: L2.id }, 'create_booking_request', { opensChat: true }))!;
      sent.pd.length = 0;
      const done = await changeRequest({ key: k2.key, action: 'cancel' }, 'a2a');
      expect(done).toMatchObject({ action: 'cancel', outcome: 'cancelled', changed: true, test: false, told: 'operator', date: D0 });
      expect((await stateOf(L2.id)).status).toBe('cancelled');
      expect(sent.pd).toHaveLength(1);
      expect(sent.pd[0]!.text).toContain('Отмену передал ИИ-агент туриста по ключу заявки, пока вы не ответили.');
      expect(sent.pd[0]!.text).not.toContain('в чате Ведара');
      expect(await journal(L2.id)).toEqual([
        { action: 'client_cancelled', details: { channel: 'a2a', from: 'new', delivery: 'max', manager: 'not_needed' } },
      ]);
      expect(await status.readRequestStatus(k2.key)).toMatchObject({ state: 'cancelled', human: 'Заявка отменена клиентом.' });
      sent.pd.length = 0;
      expect(await changeRequest({ key: k2.key, action: 'cancel' }, 'mcp')).toMatchObject({ outcome: 'already_cancelled', changed: false });
      expect(await changeRequest({ key: k2.key, action: 'change_date', date: D1 }, 'mcp')).toMatchObject({ outcome: 'closed', changed: false });
      expect(sent.pd).toHaveLength(0);

      // Агенту — без ключа и без номера заявки (номер — оракул, ключ — второй ключ от заявки).
      for (const r of [dry, dryDate, moved, asked, wouldAsk, cancelAsked, done]) {
        const flat = JSON.stringify(r);
        for (const secret of [fresh.key, k2.key, L1.id, L2.id, opId]) expect(flat).not.toContain(secret);
      }
    });

    it('«Отказ» с причиной из кабинета (этап 3а): причина, журнал и сообщение человеку — одной командой; смена статуса причину стирает', async () => {
      const { changeLeadStatus } = await import('@/lib/leads/owner-lead-status');
      const answers = await import('@/lib/requests/chat-answer');
      const notices = await import('@/lib/requests/answer-notice');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const day = (n: number) => {
        const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const [D0, D1] = [day(20), day(22)];
      const opId = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, slug) VALUES ('Оператор 3а', 'operator', '{}', 'op-3a') RETURNING id`,
      )).rows[0].id;
      const otherOp = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, slug) VALUES ('Сосед 3а', 'operator', '{}', 'op-3a-other') RETURNING id`,
      )).rows[0].id;
      const tourId = (await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants) VALUES ('Мутновский 3а', 9000, $1, 12) RETURNING id`, [opId],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled)
         SELECT $1, d::date, 10, false FROM unnest($2::text[]) AS d`, [tourId, [D0, D1]],
      );
      const mk = async (name: string, phone: string, extra: Record<string, unknown> = {}) => (await leads.createLeadDetailed({
        name, phone, comment: `[Заявка на бронь] Тур "Мутновский 3а" (ID${tourId}), дата ${D0}, участников 2.`,
        route_title: 'Мутновский 3а', source_url: 'mcp://vedar/booking', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourId, date: D0, participants: 2 },
        skip_ai_processing: true, ...extra,
      }))!.id;
      const owner = { kind: 'owner' as const, partnerId: opId, claimUnowned: true };
      const close = (lead: string, reason: Parameters<typeof changeLeadStatus>[0]['lost'] extends infer L ? L extends { reason: infer R } ? R : never : never, scope = owner) =>
        changeLeadStatus({
          leadId: lead, status: 'lost', actor: { kind: 'partner_user', userId: null }, scope, via: 'site',
          lost: { reason, partnerId: scope.partnerId },
        });
      const set = (lead: string, st: 'contacted' | 'lost' | 'qualified') => changeLeadStatus({
        leadId: lead, status: st, actor: { kind: 'partner_user', userId: null }, scope: owner, via: 'site',
      });
      const leadOf = async (lead: string) => (await pool.query<{ status: string; lost_reason: string | null; operator_id: string | null }>(
        `SELECT status, lost_reason, operator_id::text AS operator_id FROM leads WHERE id = $1`, [lead],
      )).rows[0]!;
      const closings = async (lead: string) => (await pool.query<{ id: string; actor: string; details: Record<string, unknown> }>(
        `SELECT id::text AS id, actor, details FROM lead_activity_log WHERE lead_id = $1 AND action = 'seller_closed' ORDER BY id`, [lead],
      )).rows;
      const noticesOf = async (lead: string) => (await pool.query<{
        id: string; activity_id: string | null; answer_id: string | null; answer: string; decline_reason: string | null;
        lead_status_before: string | null; state: string; skipped_reason: string | null; held: boolean; delivered_via: string | null;
      }>(
        `SELECT id::text AS id, activity_id::text AS activity_id, answer_id::text AS answer_id, answer, decline_reason, lead_status_before,
                state, skipped_reason, (claimed_until > NOW()) AS held, delivered_via
           FROM answer_notices WHERE lead_id = $1::uuid ORDER BY id`, [lead],
      )).rows;
      const viewOf = async (k: string) => status.readRequestStatus(k, { reader: 'agent' });

      // ── 1. Прежний вызов без причины работает как раньше ─────────────────
      const L1 = await mk('Зоя Закрытие', '+79995550901');
      const k1 = (await status.issueRequestKeyRecord({ leadId: L1 }, 'create_booking_request', { opensChat: true }))!;
      const C1 = 9_300_071;
      expect(await links.linkChatToKeys('max', C1, [k1.key], 'created')).toBe(1);
      const first = await set(L1, 'contacted');
      expect(first).toMatchObject({ kind: 'ok', changed: true, prevStatus: 'new' });
      expect(first.kind === 'ok' && first.closed).toBeUndefined();
      expect(await closings(L1)).toHaveLength(0);
      expect(await noticesOf(L1)).toHaveLength(0);

      // ── 2. Отказ продавца: причина в заявке, журнал и строка сообщения — тем же запросом ──
      const closed = await close(L1, 'seats');
      expect(closed).toMatchObject({ kind: 'ok', changed: true, prevStatus: 'contacted', lead: { status: 'lost' } });
      if (closed.kind !== 'ok' || !closed.closed?.notice) throw new Error('закрытие с причиной не записало сообщение');
      expect(await leadOf(L1)).toMatchObject({ status: 'lost', lost_reason: 'seats' });
      const j1 = await closings(L1);
      expect(j1).toEqual([{ id: closed.closed.activityId, actor: 'partner', details: { reason: 'seats', via: 'site', from: 'contacted' } }]);
      expect(await noticesOf(L1)).toEqual([expect.objectContaining({
        id: closed.closed.notice.id, activity_id: closed.closed.activityId, answer_id: null, answer: 'decline', decline_reason: 'seats',
        lead_status_before: 'contacted', state: 'pending', skipped_reason: null, held: true,
      })]);
      // Повтор той же отметки — не событие: ни второй записи журнала, ни второго сообщения.
      const again = await close(L1, 'weather');
      expect(again).toMatchObject({ kind: 'ok', changed: false, prevStatus: 'lost' });
      expect(again.kind === 'ok' && again.closed).toBeUndefined();
      expect(await leadOf(L1)).toMatchObject({ lost_reason: 'seats' });
      expect(await closings(L1)).toHaveLength(1);
      expect(await noticesOf(L1)).toHaveLength(1);
      // Заметка к уже закрытой заявке с другой причиной в том же запросе: заметка записана,
      // а второго отказа нет — ни причины поверх прежней, ни журнала, ни второго сообщения человеку.
      const noted = await changeLeadStatus({
        leadId: L1, status: 'lost', notes: 'звонил ещё раз', actor: { kind: 'partner_user', userId: null }, scope: owner, via: 'site',
        lost: { reason: 'weather', partnerId: opId },
      });
      expect(noted).toMatchObject({ kind: 'ok', changed: false, prevStatus: 'lost', lead: { status: 'lost', notes: 'звонил ещё раз' } });
      expect(noted.kind === 'ok' && noted.closed).toBeUndefined();
      expect(await leadOf(L1)).toMatchObject({ lost_reason: 'seats' });
      expect(await closings(L1)).toHaveLength(1);
      expect(await noticesOf(L1)).toHaveLength(1);

      // Статус для человека и ИИ-агента — словами отказа с причиной, и вид построен из этого закрытия.
      const row1 = (await pool.query(status.REQUEST_STATUS_BY_KEY_IDS_SQL, [[k1.keyId]])).rows[0] as import('@/lib/mcp/request-status').StatusRow;
      expect(row1).toMatchObject({ lead_status: 'lost', lead_lost_reason: 'seats', lead_closed_id: closed.closed.activityId });
      expect(status.shownAnswerRef(row1)).toEqual({ source: 'closed', id: closed.closed.activityId });
      // Сообщение человеку уходит в его чат теми же словами, что после кнопки «Отказать»; ПД в нём нет.
      sent.dm.length = 0;
      sent.pd.length = 0;
      const o1 = await notices.deliverAnswerNotice(closed.closed.notice.id);
      expect(o1).toMatchObject({ state: 'delivered', via: 'max' });
      expect(sent.dm).toHaveLength(1);
      expect(String(sent.dm[0]!.chatId)).toBe(String(C1));
      expect(sent.dm[0]!.text).toContain('Оператор «Оператор 3а»');
      expect(sent.dm[0]!.text).toContain('Оператор «Оператор 3а» отказал по заявке: мест нет. Заявка закрыта');
      expect(sent.dm[0]!.text).not.toMatch(/Зоя|79995550901/);
      expect(sent.pd).toHaveLength(0);
      const v1 = await viewOf(k1.key);
      expect(v1).toMatchObject({ state: 'declined', human: 'Оператор отказал по заявке. Причина: нет мест.' });

      // ── 3. Вернули в работу — причина стёрта базой; закрыли другой дверью без причины — чужой причины нет ──
      expect(await set(L1, 'contacted')).toMatchObject({ changed: true, prevStatus: 'lost' });
      expect(await leadOf(L1)).toMatchObject({ status: 'contacted', lost_reason: null });
      await pool.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [L1]); // как кнопка администратора (status-action)
      expect(await leadOf(L1)).toMatchObject({ status: 'lost', lost_reason: null });
      const row1b = (await pool.query(status.REQUEST_STATUS_BY_KEY_IDS_SQL, [[k1.keyId]])).rows[0] as import('@/lib/mcp/request-status').StatusRow;
      expect(row1b).toMatchObject({ lead_lost_reason: null, lead_closed_id: null });
      expect(status.shownAnswerRef(row1b)).toBeNull();
      expect(await viewOf(k1.key)).toMatchObject({ state: 'declined', human: 'Оператор отказал по заявке или она не состоялась.' });

      // Триггер смотрит на смену статуса, а не на любую правку: заметка причину не трогает,
      // чужая запись статуса — стирает.
      const L2 = await mk('Яна Причина', '+79995550902');
      const k2 = (await status.issueRequestKeyRecord({ leadId: L2 }, 'create_booking_request', { opensChat: true }))!;
      const c2 = await close(L2, 'no_contact');
      expect(await leadOf(L2)).toMatchObject({ status: 'lost', lost_reason: 'no_contact' });
      await pool.query(`UPDATE leads SET notes = 'перезвонить в мае' WHERE id = $1`, [L2]);
      expect(await leadOf(L2)).toMatchObject({ lost_reason: 'no_contact' });
      // ── 4. Причина на стороне клиента: журнал есть, сообщения человеку нет ──
      expect(c2.kind === 'ok' && c2.closed).toMatchObject({ notice: null });
      expect(await closings(L2)).toEqual([expect.objectContaining({ details: { reason: 'no_contact', via: 'site', from: 'new' } })]);
      expect(await noticesOf(L2)).toHaveLength(0);
      const v2 = await viewOf(k2.key);
      expect(v2.state).toBe('declined');
      expect(v2.human).toBe('Оператор закрыл заявку: по его словам, связаться с человеком по телефону из заявки не удалось.');
      await pool.query(`UPDATE leads SET status = 'ai_qualified' WHERE id = $1`, [L2]); // конвейер заявок
      expect(await leadOf(L2)).toMatchObject({ status: 'ai_qualified', lost_reason: null });
      // Мусор в колонку база не принимает.
      await expect(pool.query(`UPDATE leads SET lost_reason = 'просто так' WHERE id = $1`, [L2])).rejects.toMatchObject({ code: '23514' });

      // ── 5. Кому сообщение не рождается «к отправке» ───────────────────────
      // Ничейная заявка, которую кабинет занял этим же действием: человек этому продавцу её не слал.
      const L3 = await mk('Ничья Заявка', '+79995550903', { operator_id: null });
      const c3 = await close(L3, 'dates');
      expect(c3.kind === 'ok' && c3.closed?.notice).toMatchObject({ state: 'skipped', skipped: 'not_addressee' });
      expect(await leadOf(L3)).toMatchObject({ status: 'lost', lost_reason: 'dates', operator_id: opId });
      // Чужая заявка недоступна вовсе: ни статуса, ни журнала.
      const L4 = await mk('Чужая Заявка', '+79995550904', { operator_id: otherOp });
      expect(await close(L4, 'seats')).toEqual({ kind: 'not_found' });
      expect(await leadOf(L4)).toMatchObject({ status: 'new', lost_reason: null });
      expect(await closings(L4)).toHaveLength(0);
      // Своя проба владельца.
      const L5 = await mk('Своя Проба', '+79995550905', { is_self: true });
      const c5 = await close(L5, 'other');
      expect(c5.kind === 'ok' && c5.closed?.notice).toMatchObject({ state: 'skipped', skipped: 'self' });
      // Заявка на машину: причина и журнал есть, строки сообщения нет — у неё свой ответ и свои слова.
      const L6 = await mk('Машина Целиком', '+79995550906', { source_data: { source: 'mcp', tool: 'request_charter', kind: 'charter' } });
      const c6 = await close(L6, 'seats');
      expect(c6.kind === 'ok' && c6.closed).toMatchObject({ notice: null });
      expect(await noticesOf(L6)).toHaveLength(0);
      // Заявку отменил клиент: её не закрывают «отказом» — ни статуса, ни причины, ни журнала.
      const L7 = await mk('Отменил Сам', '+79995550907');
      await pool.query(`UPDATE leads SET status = 'cancelled' WHERE id = $1`, [L7]);
      const c7 = await close(L7, 'seats');
      expect(c7).toMatchObject({ kind: 'ok', changed: false, prevStatus: 'cancelled', lead: { status: 'cancelled' } });
      expect(c7.kind === 'ok' && c7.closed).toBeUndefined();
      expect(await leadOf(L7)).toMatchObject({ status: 'cancelled', lost_reason: null });
      expect(await closings(L7)).toHaveLength(0);
      expect(await noticesOf(L7)).toHaveLength(0);
      // И с заметкой в том же запросе: заметка записана, причина отказа к отменённой заявке не прилипает.
      const c7n = await changeLeadStatus({
        leadId: L7, status: 'lost', notes: 'поздно узнал', actor: { kind: 'partner_user', userId: null }, scope: owner, via: 'site',
        lost: { reason: 'seats', partnerId: opId },
      });
      expect(c7n).toMatchObject({ kind: 'ok', changed: false, prevStatus: 'cancelled', lead: { status: 'cancelled', notes: 'поздно узнал' } });
      expect(await leadOf(L7)).toMatchObject({ status: 'cancelled', lost_reason: null });
      expect(await closings(L7)).toHaveLength(0);
      expect(await noticesOf(L7)).toHaveLength(0);

      // ── 6. Последнее слово продавца: закрытие с причиной новее ответа кнопкой, и наоборот ──
      const L8 = await mk('Ольга Порядок', '+79995550908');
      const k8 = (await status.issueRequestKeyRecord({ leadId: L8 }, 'create_booking_request', { opensChat: true }))!;
      // Кнопка «Отказать: погода» в чате: ответ и статус, причины в заявке нет — говорит ответ.
      const pressed = await answers.recordChatAnswer({ partnerId: opId, kind: 'lead', subjectId: L8, answer: 'decline', reason: 'weather', expectDate: D0 });
      expect(pressed).toMatchObject({ ok: true, already: false, notice: { state: 'pending' } });
      expect(await set(L8, 'lost')).toMatchObject({ changed: true });
      expect(await leadOf(L8)).toMatchObject({ status: 'lost', lost_reason: null });
      // Вид читается по строке, без отметки прочтения: сообщение об ответе кнопкой остаётся «ждёт».
      const row8 = (await pool.query(status.REQUEST_STATUS_BY_KEY_IDS_SQL, [[k8.keyId]])).rows[0] as import('@/lib/mcp/request-status').StatusRow;
      expect(status.buildRequestView(row8, Date.now()).human).toBe('Оператор отказал по заявке. Причина: погода, безопасность.');
      expect(status.shownAnswerRef(row8)).toMatchObject({ source: 'tour' });
      // Вернул в работу и закрыл в кабинете с другой причиной: говорит закрытие, ответ кнопкой вид больше не строит.
      await set(L8, 'contacted');
      const c8 = await close(L8, 'dates');
      if (c8.kind !== 'ok' || !c8.closed?.notice) throw new Error('второе закрытие не записало сообщение');
      expect(c8.closed.notice.state).toBe('pending');
      const row8b = (await pool.query(status.REQUEST_STATUS_BY_KEY_IDS_SQL, [[k8.keyId]])).rows[0] as import('@/lib/mcp/request-status').StatusRow;
      expect(status.shownAnswerRef(row8b)).toEqual({ source: 'closed', id: c8.closed.activityId });
      // Агент прочитал статус по ключу новой заявки — это доставка именно этого сообщения.
      expect((await viewOf(k8.key)).human).toBe('Оператор отказал по заявке. Причина: даты не подходят.');
      const n8 = await noticesOf(L8);
      expect(n8.find((n) => n.id === c8.closed!.notice!.id)).toMatchObject({ state: 'delivered', delivered_via: 'agent_read' });
      // Сообщение об ответе кнопкой при этом «доставленным чтением» не стало: вид был не из него.
      expect(n8.find((n) => n.answer_id !== null)).toMatchObject({ state: 'pending' });

      // ── 7. Продавец вернул заявку в работу раньше, чем сообщение ушло: отказ взят назад — не отправляется ──
      const L9 = await mk('Вера Возврат', '+79995550909');
      const k9 = (await status.issueRequestKeyRecord({ leadId: L9 }, 'create_booking_request', { opensChat: true }))!;
      const C9 = 9_300_079;
      expect(await links.linkChatToKeys('max', C9, [k9.key], 'created')).toBe(1);
      const c9 = await close(L9, 'group');
      if (c9.kind !== 'ok' || !c9.closed?.notice) throw new Error('закрытие с причиной не записало сообщение');
      await set(L9, 'contacted');
      sent.dm.length = 0;
      expect(await notices.deliverAnswerNotice(c9.closed.notice.id)).toMatchObject({ state: 'skipped', reason: 'outgrown' });
      expect(sent.dm).toHaveLength(0);
      expect((await noticesOf(L9))[0]).toMatchObject({ state: 'skipped', skipped_reason: 'outgrown' });

      // ── 8. Тот же запрос у остальных скоупов: номера параметров у них другие, и выполниться он обязан у каждого ──
      // Администратор закрывает без причины: ни причины, ни журнала, ни сообщения.
      const L10 = await mk('Админ Закрыл', '+79995550910');
      const a10 = await changeLeadStatus({ leadId: L10, status: 'lost', actor: { kind: 'admin', userId: null }, scope: { kind: 'admin' }, via: 'site' });
      expect(a10).toMatchObject({ kind: 'ok', changed: true, prevStatus: 'new', lead: { status: 'lost' } });
      expect(a10.kind === 'ok' && a10.closed).toBeUndefined();
      expect(await leadOf(L10)).toMatchObject({ status: 'lost', lost_reason: null });
      expect(await closings(L10)).toHaveLength(0);
      expect(await noticesOf(L10)).toHaveLength(0);
      // Оператор без карточки: только ничейные, занять нечем.
      const L11 = await mk('Ничья Вторая', '+79995550911', { operator_id: null });
      const noCard = { kind: 'unowned_only' as const };
      expect(await changeLeadStatus({ leadId: L11, status: 'lost', actor: { kind: 'partner_user', userId: null }, scope: noCard, via: 'site' }))
        .toMatchObject({ kind: 'ok', changed: true, lead: { status: 'lost' } });
      expect(await leadOf(L11)).toMatchObject({ status: 'lost', lost_reason: null, operator_id: null });
      expect(await changeLeadStatus({ leadId: L10, status: 'contacted', actor: { kind: 'partner_user', userId: null }, scope: noCard, via: 'site' }))
        .toEqual({ kind: 'not_found' });
      // Гид: только адресованные его карточке — отказ с причиной рождает сообщение; ничейную не видит и не занимает.
      const guideScope = { kind: 'owner' as const, partnerId: opId, claimUnowned: false };
      const L12 = await mk('Гид Отказал', '+79995550912');
      const g12 = await close(L12, 'weather', guideScope);
      expect(g12.kind === 'ok' && g12.closed?.notice).toMatchObject({ state: 'pending', skipped: null });
      expect(await leadOf(L12)).toMatchObject({ status: 'lost', lost_reason: 'weather' });
      const L13 = await mk('Ничья Третья', '+79995550913', { operator_id: null });
      expect(await close(L13, 'seats', guideScope)).toEqual({ kind: 'not_found' });
      expect(await leadOf(L13)).toMatchObject({ status: 'new', lost_reason: null, operator_id: null });
      await pool.query(`DELETE FROM tour_availability WHERE operator_tour_id = $1::bigint`, [tourId]);
    });

    it('очередь менеджера (этап 3б, 1430): три источника настоящими запросами; случай стоит, пока вид заявки построен из отказа; «Взял» — один раз', async () => {
      const queue = await import('@/lib/manager-queue/queue');
      const { managerQueueUrl } = await import('@/lib/manager-queue/link');
      const { changeLeadStatus } = await import('@/lib/leads/owner-lead-status');
      const notices = await import('@/lib/requests/answer-notice');
      const { answerRentalRequest } = await import('@/lib/rental/request-answer-flow');
      const { claimPartnerAnswer } = await import('@/lib/rental/request-answer-store');
      const { answerStayRequest } = await import('@/lib/stay/owner-answer-flow');
      const { PD_CONSENT_STAY_VERSION } = await import('@/lib/legal/pd-consent');
      const { kamchatkaToday } = await import('@/lib/seat-requests/core');
      const QUEUE_LINE = `В очереди менеджера — там же отметка «Взял»: ${managerQueueUrl()}`;

      const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query<T>(sql, params)).rows[0]!;
      const day = (n: number) => {
        const d = new Date(`${kamchatkaToday()}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const [D0, D1] = [day(25), day(26)];
      const today = (await one<{ d: string }>(`SELECT NOW()::date::text AS d`)).d;
      const tomorrow = (await one<{ d: string }>(`SELECT (NOW() + INTERVAL '1 day')::date::text AS d`)).d;
      // День начала очереди в проверке задан явно: сцена не зависит от часов раннера.
      const SINCE = '2026-01-01';
      const load = (since = SINCE) => queue.loadManagerQueue({ since });
      type Source = Awaited<ReturnType<typeof load>>['answer_notice' | 'vehicle_decline' | 'stay_busy'];
      const itemOf = (s: Source, id: string) => {
        if (s.state !== 'ok') throw new Error('источник очереди не прочитался');
        return (s.items as Array<{ id: string }>).find((i) => i.id === id) ?? null;
      };
      const marks = async (kind: string, id: string) => (await pool.query<{ taken_by: string | null; via: string }>(
        `SELECT taken_by::text AS taken_by, via FROM manager_queue_takes WHERE subject_kind = $1 AND subject_id = $2`, [kind, id],
      )).rows;

      const user = async (email: string, name: string) => (await one<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, 'x', 'admin') RETURNING id`, [email, name],
      )).id;
      const U1 = await user('queue-one@example.com', 'Ирина Первая');
      const U2 = await user('queue-two@example.com', 'Олег Второй');
      const NAME: Record<string, string> = { [U1]: 'Ирина Первая', [U2]: 'Олег Второй' };

      // ── 1. Отказ оператора, не дошедший до человека ──────────────────────
      const opId = (await one<{ id: string }>(
        `INSERT INTO partners (name, category, contact, slug) VALUES ('Оператор 3б', 'operator', '{}', 'op-3b') RETURNING id`,
      )).id;
      const tourId = (await one<{ id: number }>(
        `INSERT INTO operator_tours (title, base_price, operator_id, max_participants) VALUES ('Толбачик 3б', 9000, $1, 12) RETURNING id`, [opId],
      )).id;
      const mk = async (name: string, phone: string) => (await leads.createLeadDetailed({
        name, phone, comment: `[Заявка на бронь] Тур "Толбачик 3б" (ID${tourId}), дата ${D0}, участников 3.`,
        route_title: 'Толбачик 3б', source_url: 'mcp://vedar/booking', operator_id: opId, pd_consent: consentOf('operator'),
        source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tourId, date: D0, participants: 3 },
        skip_ai_processing: true,
      }))!.id;
      const owner = { kind: 'owner' as const, partnerId: opId, claimUnowned: true };
      const actor = { kind: 'partner_user' as const, userId: null };
      const set = (lead: string, st: 'contacted' | 'lost') => changeLeadStatus({ leadId: lead, status: st, actor, scope: owner, via: 'site' });
      /** «Отказ» с причиной на сайте; у человека нет ни чата, ни ИИ-агента — сообщение не дошло, менеджеру ушло письмо. */
      const refuse = async (lead: string) => {
        const c = await changeLeadStatus({
          leadId: lead, status: 'lost', actor, scope: owner, via: 'site', lost: { reason: 'seats', partnerId: opId },
        });
        if (c.kind !== 'ok' || !c.closed?.notice) throw new Error('закрытие с причиной не записало сообщение');
        expect(await notices.deliverAnswerNotice(c.closed.notice.id)).toMatchObject({ state: 'undelivered', manager: 'max' });
        return c.closed.notice.id;
      };

      const L1 = await mk('Зинаида Очередь', '+79995551101');
      sent.pd.length = 0;
      const N1 = await refuse(L1);
      // Письмо менеджеру о недоставке ведёт в очередь — первой кнопкой.
      expect(sent.pd).toHaveLength(1);
      expect((sent.pd[0]!.buttons as Array<{ text: string; url: string }>)[0]).toEqual({ text: 'Очередь менеджера', url: managerQueueUrl() });

      const q1 = await load();
      expect(itemOf(q1.answer_notice, N1)).toEqual({
        kind: 'answer_notice', id: N1, happened_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), partner_name: 'Оператор 3б',
        contact_name: 'Зинаида Очередь', contact_phone: '+79995551101', take: null,
        lead_id: L1, lead_status: 'lost', answer: 'decline', decline_reason: 'seats', manager_channel: 'max',
        tour_title: 'Толбачик 3б', date: D0, people: 3,
      });
      // День начала очереди: по умолчанию — константа, случай раньше неё в очередь не входит.
      expect(itemOf((await queue.loadManagerQueue()).answer_notice, N1) !== null).toBe(today >= queue.MANAGER_QUEUE_SINCE);
      expect(itemOf((await load(tomorrow)).answer_notice, N1)).toBeNull();
      expect(await queue.takeQueueItem({ kind: 'answer_notice', id: N1, userId: U1, via: 'site' }, { since: tomorrow })).toEqual({ kind: 'not_in_queue' });
      expect(await marks('answer_notice', N1)).toEqual([]);

      // Сверка идёт одним запросом на список: строка на заявку, повтор заявки строку не множит.
      const LX = await mk('Соседняя Заявка', '+79995551109');
      const rows = (await pool.query<{ lead_id: string; lead_status: string }>(status.REQUEST_STATUS_BY_LEADS_SQL, [[L1, LX, L1]])).rows;
      expect(rows.map((r) => [r.lead_id, r.lead_status]).sort()).toEqual([[L1, 'lost'], [LX, 'new']].sort());

      // Своя проба владельца сайта в очередь не встаёт.
      const L2 = await mk('Своя Проба', '+79995551102');
      const N2 = await refuse(L2);
      expect(itemOf((await load()).answer_notice, N2)).not.toBeNull();
      await pool.query(`UPDATE leads SET is_self = TRUE WHERE id = $1`, [L2]);
      expect(itemOf((await load()).answer_notice, N2)).toBeNull();
      expect(await queue.takeQueueItem({ kind: 'answer_notice', id: N2, userId: U1, via: 'site' }, { since: SINCE })).toEqual({ kind: 'not_in_queue' });

      // ── 2. «Взял» — один раз; второй видит, кто взял ─────────────────────
      const take = (userId: string, id = N1, kind: 'answer_notice' | 'vehicle_decline' | 'stay_busy' = 'answer_notice', via: 'site' | 'max' = 'site') =>
        queue.takeQueueItem({ kind, id, userId, via }, { since: SINCE });
      expect(await take(U1)).toEqual({ kind: 'taken', at: expect.stringMatching(/^\d{4}-/) });
      expect(await take(U2)).toMatchObject({ kind: 'already', by: 'Ирина Первая', mine: false });
      expect(await take(U1)).toMatchObject({ kind: 'already', by: 'Ирина Первая', mine: true });
      expect(await marks('answer_notice', N1)).toEqual([{ taken_by: U1, via: 'site' }]);
      expect(itemOf((await load()).answer_notice, N1)).toMatchObject({ take: { via: 'site', by: 'Ирина Первая' } });
      // «Вернуть в очередь» — случай снова ждёт.
      expect(await queue.releaseQueueItem({ kind: 'answer_notice', id: N1 })).toEqual({ kind: 'released' });
      expect(await queue.releaseQueueItem({ kind: 'answer_notice', id: N1 })).toEqual({ kind: 'not_taken' });
      expect(itemOf((await load()).answer_notice, N1)).toMatchObject({ take: null });
      // Двое нажали разом: отметка одна, и второй читает имя первого.
      const race = await Promise.all([take(U1), take(U2)]);
      expect(race.map((r) => r.kind).sort()).toEqual(['already', 'taken']);
      const winner = (await marks('answer_notice', N1))[0]!.taken_by!;
      expect([U1, U2]).toContain(winner);
      expect(race.find((r) => r.kind === 'already')).toMatchObject({ by: NAME[winner], mine: false });

      // ── 2а. Та же очередь в MAX администратора (3б-2): список с контактами и «Взял N» ──
      const maxActions = await import('@/lib/max/admin-actions');
      const maxQueue = await import('@/lib/max/admin-queue');
      const { unwrapPress } = await import('@/lib/chat-cabinet/signed-payload');
      const [MAX_U1, MAX_STRANGER] = [9_400_101, 9_400_199];
      await pool.query('INSERT INTO admin_max_bindings (user_id, max_user_id) VALUES ($1, $2)', [U1, MAX_U1]);
      const L3 = await mk('Тамара Максова', '+79995551108');
      const N3 = await refuse(L3);
      const listed = maxQueue.adminQueueReply(await load());
      expect(listed.pd).toBe(true);
      expect(listed.text).toContain('1. Тамара Максова, +79995551108 · Тур «Толбачик 3б»');
      // Самый свежий недоставленный отказ — первая строка и первая кнопка.
      expect(unwrapPress((listed.buttons ?? []).flat()[0]!.payload)).toEqual({ ok: true, payload: `ad:q:n:${N3}` });
      const pressAs = (presserId: number) => maxActions.handleAdminPress({
        chatId: presserId, privateChat: true, presserId, payload: `ad:q:n:${N3}`,
      });
      // Не администратор — отметки нет.
      expect((await pressAs(MAX_STRANGER)).text).toBe(maxActions.ADMIN_ACTION_TEXT.notAdmin);
      expect(await marks('answer_notice', N3)).toEqual([]);
      // Администратор: отметка — на аккаунт, привязанный к этому MAX, дверь — max; повтор отметку не множит.
      expect((await pressAs(MAX_U1)).text).toBe(maxQueue.ADMIN_QUEUE_TEXT.taken);
      expect(await marks('answer_notice', N3)).toEqual([{ taken_by: U1, via: 'max' }]);
      expect((await pressAs(MAX_U1)).text).toMatch(/^Этот случай уже взяли вы — \d{2}\.\d{2}, \d{2}:\d{2} по Камчатке\.$/);
      expect(await marks('answer_notice', N3)).toEqual([{ taken_by: U1, via: 'max' }]);
      expect(itemOf((await load()).answer_notice, N3)).toMatchObject({ take: { via: 'max', by: 'Ирина Первая' } });
      // Взятый случай из списка MAX ушёл вместе с контактами.
      expect(maxQueue.adminQueueReply(await load()).text).not.toContain('Тамара Максова');

      // ── 3. Заявка переросла отказ — случая в очереди нет, отметить его нельзя ──
      expect(await set(L1, 'contacted')).toMatchObject({ kind: 'ok', changed: true });
      expect(itemOf((await load()).answer_notice, N1)).toBeNull();
      await queue.releaseQueueItem({ kind: 'answer_notice', id: N1 });
      expect(await take(U2)).toEqual({ kind: 'not_in_queue' });
      expect(await marks('answer_notice', N1)).toEqual([]);
      // Закрыли снова — в очереди новый отказ, прежний не вернулся.
      const N1b = await refuse(L1);
      expect(N1b).not.toBe(N1);
      const q3 = await load();
      expect(itemOf(q3.answer_notice, N1b)).toMatchObject({ lead_id: L1, take: null });
      expect(itemOf(q3.answer_notice, N1)).toBeNull();
      // Сообщение дошло (ИИ-агент прочитал статус) — звонить не нужно.
      await pool.query(`UPDATE answer_notices SET state = 'delivered', delivered_via = 'agent_read', delivered_at = NOW() WHERE id = $1::bigint`, [N1b]);
      expect(itemOf((await load()).answer_notice, N1b)).toBeNull();
      expect(await take(U1, N1b)).toEqual({ kind: 'not_in_queue' });
      expect(await marks('answer_notice', N1b)).toEqual([]);

      // ── 4. «Не могу» перевозчика и прокатчика ────────────────────────────
      const carrier = (await one<{ id: string }>(
        `INSERT INTO partners (name, category, contact, slug) VALUES ('Перевозчик 3б', 'transfer', '{}', 'carrier-3b') RETURNING id`,
      )).id;
      const charter = async (name: string, phone: string) => (await leads.createLeadDetailed({
        name, phone, comment: `[Заявка на машину] «Перевозчик 3б», с ${D0}, Мутновский, человек: 4 (${phone.slice(-2)})`,
        route_title: 'Машина: Мутновский', operator_id: carrier, source_url: 'https://vedarai.ru/transfers/carrier-3b',
        pd_consent: consentOf('carrier'),
        source_data: { source: 'transfer_page', kind: 'charter', carrier_id: carrier, destination: 'Елизово — Мутновский', date_from: D0, date_to: D1, passengers: 4 },
        skip_ai_processing: true,
      }))!.id;
      const partner = { partnerId: carrier, partnerName: 'Перевозчик 3б', userId: null };
      const managers: string[] = [];
      const notifyManager = async (t: string) => { managers.push(t); };
      const LC = await charter('Пётр Заказчик', '+79995551103');
      const declined = await answerRentalRequest({ partner, leadId: LC, answer: 'decline', via: 'site', notifyManager });
      expect(declined.tell).toMatchObject({ kind: 'charter_decline', notice: { state: 'undelivered' } });
      // Менеджеру сказано, где случай лежит; ПД в рабочий Telegram не уходит.
      expect(managers).toHaveLength(1);
      expect(managers[0]!.split('\n').at(-1)).toBe(QUEUE_LINE);
      expect(managers[0]).not.toMatch(/Пётр|79995551103/);
      const V1 = (await one<{ id: string }>(`SELECT id::text AS id FROM lead_activity_log WHERE lead_id = $1 AND action = 'partner_answered'`, [LC])).id;
      const V1notice = (await one<{ id: string }>(`SELECT id::text AS id FROM answer_notices WHERE lead_id = $1::uuid`, [LC])).id;
      const q4 = await load();
      expect(itemOf(q4.vehicle_decline, V1)).toEqual({
        kind: 'vehicle_decline', id: V1, happened_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), partner_name: 'Перевозчик 3б',
        contact_name: 'Пётр Заказчик', contact_phone: '+79995551103', take: null,
        lead_id: LC, lead_status: 'lost', vehicle_kind: 'charter', vehicle_title: 'Елизово — Мутновский',
        date_from: D0, date_to: D1, notice_state: 'undelivered',
      });
      // У «Не могу» своя строка: в недоставленные отказы операторов оно не попадает и случай не двоится.
      expect(itemOf(q4.answer_notice, V1notice)).toBeNull();
      // «Беру» в очередь не встаёт.
      const LC2 = await charter('Раиса Заказчица', '+79995551104');
      const took = await answerRentalRequest({ partner, leadId: LC2, answer: 'take', via: 'site', notifyManager });
      expect(took.tell.kind).toBe('charter_take');
      expect(managers[1]).not.toContain(managerQueueUrl());
      const V2 = (await one<{ id: string }>(`SELECT id::text AS id FROM lead_activity_log WHERE lead_id = $1 AND action = 'partner_answered'`, [LC2])).id;
      expect(itemOf((await load()).vehicle_decline, V2)).toBeNull();
      expect(await take(U1, V2, 'vehicle_decline')).toEqual({ kind: 'not_in_queue' });
      // Прокатчик: статус заявки ответ не меняет, сообщение заказчику ещё не отправлено — так и видно.
      const rentalP = (await one<{ id: string }>(
        `INSERT INTO partners (name, category, contact, slug) VALUES ('Прокат 3б', 'cars', '{}', 'rental-3b') RETURNING id`,
      )).id;
      const LR = (await leads.createLeadDetailed({
        name: 'Семён Арендатор', phone: '+79995551106', comment: `[Заявка на прокат] УАЗ Патриот, с ${D0} по ${D1}`,
        route_title: 'Прокат: УАЗ Патриот', operator_id: rentalP, source_url: 'https://vedarai.ru/car-rental', pd_consent: consentOf('carrier'),
        source_data: { source: 'car_rental_page', kind: 'car_rental', company_id: rentalP, offer_title: 'УАЗ Патриот', date_from: D0, date_to: D1 },
        skip_ai_processing: true,
      }))!.id;
      const claimed = await claimPartnerAnswer({
        leadId: LR, answer: 'decline', kind: 'car_rental', partnerId: rentalP, offerId: null, carTitle: 'УАЗ Патриот', dateFrom: D0, dateTo: D1, mark: null,
      });
      expect(claimed).toMatchObject({ outcome: 'saved', notice: { state: 'pending' } });
      const V3 = (await one<{ id: string }>(`SELECT id::text AS id FROM lead_activity_log WHERE lead_id = $1 AND action = 'partner_answered'`, [LR])).id;
      expect(itemOf((await load()).vehicle_decline, V3)).toMatchObject({
        vehicle_kind: 'car_rental', vehicle_title: 'УАЗ Патриот', lead_status: 'new', notice_state: 'pending', partner_name: 'Прокат 3б',
      });
      // Менеджер взял заявку перевозчика в работу — случай ушёл из очереди сам, отметить его уже нельзя.
      expect(await take(U1, V1, 'vehicle_decline')).toMatchObject({ kind: 'taken' });
      await pool.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [LC]);
      expect(itemOf((await load()).vehicle_decline, V1)).toBeNull();
      await queue.releaseQueueItem({ kind: 'vehicle_decline', id: V1 });
      expect(await take(U2, V1, 'vehicle_decline')).toEqual({ kind: 'not_in_queue' });

      // ── 5. «Занято» хозяина жилья ────────────────────────────────────────
      const stayP = (await one<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_public, is_verified) VALUES ('Дом 3б', 'stay', '{}', FALSE, FALSE) RETURNING id`,
      )).id;
      const acc = (await one<{ id: string }>(
        `INSERT INTO accommodations (name, type, coordinates, partner_id) VALUES ('Дом 3б', 'guesthouse', '{"lat":53.0,"lng":158.6}', $1) RETURNING id`, [stayP],
      )).id;
      const stayReq = async (name: string, phone: string) => (await one<{ id: string }>(
        `INSERT INTO stay_requests (accommodation_id, check_in_date, check_out_date, guests, guest_name, guest_phone,
                                    pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version, door)
         VALUES ($1, '2099-08-10', '2099-08-12', 2, $2, $3, NOW(), '203.0.113.9', 'stay-request', $4, 'form') RETURNING id`,
        [acc, name, phone, PD_CONSENT_STAY_VERSION],
      )).id;
      const host = { partnerId: stayP, partnerName: 'Дом 3б' };
      const S1 = await stayReq('Галина Гостья', '+79995551105');
      const S2 = await stayReq('Дарья Гостья', '+79995551107');
      managers.length = 0;
      expect((await answerStayRequest({ partner: host, requestId: S1, answer: 'busy', via: 'max', db: pool, notifyManager })).tell.kind).toBe('answered');
      expect((await answerStayRequest({ partner: host, requestId: S2, answer: 'free', via: 'max', db: pool, notifyManager })).tell.kind).toBe('answered');
      expect(managers[0]!.split('\n').at(-1)).toBe(QUEUE_LINE);
      expect(managers[0]).not.toMatch(/Галина|79995551105/);
      expect(managers[1]).not.toContain(managerQueueUrl());
      const q5 = await load();
      expect(itemOf(q5.stay_busy, S1)).toEqual({
        kind: 'stay_busy', id: S1, stay_request_id: S1, happened_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), partner_name: 'Дом 3б',
        contact_name: 'Галина Гостья', contact_phone: '+79995551105', take: null,
        accommodation_name: 'Дом 3б', check_in: '2099-08-10', check_out: '2099-08-12', guests: 2,
      });
      expect(itemOf(q5.stay_busy, S2)).toBeNull();
      expect(await take(U1, S2, 'stay_busy')).toEqual({ kind: 'not_in_queue' });
      expect(itemOf((await load(tomorrow)).stay_busy, S1)).toBeNull();
      expect(await take(U2, S1, 'stay_busy', 'max')).toMatchObject({ kind: 'taken' });
      expect(itemOf((await load()).stay_busy, S1)).toMatchObject({ take: { via: 'max', by: 'Олег Второй' } });
      // Взятый случай виден неделю, потом уходит из списка; невзятый остаётся, пока он правда.
      await pool.query(`UPDATE manager_queue_takes SET taken_at = NOW() - INTERVAL '8 days' WHERE subject_kind = 'stay_busy' AND subject_id = $1`, [S1]);
      expect(itemOf((await load()).stay_busy, S1)).toBeNull();
      await pool.query(`UPDATE manager_queue_takes SET taken_at = NOW() WHERE subject_kind = 'stay_busy' AND subject_id = $1`, [S1]);
      // Аккаунт взявшего удалён — отметка остаётся, без имени.
      await pool.query(`DELETE FROM users WHERE id = $1`, [U2]);
      expect(itemOf((await load()).stay_busy, S1)).toMatchObject({ take: { via: 'max', by: null } });
      expect(await take(U1, S1, 'stay_busy')).toMatchObject({ kind: 'already', by: null, mine: false });

      // ── 6. Таблица отметок: чужая форма не принимается; миграция повторяется без вреда ──
      for (const [kind, id, via] of [['lead', '1', 'site'], ['answer_notice', S1, 'site'], ['stay_busy', '12', 'site'], ['vehicle_decline', '7', 'telegram']]) {
        await expect(pool.query(
          `INSERT INTO manager_queue_takes (subject_kind, subject_id, via) VALUES ($1, $2, $3)`, [kind, id, via],
        ), `${kind} ${id} ${via}`).rejects.toMatchObject({ code: '23514' });
      }
      await pool.query(readFileSync(join(process.cwd(), 'migrations', '1430_manager_queue_takes.sql'), 'utf8'));
      expect(await marks('stay_busy', S1)).toEqual([{ taken_by: null, via: 'max' }]);
    });

    it('удалили заявку — связи ушли вместе с её ключами', async () => {
      const own = await pool.query(`SELECT lead_id::text AS lead FROM agent_request_keys WHERE id = $1`, [keyId]);
      await pool.query(`DELETE FROM agent_request_keys WHERE lead_id = $1::uuid`, [own.rows[0].lead]);
      const left = await pool.query(`SELECT count(*)::int AS n FROM chat_request_links WHERE chat_id IN ($1, $2)`, [String(CHAT), String(OTHER)]);
      expect(left.rows[0].n).toBe(0);
    });
  });
});
