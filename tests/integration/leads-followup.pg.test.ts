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
 *     ни добивке, ни счёту сторожа «лиды >2ч» (аудит 15.10, WID-safety).
 *
 * Своя база `leads_followup_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PD_CONSENT_CARRIER_VERSION } from '@/lib/legal/pd-consent';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: vi.fn(async () => ({ channel: 'max', delivered: true, reason: 'test' })),
}));

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
  const ids = { l1: '', l2: '', l3: '', l4: '', l5: '', l6: '' };

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
      `SELECT operator_id::text AS operator_id FROM leads WHERE id = $1`, [ids.l5],
    );
    expect(orphan.rows[0]?.operator_id).toBeNull();

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
    expect(params.text).not.toContain('Widget: mestechko');

    const state = await pool.query<{ id: string; status: string; notified: unknown; last_followup: string | null }>(
      `SELECT id::text AS id, status, source_data->'notified_operators' AS notified,
              source_data->>'last_followup' AS last_followup
         FROM leads WHERE id = ANY($1::uuid[]) ORDER BY name`,
      [[ids.l1, ids.l2, ids.l3, ids.l5, ids.l6]],
    );
    const byId = new Map(state.rows.map((r) => [r.id, r]));
    expect(byId.get(ids.l1)?.notified).toEqual(['op-a']);
    for (const addressed of [ids.l2, ids.l3, ids.l5, ids.l6]) {
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
});
