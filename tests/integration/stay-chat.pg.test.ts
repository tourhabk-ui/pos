/**
 * Переписка хозяина жилья и гостя по заявке на настоящем PostgreSQL (1348,
 * #2843).
 *
 * Судится весь путь своим кодом на схеме прода: ключ статуса → страница
 * заявки, сообщение гостя → MAX хозяина с кнопкой «Ответить гостю», кнопка →
 * ожидание → следующий текст хозяина уходит гостю, «Старт» гостя по ключу
 * подключает его чат и не перезаписывает чужой, «отмена» гасит ожидание,
 * чужой чат на кнопку не пускается. CRM: заявка становится клиентом хозяина,
 * сообщения ложатся в ленту без текста, «Входящие» видят ответ хозяина.
 * Подменена только отправка (MAX и pd-alert): судится то, что ей передано.
 *
 * Своя база `stay_chat_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';

const sent = vi.hoisted(() => ({
  pd: [] as Array<{ text: string; stub: string; buttons?: unknown[]; to?: { maxChatId?: unknown } }>,
  dm: [] as Array<{ chatId: unknown; text: string; buttons?: unknown[] }>,
}));

vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: vi.fn(async (p: { text: string; stub: string; buttons?: unknown[]; to?: { maxChatId?: unknown } }) => {
    sent.pd.push(p);
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

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[stay-chat.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'stay_chat_test';
const OWNER_CHAT = 7001;
const GUEST_CHAT = 7002;
const STRANGER_CHAT = 7003;

withPg('переписка по заявке на жильё на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let partnerId = '';
  let requestId = '';
  let key = '';
  let svc: typeof import('@/lib/stay/stay-chat-service');

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

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
    const { issueRequestKey, STAY_FORM_KEY_NAME } = await import('@/lib/mcp/request-status');
    key = (await issueRequestKey({ stayRequestId: requestId }, STAY_FORM_KEY_NAME)) ?? '';
    svc = await import('@/lib/stay/stay-chat-service');
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('ключ формы выдан и даёт согласие «владельцу жилья»', async () => {
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const { readConsentPurpose } = await import('@/lib/mcp/request-status');
    expect(await readConsentPurpose(key)).toBe('stay');
  });

  it('страница: переписка пуста, без имени и телефона гостя', async () => {
    const r = await svc.readStayChat(key);
    expect(r.outcome).toBe('ok');
    if (r.outcome !== 'ok') return;
    expect(r.messages).toEqual([]);
    expect(r.guestBound).toBe(false);
    expect(r.ownerOnMax).toBe(true);
    expect(r.facts.accommodationName).toBe('Кутха');
    const json = JSON.stringify(r);
    expect(json).not.toContain('Анна');
    expect(json).not.toContain('+7999');
  });

  it('ключ чужой формы и неверный ключ — не переписка', async () => {
    expect((await svc.readStayChat('x')).outcome).toBe('bad_key');
    expect((await svc.readStayChat('A'.repeat(32))).outcome).toBe('not_found');
  });

  it('сообщение гостя со страницы уходит в MAX хозяина с кнопкой «Ответить гостю»', async () => {
    sent.pd.length = 0;
    const r = await svc.postGuestMessage(requestId, 'Можно заехать в 12?', 'page');
    expect(r).toEqual({ outcome: 'sent', delivery: 'max' });
    expect(sent.pd).toHaveLength(1);
    expect(String(sent.pd[0].to?.maxChatId)).toBe(String(OWNER_CHAT));
    expect(sent.pd[0].text).toContain('Можно заехать в 12?');
    expect(sent.pd[0].text).toContain('Анна Гостева');
    expect(sent.pd[0].stub).not.toContain('Анна');
    expect(sent.pd[0].stub).not.toContain('Можно заехать');
    expect(sent.pd[0].buttons).toEqual([{ text: 'Ответить гостю', payload: `sq:o:${requestId}` }]);
    const m = await pool.query(`SELECT author, door, delivery_channel FROM stay_request_messages WHERE stay_request_id = $1`, [requestId]);
    expect(m.rows).toEqual([{ author: 'guest', door: 'page', delivery_channel: 'max' }]);
  });

  it('CRM: заявка — клиент хозяина, сообщение в ленте без текста', async () => {
    const link = await pool.query(
      `SELECT l.partner_id, c.display_name, c.phone FROM crm_contact_links l JOIN crm_contacts c ON c.id = l.contact_id
        WHERE l.source_kind = 'stay_request' AND l.source_id = $1`, [requestId],
    );
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0].partner_id).toBe(partnerId);
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
    expect(r.rows[0].contact_id).toBeTruthy();
  });

  it('кнопка хозяина из чужого чата не заводит ожидания', async () => {
    const r = await svc.armStayChatWait('owner', requestId, STRANGER_CHAT);
    expect(r.text).toMatch(/не к вашему объекту/);
    expect(await svc.captureStayChatText(STRANGER_CHAT, 'привет')).toBeNull();
  });

  it('без кнопки текст хозяина гостю не уходит', async () => {
    expect(await svc.captureStayChatText(OWNER_CHAT, 'запиши звонок Анне')).toBeNull();
  });

  it('кнопка меню и команда при ожидании — не сообщение гостю, ожидание остаётся', async () => {
    await svc.armStayChatWait('owner', requestId, OWNER_CHAT);
    expect(await svc.captureStayChatText(OWNER_CHAT, 'Входящие')).toBeNull();
    expect(await svc.captureStayChatText(OWNER_CHAT, '/start')).toBeNull();
    const cancelled = await svc.captureStayChatText(OWNER_CHAT, '/cancel');
    expect(cancelled?.text).toMatch(/Не отправляю/);
  });

  it('кнопка → ответ хозяина; гость без MAX видит его на странице', async () => {
    sent.dm.length = 0;
    const armed = await svc.armStayChatWait('owner', requestId, OWNER_CHAT);
    expect(armed.text).toMatch(/Напишите ответ гостю/);
    const r = await svc.captureStayChatText(OWNER_CHAT, 'Да, ждём с 12:00');
    expect(r?.text).toMatch(/MAX гость пока не подключил/);
    expect(r?.buttons).toEqual([{ text: 'Ответить гостю', payload: `sq:o:${requestId}` }]);
    expect(sent.dm).toHaveLength(0);
    // Ожидание погасло: следующий текст — снова обычным путём.
    expect(await svc.captureStayChatText(OWNER_CHAT, 'ещё')).toBeNull();
    const page = await svc.readStayChat(key);
    expect(page.outcome === 'ok' && page.messages.map((m) => [m.author, m.body])).toEqual([
      ['guest', 'Можно заехать в 12?'], ['owner', 'Да, ждём с 12:00'],
    ]);
  });

  it('статус для помощника (MCP, A2A): владелец ответил, текста нет, есть ссылка подключить MAX', async () => {
    const { readRequestStatus } = await import('@/lib/mcp/request-status');
    const v = await readRequestStatus(key);
    expect(v.owner_replies).toBe(1);
    expect(v.owner_last_reply_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
    const { readRequestStatus } = await import('@/lib/mcp/request-status');
    expect((await readRequestStatus(key)).max_link).toBeNull();
  });

  it('ответ хозяина уходит в MAX гостя с кнопкой «Написать владельцу»', async () => {
    sent.dm.length = 0;
    await svc.armStayChatWait('owner', requestId, OWNER_CHAT);
    const r = await svc.captureStayChatText(OWNER_CHAT, 'Баня с 18:00');
    expect(r?.text).toMatch(/Передал гостю в MAX/);
    expect(sent.dm).toHaveLength(1);
    expect(String(sent.dm[0].chatId)).toBe(String(GUEST_CHAT));
    expect(sent.dm[0].text).toContain('Баня с 18:00');
    expect(sent.dm[0].text).not.toContain('Анна');
    expect(sent.dm[0].buttons).toEqual([{ text: 'Написать владельцу', payload: `sq:g:${requestId}` }]);
  });

  it('гость пишет из MAX после кнопки; «отмена» гасит ожидание', async () => {
    sent.pd.length = 0;
    await svc.armStayChatWait('guest', requestId, GUEST_CHAT);
    const cancelled = await svc.captureStayChatText(GUEST_CHAT, 'отмена');
    expect(cancelled?.text).toMatch(/Не отправляю/);
    expect(sent.pd).toHaveLength(0);
    await svc.armStayChatWait('guest', requestId, GUEST_CHAT);
    const r = await svc.captureStayChatText(GUEST_CHAT, 'Спасибо, будем к 12');
    expect(r?.text).toMatch(/Передал владельцу/);
    expect(sent.pd).toHaveLength(1);
    expect(sent.pd[0].text).toContain('Спасибо, будем к 12');
  });

  it('кнопка гостя из чужого чата не заводит ожидания', async () => {
    const r = await svc.armStayChatWait('guest', requestId, STRANGER_CHAT);
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

  it('удалили заявку — переписка и ожидания ушли с ней', async () => {
    await pool.query(`DELETE FROM stay_requests WHERE id = $1`, [requestId]);
    const m = await pool.query(`SELECT count(*)::int AS n FROM stay_request_messages WHERE stay_request_id = $1`, [requestId]);
    const w = await pool.query(`SELECT count(*)::int AS n FROM stay_chat_waits WHERE stay_request_id = $1`, [requestId]);
    expect(m.rows[0].n).toBe(0);
    expect(w.rows[0].n).toBe(0);
  });
});
