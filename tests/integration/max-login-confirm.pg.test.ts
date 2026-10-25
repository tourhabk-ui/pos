/**
 * Вход через MAX — только по «Да, это я» того, кто нажал «Старт» (аудит 22.10).
 *
 * Ссылку входа создаёт любой: POST /api/auth/max/start отдаёт nonce и
 * deep-link в бота. До аудита «Старт» по ссылке сразу подтверждал вход.
 * Злоумышленник начинал вход у себя, присылал ссылку жертве («посмотри бота»),
 * жертва жала «Старт» — и браузер злоумышленника, опрашивающий статус,
 * получал JWT аккаунта жертвы.
 *
 * Здесь весь путь исполняется против базы со схемой прода: настоящая сессия,
 * настоящий обработчик бота, настоящий опрос статуса с выдачей JWT. Подменены
 * только API MAX (что бот отправил) и сверка секрета вебхука (её держит
 * lib/max/webhook-url.ts, зона §7, и свой сторож).
 *
 *   «Старт»               → вопрос с кнопками, сайт видит «pending», входа нет;
 *   «Да» другого человека → сессия не подтверждена;
 *   «Нет» владельца       → сессия гаснет, сайт видит «expired»;
 *   «Да» владельца        → вход, JWT выдаётся ровно один раз;
 *   незаверенный источник → «Старт» сессию даже не закрепляет.
 *
 * Без KERNEL_PG_TEST_URL файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

const { sent } = vi.hoisted(() => ({
  sent: [] as Array<{ chatId: number; text: string; opts: unknown }>,
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({
    api: {
      sendMessageToChat: async (chatId: number, text: string, opts: unknown) => {
        sent.push({ chatId, text, opts });
        return {};
      },
      answerOnCallback: async () => ({}),
    },
  }),
}));

vi.mock('@/lib/max/webhook-url', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/webhook-url')>()),
  isVerifiedMaxWebhook: (url: string) => new URL(url).searchParams.get('verified') === '1',
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[max-login-confirm.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'max_login_confirm_test';
const VICTIM = 710_001;
const STRANGER = 710_002;

interface ButtonRow { type: string; text: string; payload: string }

/** Апдейт в вебхук бота, как его шлёт MAX. */
async function bot(update: Record<string, unknown>, verified = true) {
  const { POST } = await import('@/app/api/max/kuzmich/route');
  const url = `https://vedarai.ru/api/max/kuzmich${verified ? '?verified=1' : ''}`;
  const res = await POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(update) }));
  expect(res.status).toBe(200);
}

const start = (nonce: string, userId: number) => bot({
  update_type: 'bot_started', timestamp: Date.now(), chat_id: userId,
  user: { user_id: userId, name: 'Анна' }, payload: `login-${nonce}`,
});

const press = (payload: string, userId: number) => bot({
  update_type: 'message_callback', timestamp: Date.now(),
  callback: { timestamp: Date.now(), callback_id: `cb-${userId}-${payload.length}`, payload, user: { user_id: userId, name: 'X' } },
  message: { recipient: { chat_id: userId, chat_type: 'dialog' }, body: { mid: 'm', seq: 1, text: null } },
});

/** Опрос статуса — то, что делает браузер, начавший вход. */
async function status(nonce: string): Promise<{ status: string; data?: { token?: string } }> {
  const { GET } = await import('@/app/api/auth/max/status/route');
  const res = await GET(new NextRequest(`https://vedarai.ru/api/auth/max/status?nonce=${encodeURIComponent(nonce)}`));
  return (await res.json()) as { status: string; data?: { token?: string } };
}

async function newSession(): Promise<string> {
  const { createMaxLoginSession } = await import('@/lib/auth/max-login');
  return (await createMaxLoginSession()).nonce;
}

/** Кнопки последнего сообщения бота. */
function lastButtons(): ButtonRow[] {
  const last = sent[sent.length - 1];
  const opts = last?.opts as { attachments?: Array<{ payload?: { buttons?: ButtonRow[][] } }> } | undefined;
  return (opts?.attachments?.[0]?.payload?.buttons ?? []).flat();
}

withPg('вход через MAX подтверждается вопросом в боте (22.10)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.MAX_BOT_TOKEN = 'test-max-token';
    process.env.JWT_SECRET = 'test-jwt-secret-for-max-login-confirm-0123456789';
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('«Старт» по ссылке — вопрос с кнопками «Да» и «Нет», сайт входа не получает', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Нажмите «Да, это я», только если вы сами');
    const buttons = lastButtons();
    expect(buttons.map((b) => b.text)).toEqual(['Да, это я', 'Нет, не я']);
    expect(buttons.every((b) => b.payload.endsWith(nonce))).toBe(true);
    expect((await status(nonce)).status).toBe('pending');
  });

  it('«Да» другого пользователя MAX вход не подтверждает', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);
    const yes = lastButtons().find((b) => b.text === 'Да, это я')!;

    await press(yes.payload, STRANGER);
    expect(sent[sent.length - 1].text).toContain('устарела или уже использована');
    expect((await status(nonce)).status).toBe('pending');
  });

  it('«Старт» второго человека чужую сессию не перехватывает', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);
    sent.length = 0;
    await start(nonce, STRANGER);
    expect(sent[0].text).toContain('устарела или уже использована');
    expect(lastButtons()).toEqual([]);
  });

  it('«Нет» владельца гасит вход: браузер, начавший его, получает «истекла»', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);
    const no = lastButtons().find((b) => b.text === 'Нет, не я')!;

    await press(no.payload, VICTIM);
    expect(sent[sent.length - 1].text).toContain('Вход отменён');
    expect((await status(nonce)).status).toBe('expired');

    // И позднее «Да» уже ничего не открывает.
    const yes = `${no.payload.replace('maxlogin_no:', 'maxlogin_ok:')}`;
    await press(yes, VICTIM);
    expect((await status(nonce)).status).toBe('expired');
  });

  it('«Да» владельца — вход, и JWT выдаётся ровно один раз', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);
    const yes = lastButtons().find((b) => b.text === 'Да, это я')!;

    await press(yes.payload, VICTIM);
    expect(sent[sent.length - 1].text).toContain('Вход подтверждён');

    const first = await status(nonce);
    expect(first.status).toBe('authenticated');
    expect(typeof first.data?.token).toBe('string');
    expect((await status(nonce)).status).toBe('expired');

    const { rows } = await pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM users WHERE max_user_id = $1', [VICTIM],
    );
    expect(rows[0].n).toBe('1');
  });

  it('незаверенный источник: «Старт» сессию не закрепляет, кнопок входа нет', async () => {
    const nonce = await newSession();
    await bot({
      update_type: 'bot_started', timestamp: Date.now(), chat_id: VICTIM,
      user: { user_id: VICTIM, name: 'Анна' }, payload: `login-${nonce}`,
    }, false);
    // Обычное приветствие с темами бот шлёт и так; кнопок входа в нём нет.
    expect(lastButtons().filter((b) => b.payload?.startsWith('maxlogin_'))).toEqual([]);
    const { rows } = await pool.query<{ max_user_id: string | null }>(
      'SELECT max_user_id::text FROM max_login_sessions WHERE nonce = $1', [nonce],
    );
    expect(rows[0].max_user_id).toBeNull();
  });

  // ── Администратор в MAX (слово владельца 23.10, «1а») ─────────────────────
  //
  // Ссылку выдаёт себе сам администратор (POST /api/admin/max-link), «Старт»
  // по ней привязывает человека MAX; права перечитываются на каждом
  // сообщении. Всё — против схемы прода: настоящая выдача, погашение,
  // привязка, ответы с ПД через sendPdAlert в его же MAX.
  describe('администратор в MAX — одноразовая ссылка из админки (23.10)', () => {
    const ADMIN_MAX = 720_001;
    const OTHER_MAX = 720_002;
    let adminId = '';
    let adminToken = '';

    async function issueLink(): Promise<{ status: number; link?: string }> {
      const { POST } = await import('@/app/api/admin/max-link/route');
      const res = await POST(new NextRequest('https://vedarai.ru/api/admin/max-link', {
        method: 'POST', headers: { authorization: `Bearer ${adminToken}` },
      }));
      const body = (await res.json()) as { data?: { link?: string } };
      expect(res.headers.get('cache-control')).toBe('no-store');
      return { status: res.status, link: body.data?.link };
    }

    const startArg = (link: string): string => new URL(link).searchParams.get('start') ?? '';

    const startWith = (payload: string, userId: number, verified = true) => bot({
      update_type: 'bot_started', timestamp: Date.now(), chat_id: userId + 5,
      user: { user_id: userId, name: 'Админ' }, payload,
    }, verified);

    const say = (text: string, userId: number) => bot({
      update_type: 'message_created', timestamp: Date.now(),
      message: {
        sender: { user_id: userId, name: 'Админ' },
        recipient: { chat_id: userId + 5, chat_type: 'dialog' },
        body: { mid: `m-${text.length}`, seq: 1, text },
      },
    });

    async function binding(): Promise<{ max_user_id: string } | undefined> {
      const { rows } = await pool.query<{ max_user_id: string }>(
        'SELECT max_user_id::text FROM admin_max_bindings WHERE user_id = $1', [adminId],
      );
      return rows[0];
    }

    const setAdmin = (on: boolean) => pool.query(
      `UPDATE users SET role = $2,
              preferences = jsonb_build_object('roles', CASE WHEN $3 THEN '["tourist","admin"]'::jsonb ELSE '["tourist"]'::jsonb END)
        WHERE id = $1`,
      [adminId, on ? 'admin' : 'tourist', on],
    );

    beforeAll(async () => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role, preferences)
         VALUES ('max-admin@test.invalid', 'Админ Тест', 'x', 'admin', '{"roles":["tourist","admin"]}')
         RETURNING id::text AS id`,
      );
      adminId = rows[0].id;
      const { createToken } = await import('@/lib/auth/jwt');
      adminToken = await createToken({ userId: adminId, email: 'max-admin@test.invalid', role: 'admin' });
    });

    beforeEach(async () => {
      await setAdmin(true);
      // Снятие роли отзывает сессии — каждая проверка начинает с живой.
      await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [adminId]);
      await pool.query(
        `INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [adminId, adminToken],
      );
      await pool.query('DELETE FROM admin_max_bindings');
      await pool.query('DELETE FROM admin_max_link_tokens');
      await pool.query('DELETE FROM admin_tg_bindings');
      await pool.query('DELETE FROM admin_tg_link_tokens');
    });

    it('ссылка → «Старт» → привязан человек MAX, чат знает администратора; ключ в базе — только хеш', async () => {
      const issued = await issueLink();
      expect(issued.status).toBe(200);
      const arg = startArg(issued.link!);
      expect(arg).toMatch(/^adm_[A-Za-z0-9_-]{32}$/);
      const { rows: stored } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM admin_max_link_tokens');
      expect(stored).toHaveLength(1);
      expect(stored[0].token_hash).not.toContain(arg.slice(4));

      await startWith(arg, ADMIN_MAX);
      expect(sent[sent.length - 1].text).toContain('подключён к Ведару как администратор');
      expect(await binding()).toEqual({ max_user_id: String(ADMIN_MAX) });
      // Состояние для админки — ISO 8601: текстовую форму PostgreSQL Safari не разбирает.
      const { adminMaxStatus } = await import('@/lib/max/admin-link');
      const status = await adminMaxStatus(adminId);
      expect(status.bound).toBe(true);
      expect(status.boundAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      sent.length = 0;
      await startWith('', ADMIN_MAX);
      expect(sent[0].text).toContain('Вы подключены как администратор Ведара, Админ Тест');
      expect(sent[0].text).not.toContain('Я Кузьмич');
    });

    it('«заявки» с контактами туриста уходят только в личный MAX администратора, не в рабочий чат', async () => {
      await pool.query(
        `INSERT INTO leads (name, phone, route_title, status, created_at)
         VALUES ('Турист Проверочный', '+70000000001', 'Вулкан Горелый', 'new', NOW() - INTERVAL '3 hours')`,
      );
      await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
      sent.length = 0;
      await say('заявки', ADMIN_MAX);
      expect(sent).toHaveLength(1);
      expect(sent[0].chatId).toBe(ADMIN_MAX + 5);
      expect(sent[0].text).toContain('Заявки без ответа человека: 1');
      expect(sent[0].text).toContain('Турист Проверочный, +70000000001');
      expect(sent[0].text).toContain('больше двух часов');
      await pool.query(`DELETE FROM leads WHERE phone = '+70000000001'`);
    });

    it('чтение против схемы прода: ни одна команда не отвечает «не прочиталось»', async () => {
      await pool.query(
        `INSERT INTO agent_run_history (agent_id, status, ended_at, metadata)
         VALUES ('watchdog', 'success', NOW() - INTERVAL '10 minutes', '{"alerts":[{"type":"lead_stale"},{"type":"lead_stale"}]}')`,
      );
      const { adminReplyFor } = await import('@/lib/max/admin-read');
      for (const cmd of ['dates', 'bookings', 'leads', 'summary', 'health'] as const) {
        const reply = await adminReplyFor(cmd);
        expect(reply.text, cmd).not.toMatch(/не прочитал|не собрал|не загрузилось/);
      }
      const health = await adminReplyFor('health');
      expect(health.text).toContain('10 мин назад');
      expect(health.text).toContain('тревог: 2 (lead_stale)');
    });

    it('ссылка одна: второе нажатие — «уже использована», привязка не переходит к нажавшему', async () => {
      const arg = startArg((await issueLink()).link!);
      await startWith(arg, ADMIN_MAX);
      await startWith(arg, OTHER_MAX);
      expect(sent[sent.length - 1].text).toContain('уже использована');
      expect((await binding())?.max_user_id).toBe(String(ADMIN_MAX));
    });

    it('тот же человек нажал свою ссылку ещё раз — «уже подключён», без «подключали не вы»', async () => {
      const arg = startArg((await issueLink()).link!);
      await startWith(arg, ADMIN_MAX);
      await startWith(arg, ADMIN_MAX);
      const last = sent[sent.length - 1].text;
      expect(last).toContain('Этот MAX уже подключён');
      expect(last).not.toContain('подключали не вы');
    });

    it('«Отключить» снимает привязку и гасит выданную, но не нажатую ссылку', async () => {
      await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
      const pending = startArg((await issueLink()).link!);
      const { DELETE } = await import('@/app/api/admin/max-link/route');
      const res = await DELETE(new NextRequest('https://vedarai.ru/api/admin/max-link', {
        method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` },
      }));
      expect(await res.json()).toEqual({ success: true, data: { unbound: true } });
      expect(await binding()).toBeUndefined();
      await startWith(pending, OTHER_MAX);
      expect(sent[sent.length - 1].text).toContain('не найдена');
      expect(await binding()).toBeUndefined();
    });

    it('снятие роли в админке отключает MAX и гасит выданные ссылки; вернут роль — подключать заново', async () => {
      await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
      await issueLink();
      await pool.query(
        `INSERT INTO admin_tg_bindings (user_id, telegram_user_id) VALUES ($1, 880009)`,
        [adminId],
      );
      await pool.query(
        `INSERT INTO admin_tg_link_tokens (user_id, token_hash, expires_at)
         VALUES ($1, 'tg-role-off-hash', NOW() + INTERVAL '5 minutes')`,
        [adminId],
      );
      const { applyAdminRoleChange } = await import('@/lib/auth/admin-role-change');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await applyAdminRoleChange(client, adminId, 'tourist', adminId);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await binding()).toBeUndefined();
      const { rows } = await pool.query('SELECT 1 FROM admin_max_link_tokens WHERE used_at IS NULL');
      expect(rows).toHaveLength(0);
      expect((await pool.query('SELECT 1 FROM admin_tg_bindings WHERE user_id = $1', [adminId])).rows).toHaveLength(0);
      expect((await pool.query('SELECT 1 FROM admin_tg_link_tokens WHERE user_id = $1', [adminId])).rows).toHaveLength(0);
      await setAdmin(true);
      const { findMaxAdmin } = await import('@/lib/max/admin-link');
      expect(await findMaxAdmin(ADMIN_MAX)).toEqual({ outcome: 'none' });
    });

    it('новая ссылка отзывает прежнюю, непогашенную', async () => {
      const first = startArg((await issueLink()).link!);
      await issueLink();
      await startWith(first, ADMIN_MAX);
      expect(sent[sent.length - 1].text).toContain('не найдена');
      expect(await binding()).toBeUndefined();
    });

    it('просроченная ссылка — «устарела», ничего не привязано', async () => {
      const arg = startArg((await issueLink()).link!);
      await pool.query(`UPDATE admin_max_link_tokens SET expires_at = NOW() - INTERVAL '1 second'`);
      await startWith(arg, ADMIN_MAX);
      expect(sent[sent.length - 1].text).toContain('устарела');
      expect(await binding()).toBeUndefined();
    });

    it('роль снята до «Старт» — подключения нет, ссылка погашена', async () => {
      const arg = startArg((await issueLink()).link!);
      await setAdmin(false);
      await startWith(arg, ADMIN_MAX);
      expect(sent[sent.length - 1].text).toContain('больше нет роли администратора');
      expect(await binding()).toBeUndefined();
      const { rows } = await pool.query<{ used: boolean }>('SELECT used_at IS NOT NULL AS used FROM admin_max_link_tokens');
      expect(rows.map((r) => r.used)).toEqual([true]);
    });

    it('роль снята после подключения — следующий «Старт» встречает туриста, а не администратора', async () => {
      await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
      await setAdmin(false);
      sent.length = 0;
      await startWith('', ADMIN_MAX);
      expect(sent[0].text).toContain('Я Кузьмич');
      expect(sent.map((x) => x.text).join('\n')).not.toContain('администратор');
      const { findMaxAdmin } = await import('@/lib/max/admin-link');
      expect(await findMaxAdmin(ADMIN_MAX)).toEqual({ outcome: 'none' });
    });

    it('снятому администратору новая ссылка не выдаётся', async () => {
      await setAdmin(false);
      const { issueAdminMaxLink } = await import('@/lib/max/admin-link');
      expect(await issueAdminMaxLink(adminId)).toEqual({ ok: false, reason: 'not_admin' });
      const { rows } = await pool.query('SELECT 1 FROM admin_max_link_tokens');
      expect(rows).toHaveLength(0);
    });

    it('незаверенный апдейт со ссылкой ничего не привязывает и говорит это', async () => {
      vi.stubEnv('MAX_WEBHOOK_SECRET', '');
      try {
        const arg = startArg((await issueLink()).link!);
        await startWith(arg, ADMIN_MAX, false);
        const { UNVERIFIED_START_REPLY } = await import('@/lib/max/verified-press');
        expect(sent[sent.length - 1].text).toBe(UNVERIFIED_START_REPLY.admin);
        expect(await binding()).toBeUndefined();
        const { rows } = await pool.query<{ used: boolean }>('SELECT used_at IS NOT NULL AS used FROM admin_max_link_tokens');
        expect(rows.map((r) => r.used)).toEqual([false]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    // Обещание «снимут роль на сайте — снимутся и здесь» держит не только
    // applyAdminRoleChange (он стирает привязку), но и сам запрос на каждом
    // сообщении: роль могут снять и другим путём — правкой preferences.roles,
    // прямым SQL, будущим роутом, — а привязка останется. Тогда отвечать
    // перестаёт кабинет, потому что findTelegramAdmin заново читает роль.
    it('Telegram: роль снята прямым UPDATE мимо applyAdminRoleChange — привязка осталась, кабинета больше нет', async () => {
      const TG = 880_002;
      await pool.query(
        'INSERT INTO admin_tg_bindings (user_id, telegram_user_id) VALUES ($1, $2)',
        [adminId, TG],
      );
      const { findTelegramAdmin } = await import('@/lib/telegram/admin-link');
      const { handleTelegramAdminTurn, telegramAdminCallbackGate } = await import('@/lib/telegram/admin-chat');

      expect(await findTelegramAdmin(TG)).toEqual({ outcome: 'admin', userId: adminId, name: 'Админ Тест' });
      const before: string[] = [];
      const turnBefore = await handleTelegramAdminTurn({
        text: 'Что умеешь?', fromId: TG, reply: async (text) => { before.push(text); },
      });
      expect(turnBefore).toBe('handled');
      expect(before.join('\n')).toContain('Кабинет администратора');
      expect(await telegramAdminCallbackGate(TG, false)).toBe('allow');

      await setAdmin(false);
      const { rows: still } = await pool.query<{ telegram_user_id: string }>(
        'SELECT telegram_user_id::text FROM admin_tg_bindings WHERE user_id = $1', [adminId],
      );
      expect(still).toEqual([{ telegram_user_id: String(TG) }]);

      expect(await findTelegramAdmin(TG)).toEqual({ outcome: 'none' });
      const after: string[] = [];
      const turnAfter = await handleTelegramAdminTurn({
        text: 'Что умеешь?', fromId: TG, reply: async (text) => { after.push(text); },
      });
      // 'pass' — сообщение уходит обычным путём вебхука, кабинет молчит.
      expect(turnAfter).toBe('pass');
      expect(after).toEqual([]);
      expect(await telegramAdminCallbackGate(TG, false)).toBe('deny');

      // Второй путь снятия — правка preferences.roles. Администратор, который
      // переключил активную роль на туриста, ролью владеет («активная роль или
      // собственные роли», ownsAdminSql) — убрали admin из его ролей, и кабинет
      // закрылся, хотя колонку role никто не трогал.
      await pool.query(
        `UPDATE users SET role = 'tourist', preferences = jsonb_build_object('roles', '["tourist","admin"]'::jsonb) WHERE id = $1`,
        [adminId],
      );
      expect((await findTelegramAdmin(TG)).outcome).toBe('admin');
      await pool.query(
        `UPDATE users SET preferences = jsonb_build_object('roles', '["tourist"]'::jsonb) WHERE id = $1`,
        [adminId],
      );
      expect(await findTelegramAdmin(TG)).toEqual({ outcome: 'none' });
      expect(await handleTelegramAdminTurn({ text: 'Что умеешь?', fromId: TG, reply: async (text) => { after.push(text); } }))
        .toBe('pass');
      expect(after).toEqual([]);
    });

    it('Telegram: ссылка adt_ гасится, привязан человек, в базе только хеш', async () => {
      const { issueAdminTelegramLink, consumeAdminTelegramLink } = await import('@/lib/telegram/admin-link');
      const { hashAdminLinkToken } = await import('@/lib/max/admin-link');
      const issued = await issueAdminTelegramLink(adminId, 'kuzmichai_bot');
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;
      const arg = new URL(issued.link).searchParams.get('start') ?? '';
      expect(arg).toMatch(/^adt_[A-Za-z0-9_-]{32}$/);
      const token = arg.slice('adt_'.length);
      const { rows: stored } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM admin_tg_link_tokens');
      expect(stored).toHaveLength(1);
      expect(stored[0].token_hash).toBe(hashAdminLinkToken(token));
      expect(stored[0].token_hash).not.toContain(token);

      const consumed = await consumeAdminTelegramLink(token, 880_001);
      expect(consumed).toEqual({ ok: true, userId: adminId, movedFromUserId: null });
      const bound = await pool.query<{ telegram_user_id: string }>(
        'SELECT telegram_user_id::text FROM admin_tg_bindings WHERE user_id = $1',
        [adminId],
      );
      expect(bound.rows[0]?.telegram_user_id).toBe('880001');

      const again = await consumeAdminTelegramLink(token, 880_001);
      expect(again).toEqual({ ok: false, reason: 'already_yours' });
    });
  });
});
