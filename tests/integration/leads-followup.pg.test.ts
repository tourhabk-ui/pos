/**
 * Крон добивки лидов на настоящем PostgreSQL: адресованная заявка другому
 * партнёру не уходит (решение владельца 13.10 «да, только без адресата», #2447).
 *
 * До 13.10 отбор брал все `new` старше 2 часов. Заявка на машину перевозчика
 * (адресат — перевозчик, интересов нет) через 2 часа уходила запасной веткой
 * «любой оператор» с именем и телефоном человека; заявка на тур — оператору
 * с той же активностью, то есть конкуренту. Мок ответил бы на любой SQL,
 * поэтому сцена разыгрывается на схеме baseline прода плюс всех миграций, а
 * крон вызывается целиком — своим обработчиком, с настоящими запросами к
 * partners и operator_tours. Подменена только отправка в мессенджер.
 *
 * Сцена:
 *   оператор A — с каналом MAX и туром «hiking» (тот, кому крон отдаёт);
 *   оператор B — адресат заявки на тур, канала нет;
 *   перевозчик C — адресат заявки на машину;
 *   перевозчик D — адресат заявки на машину, затем удалён: внешний ключ
 *     `ON DELETE SET NULL` обнуляет адресата, и заявка выглядит «без адресата»;
 *   L1 — без адресата, 3 часа, интерес «hiking»   → уходит A;
 *   L2 — машина C, 3 часа, интересов нет          → остаётся у C;
 *   L3 — тур B, 3 часа, интерес «hiking»          → остаётся у B;
 *   L4 — без адресата, 30 минут                   → ещё рано;
 *   L5 — машина удалённого D, 3 часа              → не уходит никому (род
 *     заявки и согласие «перевозчику» — второй замок отбора);
 *   L6 — псевдолид чата виджета (до 15.10): `Widget: mestechko`, телефона
 *     нет, `source_data.type = 'widget'`, без адресата, 3 часа → не заявка:
 *     ни добивке, ни счёту сторожа «лиды >2ч» (аудит 15.10, WID-safety);
 *   прокатчик E — адресат заявки на прокат автомобиля (23.10, схема 1317);
 *   прокатчик F — адресат заявки на прокат, затем удалён (адресат обнулён);
 *   L7 — прокат E, 3 часа                         → остаётся у E;
 *   L8 — прокат удалённого F, 3 часа              → не уходит никому (род
 *     `car_rental` и согласие «прокату автомобилей» — тот же второй замок).
 *
 * Вторая часть (аудит 15.10, W3-pseudo) — остальные читатели `new`, где
 * псевдолид рождает тревогу или работу модели: счёт «лидов без обработки
 * > 6ч» у крона health и команды /health админ-бота, «лидов без ответа >24ч»
 * у рассылки bulk_notify, очередь дайджеста, конвейер leads-process, пакет
 * process-batch и квалификация LeadAgency. К сцене добавляются настоящие
 * заявки R1–R4 и псевдолиды P1–P2 старше 6 и 24 часов, и каждый читатель
 * вызывается целиком — своим кодом, на этих строках. Подменены только
 * модель, конвейер ИИ и отправка в Telegram: судится отбор, а не они.
 *
 * Своя база `leads_followup_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PD_CONSENT_CARRIER_VERSION, PD_CONSENT_RENTAL_VERSION } from '@/lib/legal/pd-consent';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: vi.fn(async () => ({ channel: 'max', delivered: true, reason: 'test' })),
}));

// Модель не зовётся: читателям нужен ответ, судится то, ЧТО им отобрано.
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    callAIWithModel: vi.fn(async () => ({ text: '{"analysis":[],"recommendation":""}', model_used: 'test' })),
    callAIWithModelDirect: vi.fn(async () => 'Оценка дня: тест'),
    callDeepSeek: vi.fn(async () => 'ок'),
    callQwen: vi.fn(async () => 'ок'),
    callXai: vi.fn(async () => 'ок'),
    callOpenrouter: vi.fn(async () => 'ок'),
  };
});

// Конвейер ИИ подменён: крон leads-process судится по тому, кого он ВЗЯЛ.
vi.mock('@/lib/services/operators/lead-processor.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/operators/lead-processor.service')>();
  return { ...actual, leadProcessor: { process: vi.fn(async () => ({})) } };
});

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[leads-followup.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'leads_followup_test';
const CRON_SECRET = 'leads-followup-test-secret';
const A_MAX_CHAT = '7000001';

withPg('крон добивки лидов на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  const ids = { l1: '', l2: '', l3: '', l4: '', l5: '', l6: '', l7: '', l8: '' };

  beforeAll(async () => {
    const { Pool } = await import('pg');
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });

    // Крон читает пул приложения — ему нужен тот же адрес.
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.CRON_SECRET = CRON_SECRET;

    const partner = async (name: string, category: string, slug: string, maxChat: string | null) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, max_chat_id)
         VALUES ($1, $2, '{"phone":"+70000000000"}', TRUE, TRUE, $3, $4::bigint) RETURNING id`,
        [name, category, slug, maxChat],
      );
      return r.rows[0].id;
    };
    const a = await partner('Оператор А', 'operator', 'op-a', A_MAX_CHAT);
    const b = await partner('Оператор Б', 'operator', 'op-b', null);
    const c = await partner('Перевозчик В', 'transfer', 'carrier-c', null);
    const d = await partner('Перевозчик Г', 'transfer', 'carrier-d', null);
    const e = await partner('Прокат Д', 'cars', 'rental-e', null);
    const f = await partner('Прокат Е', 'cars', 'rental-f', null);
    for (const operatorId of [a, b]) {
      await pool.query(
        `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, difficulty, duration_hours)
         VALUES ($1, 'Вулкан Горелый', 15000, 10, TRUE, TRUE, 'hiking', 'easy', 8)`,
        [operatorId],
      );
    }

    const lead = async (name: string, operatorId: string | null, age: string, sourceData: object, consent: string | null = null) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO leads (name, phone, comment, status, operator_id, source_data, created_at, pd_consent_version)
         VALUES ($1, '+79990001122', 'тест', 'new', $2, $3::jsonb, NOW() - $4::interval, $5) RETURNING id::text AS id`,
        [name, operatorId, JSON.stringify(sourceData), age, consent],
      );
      return r.rows[0].id;
    };
    ids.l1 = await lead('Без адресата', null, '3 hours', { interests: ['hiking'] });
    ids.l2 = await lead('Заказчик машины', c, '3 hours', { kind: 'charter' }, PD_CONSENT_CARRIER_VERSION);
    ids.l3 = await lead('Заявка на тур Б', b, '3 hours', { interests: ['hiking'] });
    ids.l4 = await lead('Свежая без адресата', null, '30 minutes', {});
    ids.l5 = await lead('Машина удалённого', d, '3 hours', { kind: 'charter' }, PD_CONSENT_CARRIER_VERSION);
    await pool.query(`DELETE FROM partners WHERE id = $1`, [d]);
    ids.l7 = await lead('Арендатор машины', e, '3 hours', { kind: 'car_rental' }, PD_CONSENT_RENTAL_VERSION);
    ids.l8 = await lead('Прокат удалённого', f, '3 hours', { kind: 'car_rental' }, PD_CONSENT_RENTAL_VERSION);
    await pool.query(`DELETE FROM partners WHERE id = $1`, [f]);
    // Так его писал чат виджета до 15.10: createLead без телефона и согласия.
    const pseudo = await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status, operator_id, source_data, source_channel, created_at)
       VALUES ('Widget: mestechko', '', 'Какие туры на вертолёте?', 'new', NULL,
               '{"type":"widget","partner_id":"mestechko","partner_name":"Местечко Камчатка"}'::jsonb,
               'widget', NOW() - INTERVAL '3 hours') RETURNING id::text AS id`,
    );
    ids.l6 = pseudo.rows[0].id;
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('отбор берёт только лид без адресата и старше 2 часов', async () => {
    // Предпосылка второго замка: у заявки удалённого перевозчика адресата больше нет.
    const orphan = await pool.query<{ operator_id: string | null }>(
      `SELECT operator_id::text AS operator_id FROM leads WHERE id = ANY($1::uuid[])`, [[ids.l5, ids.l8]],
    );
    expect(orphan.rows.map((r) => r.operator_id)).toEqual([null, null]);

    const { FOLLOWUP_LEADS_SQL, FOLLOWUP_LEADS_PARAMS } = await import('@/lib/leads/followup-scope');
    const { rows } = await pool.query<{ id: string }>(FOLLOWUP_LEADS_SQL, [...FOLLOWUP_LEADS_PARAMS]);
    expect(rows.map((r) => r.id)).toEqual([ids.l1]);
  });

  it('крон отдаёт оператору только лид без адресата; заявки на машину и на чужой тур не трогает', async () => {
    const { sendPdAlert } = await import('@/lib/notifications/pd-alert');
    const send = vi.mocked(sendPdAlert);
    send.mockClear();

    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/cron/leads-followup/route');
    const res = await GET(new NextRequest('http://localhost/api/cron/leads-followup', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; leads_found: number; processed: number };
    expect(body.ok).toBe(true);
    expect(body.leads_found).toBe(1);
    expect(body.processed).toBe(1);

    // Ровно одно сообщение — оператору A, и в нём лид без адресата.
    expect(send).toHaveBeenCalledTimes(1);
    const params = send.mock.calls[0][0];
    expect(params.to?.maxChatId).toBe(A_MAX_CHAT);
    expect(params.text).toContain('Без адресата');
    expect(params.text).not.toContain('Заказчик машины');
    expect(params.text).not.toContain('Заявка на тур Б');
    expect(params.text).not.toContain('Машина удалённого');
    expect(params.text).not.toContain('Арендатор машины');
    expect(params.text).not.toContain('Прокат удалённого');
    expect(params.text).not.toContain('Widget: mestechko');

    const state = await pool.query<{ id: string; status: string; notified: unknown; last_followup: string | null }>(
      `SELECT id::text AS id, status, source_data->'notified_operators' AS notified,
              source_data->>'last_followup' AS last_followup
         FROM leads WHERE id = ANY($1::uuid[]) ORDER BY name`,
      [[ids.l1, ids.l2, ids.l3, ids.l5, ids.l6, ids.l7, ids.l8]],
    );
    const byId = new Map(state.rows.map((r) => [r.id, r]));
    expect(byId.get(ids.l1)?.notified).toEqual(['op-a']);
    for (const addressed of [ids.l2, ids.l3, ids.l5, ids.l6, ids.l7, ids.l8]) {
      expect(byId.get(addressed)?.status).toBe('new');
      expect(byId.get(addressed)?.notified).toBeNull();
      expect(byId.get(addressed)?.last_followup).toBeNull();
    }
  });

  it('предикат псевдолида узкий: NULL в полях и настоящие заявки виджета не задевает', async () => {
    // Отбор выполняется настоящим PostgreSQL на литеральных строках: NULL в
    // source_data, phone или name под NOT дал бы NULL — строка выпала бы из
    // отбора добивки и счёта сторожа молча.
    const { WIDGET_CHAT_PSEUDO_LEAD_SQL } = await import('@/lib/leads/widget-chat-pseudo');
    const { rows } = await pool.query<{ label: string; excluded: boolean }>(
      `SELECT label, ${WIDGET_CHAT_PSEUDO_LEAD_SQL} AS excluded
         FROM (VALUES
           ('псевдолид чата',          '{"type":"widget"}'::jsonb,           ''::text,           'Widget: mestechko'::text),
           ('псевдолид, телефон NULL', '{"type":"widget"}'::jsonb,           NULL,               'Widget: fishingkam'),
           ('все поля NULL',           NULL::jsonb,                          NULL,               NULL),
           ('форма виджета',           '{"source":"partner_widget"}'::jsonb, '+79990001122',     'Анна'),
           ('тип widget с телефоном',  '{"type":"widget"}'::jsonb,           '+79990001122',     'Widget: mestechko'),
           ('тип widget, своё имя',    '{"type":"widget"}'::jsonb,           '',                 'Анна')
         ) AS leads(label, source_data, phone, name)`,
    );
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.excluded]));
    expect(byLabel).toEqual({
      'псевдолид чата': true,
      'псевдолид, телефон NULL': true,
      'все поля NULL': false,
      'форма виджета': false,
      'тип widget с телефоном': false,
      'тип widget, своё имя': false,
    });
  });

  it('сторож «лиды >2ч» не считает псевдолид чата виджета', async () => {
    const { UNATTENDED_LEAD_STATUSES } = await import('@/lib/types/statuses');
    const all = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM leads
        WHERE status = ANY($1::text[]) AND created_at < NOW() - INTERVAL '2 hours'`,
      [[...UNATTENDED_LEAD_STATUSES]],
    );
    // Предпосылка: псевдолид в сцене есть и сам по себе попал бы в счёт.
    const pseudo = await pool.query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [ids.l6]);
    expect(UNATTENDED_LEAD_STATUSES).toContain(pseudo.rows[0]?.status);

    const { runWatchdog } = await import('@/lib/agents/watchdog');
    const result = await runWatchdog();
    const alert = result.alerts.find((a) => a.type === 'unprocessed_lead');
    expect(alert?.count).toBe(all.rows[0].n - 1);
    // Проверка выполнилась, а не упала: «не смог» здесь — не «хорошо».
    expect(result.checks.failed.map((f) => f.check)).not.toContain('checkUnprocessedLeads');
  }, 120_000);

  it('сторож «лиды >2ч»: ответ партнёра клиенту в переписке по заявке — реакция (1350)', async () => {
    const { runWatchdog } = await import('@/lib/agents/watchdog');
    const lead = await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status, created_at)
       VALUES ('Клиент переписки', '+79990004455', 'вахтовка на перевал', 'new', NOW() - INTERVAL '3 hours') RETURNING id::text AS id`,
    );
    const count = async () => (await runWatchdog()).alerts.find((a) => a.type === 'unprocessed_lead')?.count ?? 0;
    const before = await count();
    await pool.query(
      `INSERT INTO request_messages (lead_id, author, door, body) VALUES ($1::uuid, 'owner', 'max', 'Подача в 7:00')`,
      [lead.rows[0].id],
    );
    expect(await count()).toBe(before - 1);
    // Сообщение клиента — не реакция партнёра.
    await pool.query(`DELETE FROM request_messages WHERE lead_id = $1::uuid`, [lead.rows[0].id]);
    await pool.query(
      `INSERT INTO request_messages (lead_id, author, door, body) VALUES ($1::uuid, 'guest', 'page', 'Есть новости?')`,
      [lead.rows[0].id],
    );
    expect(await count()).toBe(before);
    await pool.query(`DELETE FROM leads WHERE id = $1::uuid`, [lead.rows[0].id]);
  }, 120_000);

  // Аудит 15.10, W3-pseudo. Строки добавляются ПОСЛЕ тестов выше: отбор
  // добивки там сверяется с точным набором, а здесь нужны лиды старше 6 и
  // 24 часов. Ожидаемое число считается по известным id псевдолидов, а не
  // тем же предикатом: иначе сторож сверял бы правило само с собой.
  describe('прочие читатели new: псевдолид не тревога и не работа модели', () => {
    const real: string[] = [];
    const pseudo: string[] = [];
    const realComments: string[] = [];
    const pseudoComments: string[] = ['Какие туры на вертолёте?'];

    /** Сколько лидов под условием — всего и без псевдолидов (по id). */
    const countWithAndWithout = async (where: string) => {
      const { rows } = await pool.query<{ total: number; honest: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE NOT (id = ANY($1::uuid[])))::int AS honest
           FROM leads WHERE ${where}`,
        [pseudo],
      );
      return rows[0];
    };

    beforeAll(async () => {
      pseudo.push(ids.l6);
      const insertReal = async (label: string, age: string) => {
        const comment = `Настоящая заявка ${label}: группа 4 человека, август`;
        const r = await pool.query<{ id: string }>(
          `INSERT INTO leads (name, phone, comment, status, operator_id, source_data, created_at)
           VALUES ($1, '+79990003344', $2, 'new', NULL, '{"source":"route_page"}'::jsonb, NOW() - $3::interval)
           RETURNING id::text AS id`,
          [`Турист ${label}`, comment, age],
        );
        real.push(r.rows[0].id);
        realComments.push(comment);
      };
      const insertPseudo = async (label: string, age: string) => {
        const comment = `Вопрос из чата ${label}: есть ли рыбалка?`;
        const r = await pool.query<{ id: string }>(
          `INSERT INTO leads (name, phone, comment, status, operator_id, source_data, source_channel, created_at)
           VALUES ('Widget: fishingkam', '', $1, 'new', NULL,
                   '{"type":"widget","partner_id":"fishingkam"}'::jsonb, 'widget', NOW() - $2::interval)
           RETURNING id::text AS id`,
          [comment, age],
        );
        pseudo.push(r.rows[0].id);
        pseudoComments.push(comment);
      };
      await insertReal('R1', '25 hours');
      await insertPseudo('P1', '25 hours');
      await insertReal('R2', '25 hours');
      await insertReal('R3', '7 hours');
      await insertPseudo('P2', '7 hours');
      await insertReal('R4', '7 hours');
    });

    it('крон health: «лидов без обработки > 6ч» — только настоящие заявки', async () => {
      const n = await countWithAndWithout(`status = 'new' AND created_at < NOW() - INTERVAL '6 hours'`);
      // Предпосылки: псевдолиды в окне есть, а настоящих больше порога (3),
      // так что тревога обязана прозвучать — и назвать именно их число.
      expect(n.total - n.honest).toBe(2);
      expect(n.honest).toBeGreaterThan(3);

      const { checkDB } = await import('@/app/api/cron/health/route');
      const issues = await checkDB();
      const leadIssues = issues.filter((i) => i.text.includes('лидов без обработки'));
      expect(leadIssues.map((i) => i.text)).toEqual([
        `${n.honest} лидов без обработки > 6ч (leads-followup?)`,
      ]);
    });

    it('команда /health админ-бота считает так же, как крон health', async () => {
      const n = await countWithAndWithout(`status = 'new' AND created_at < NOW() - INTERVAL '6 hours'`);
      const sent: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
        if (body.text) sent.push(body.text);
        return new Response('{"ok":true}', { status: 200 });
      });
      const prevToken = process.env.TELEGRAM_BOT_TOKEN;
      const prevOwner = process.env.TELEGRAM_OWNER_ID;
      const prevCron = process.env.CRON_SECRET;
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_OWNER_ID = '1';
      // GET админ-бота — только с CRON_SECRET (25.10: анонимный GET публиковал в каналы).
      process.env.CRON_SECRET = 'cron-secret-for-pg-test';
      try {
        const { NextRequest } = await import('next/server');
        const { GET } = await import('@/app/api/telegram/admin/route');
        const res = await GET(new NextRequest('http://localhost/api/telegram/admin?command=health', {
          headers: { 'x-forwarded-for': '10.0.0.7', authorization: 'Bearer cron-secret-for-pg-test' },
        }));
        expect(res.status).toBe(200);
      } finally {
        fetchSpy.mockRestore();
        if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevToken;
        if (prevOwner === undefined) delete process.env.TELEGRAM_OWNER_ID; else process.env.TELEGRAM_OWNER_ID = prevOwner;
        if (prevCron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevCron;
      }
      const report = sent.find((t) => t.includes('БД:'));
      expect(report).toBeDefined();
      expect(report).toContain(`${n.honest} лидов без обработки > 6ч`);
      expect(report).not.toContain('Не смог проверить лиды');
    });

    it('рассылка bulk_notify: «лидов без ответа >24ч» — только настоящие заявки', async () => {
      const n = await countWithAndWithout(
        `status IN ('new','contacted') AND created_at < NOW() - INTERVAL '24 hours'`,
      );
      expect(n.total - n.honest).toBe(1);
      expect(n.honest).toBeGreaterThan(0);

      const sent: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
        if (body.text) sent.push(body.text);
        return new Response('{"ok":true}', { status: 200 });
      });
      const prevToken = process.env.TELEGRAM_BOT_TOKEN;
      const prevChat = process.env.TELEGRAM_CHAT_ID;
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '1';
      try {
        const { executeInitiativeEffect } = await import('@/lib/agents/execution/initiative-executor');
        await executeInitiativeEffect({
          approval_id: '00000000-0000-4000-8000-000000000001',
          executor_agent_id: 'admin',
          action_type: 'bulk_notify',
          description: 'сторож W3-pseudo',
          context: {},
          due_date: new Date().toISOString(),
        });
      } finally {
        fetchSpy.mockRestore();
        if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevToken;
        if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prevChat;
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(`Лидов без ответа (&gt;24ч): <b>${n.honest}</b>`);
    });

    it('дайджест: очередь «Новые (не обработаны)» и список для модели — без псевдолидов', async () => {
      const n = await countWithAndWithout(`status = 'new'`);
      expect(n.total - n.honest).toBe(pseudo.length);

      const { callAIWithModelDirect } = await import('@/lib/ai/providers');
      const ai = vi.mocked(callAIWithModelDirect);
      ai.mockClear();

      const { NextRequest } = await import('next/server');
      const { GET } = await import('@/app/api/cron/digest/route');
      const res = await GET(new NextRequest('http://localhost/api/cron/digest', {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; leadsNew: number };
      expect(body.leadsNew).toBe(n.honest);

      expect(ai).toHaveBeenCalledTimes(1);
      const prompt = ai.mock.calls[0][0].map((m) => m.content).join('\n');
      expect(prompt).toContain(`Новые (не обработаны): ${n.honest}`);
      for (const id of pseudo) expect(prompt).not.toContain(id.slice(0, 8));
    });

    it('конвейер leads-process берёт настоящие заявки и не берёт псевдолиды', async () => {
      const { leadProcessor } = await import('@/lib/services/operators/lead-processor.service');
      const processed = vi.mocked(leadProcessor.process);
      processed.mockClear();

      const { NextRequest } = await import('next/server');
      const { GET } = await import('@/app/api/cron/leads-process/route');
      const res = await GET(new NextRequest('http://localhost/api/cron/leads-process', {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }));
      expect(res.status).toBe(200);
      const taken = processed.mock.calls.map((c) => c[0]);
      // Положительный контроль: самые старые настоящие заявки взяты — отбор
      // работает, а не молча вернул ноль.
      expect(taken).toEqual(expect.arrayContaining(real));
      for (const id of pseudo) expect(taken).not.toContain(id);
    });

    it('пакет /api/admin/leads/process-batch не отдаёт псевдолиды модели', async () => {
      const { NextRequest } = await import('next/server');
      const { POST } = await import('@/app/api/admin/leads/process-batch/route');
      const res = await POST(new NextRequest('http://localhost/api/admin/leads/process-batch', {
        method: 'POST',
        headers: { 'x-cron-secret': CRON_SECRET, 'content-type': 'application/json' },
        // dryRun: отбор тот же, что у боевого прогона, модель не зовётся.
        body: JSON.stringify({ limit: 50, status: 'new', dryRun: true }),
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { results: Array<{ leadId: string }> };
      const taken = body.results.map((r) => String(r.leadId));
      expect(taken).toEqual(expect.arrayContaining(real));
      for (const id of pseudo) expect(taken).not.toContain(id);
    });

    it('квалификация LeadAgency: в промпт идут только настоящие заявки', async () => {
      const n = await countWithAndWithout(`status = 'new'`);
      const { callAIWithModel } = await import('@/lib/ai/providers');
      const ai = vi.mocked(callAIWithModel);
      ai.mockClear();

      const { LeadAgency } = await import('@/lib/agents/agencies/lead-agency');
      const result = await new LeadAgency().qualifyLeads({ limit: 100 });
      expect(result).toMatchObject({ analyzed: n.honest });

      expect(ai).toHaveBeenCalledTimes(1);
      const prompt = ai.mock.calls[0][0].map((m) => m.content).join('\n');
      for (const c of realComments) expect(prompt).toContain(c);
      for (const c of pseudoComments) expect(prompt).not.toContain(c);
    });
  });
});
