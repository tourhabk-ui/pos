/**
 * Модель не пишет тексты мест, а уже написанное ею снято с карточек — слово
 * владельца 22.10: «отключи агента выдумывающкюего описание мест такую пургу
 * придумал», затем «1 да» на «снять с карточек описания, которые уже написала
 * модель». На настоящем PostgreSQL.
 *
 * Здесь судится то, что решает сервер, а мок ответил бы на любой SQL:
 *  - очередь Editor (одна на прод и раннер: editor-job отдаёт её раннеру,
 *    editor-result по ней же сверяет присланный id) идёт через VIEW
 *    agent_route_knowledge: из места и маршрута без описания встаёт только
 *    маршрут (выключатель — lib/places/model-place-text.ts);
 *  - миграция 1309 снимает ровно те описания, что карточка подписывает
 *    «написала модель» (`descriptionWrittenByModel`): её SQL не копия
 *    правила, а сверяется с ним здесь на каждом случае, и повтор ничего не
 *    меняет.
 *
 * Своя база `model_place_text_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { descriptionWrittenByModel } from '@/lib/places/description-by-model';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[model-place-text.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'model_place_text_test';
const MIGRATION_1309 = readFileSync(join(process.cwd(), 'migrations/1309_place_model_descriptions_withdrawn.sql'), 'utf-8');

withPg('модель не пишет тексты мест (слово владельца 22.10)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    await pool.query('TRUNCATE places, kamchatka_routes, description_provenance, editor_no_write CASCADE');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  async function place(name: string, description: string | null, withdrawn: string | null = null): Promise<string> {
    const r = await pool.query<{ ark_id: string }>(
      `INSERT INTO places (id, ark_id, name, slug, lat, lng, is_visible, location_type, description, description_withdrawn)
       VALUES (gen_random_uuid()::text, gen_random_uuid(), $1::text, $1::text, 53.1, 158.4, TRUE, 'lake', $2, $3)
       RETURNING ark_id::text`,
      [name, description, withdrawn],
    );
    return r.rows[0].ark_id;
  }

  /** Запись журнала происхождения; minutesAgo задаёт порядок записей. */
  async function wrote(ark: string, by: string, chars: number, minutesAgo: number): Promise<void> {
    await pool.query(
      `INSERT INTO description_provenance (entity_id, entity_kind, written_by, chars, written_at)
       VALUES ($1::uuid, 'place', $2, $3, NOW() - make_interval(mins => $4))`,
      [ark, by, chars, minutesAgo],
    );
  }

  describe('очередь Editor', () => {
    let placeArk = '';
    let routeArk = '';

    beforeAll(async () => {
      placeArk = await place('Озеро без описания', null);
      const r = await pool.query<{ ark: string }>(
        `INSERT INTO kamchatka_routes (category, title, is_visible, description)
         VALUES ('trekking', 'Тропа без описания', TRUE, NULL)
         RETURNING COALESCE(ark_id, id)::text AS ark`,
      );
      routeArk = r.rows[0].ark;
    });

    it('оба пустых видны в VIEW — сцена честная', async () => {
      const { rows } = await pool.query<{ kind: string }>(
        `SELECT kind FROM agent_route_knowledge WHERE id::text = ANY($1::text[])`,
        [[placeArk, routeArk]],
      );
      expect(rows.map((r) => r.kind).sort()).toEqual(['place', 'route']);
    });

    it('берёт маршрут и не берёт место', async () => {
      const { findRoutesNeedingDescription } = await import('@/lib/agents/editor');
      const queue = await findRoutesNeedingDescription();
      const ids = queue.map((r) => String(r.id));
      expect(ids).toContain(routeArk);
      expect(ids).not.toContain(placeArk);
      expect(queue.every((r) => r.kind !== 'place')).toBe(true);
    });
  });

  // Короткое описание Editor переписывает, только если это его собственный
  // текст (23.10, владелец: «Editor много выдумал его ужесточить»). Чужой
  // короткий текст — из паспорта, миграции, от человека — ответ, а не
  // недоработка: дописать его можно только выдумкой.
  describe('очередь Editor: короткое — только своё', () => {
    const SHORT = 'Тропа к озеру, протяжённость 6 километров, сезон — лето.';
    const ids: Record<string, string> = {};

    async function shortRoute(title: string, daysAgo: number): Promise<string> {
      const r = await pool.query<{ ark: string }>(
        `INSERT INTO kamchatka_routes (category, title, is_visible, description, updated_at)
         VALUES ('trekking', $1::text, TRUE, $2::text, NOW() - make_interval(days => $3))
         RETURNING COALESCE(ark_id, id)::text AS ark`,
        [title, SHORT, daysAgo],
      );
      return r.rows[0].ark;
    }

    async function routeWrote(ark: string, by: string, chars: number, minutesAgo: number): Promise<void> {
      await pool.query(
        `INSERT INTO description_provenance (entity_id, entity_kind, written_by, chars, written_at)
         VALUES ($1::uuid, 'route', $2, $3, NOW() - make_interval(mins => $4))`,
        [ark, by, chars, minutesAgo],
      );
    }

    beforeAll(async () => {
      ids.ownProd = await shortRoute('Свой текст Editor', 30);
      await routeWrote(ids.ownProd, 'editor-ai', SHORT.length, 5);
      ids.ownRunner = await shortRoute('Свой текст раннера', 30);
      await routeWrote(ids.ownRunner, 'editor-ai-runner:some-model', SHORT.length, 5);
      ids.noJournal = await shortRoute('Текст из миграции', 30);
      ids.edited = await shortRoute('Текст модели, правленный человеком', 30);
      await routeWrote(ids.edited, 'editor-ai', SHORT.length + 12, 5);
      ids.human = await shortRoute('Текст администратора', 30);
      await routeWrote(ids.human, 'admin:1', SHORT.length, 5);
      ids.owner = await shortRoute('Решение владельца после модели', 30);
      await routeWrote(ids.owner, 'editor-ai', SHORT.length, 30);
      await routeWrote(ids.owner, 'owner-decision', SHORT.length, 5);
      ids.fresh = await shortRoute('Свой текст, ещё не отдохнул', 1);
      await routeWrote(ids.fresh, 'editor-ai', SHORT.length, 5);
    });

    it('сцена честная: все короткие маршруты видны в VIEW с переданной датой', async () => {
      const { rows } = await pool.query<{ id: string; old: boolean }>(
        `SELECT id::text, updated_at < NOW() - INTERVAL '7 days' AS old
           FROM agent_route_knowledge WHERE id::text = ANY($1::text[])`,
        [Object.values(ids)],
      );
      expect(rows).toHaveLength(Object.keys(ids).length);
      expect(rows.find((r) => r.id === ids.fresh)?.old).toBe(false);
      expect(rows.find((r) => r.id === ids.ownProd)?.old).toBe(true);
    });

    it('отбор по присланным id — только из очереди и только эти', async () => {
      const { findRoutesNeedingDescription } = await import('@/lib/agents/editor');
      const got = (await findRoutesNeedingDescription([ids.ownProd, ids.human])).map((r) => String(r.id));
      expect(got).toEqual([ids.ownProd]);
      expect(await findRoutesNeedingDescription([])).toEqual([]);
    });

    it('берёт только собственный отдохнувший текст модели', async () => {
      const { findRoutesNeedingDescription } = await import('@/lib/agents/editor');
      const queue = new Set((await findRoutesNeedingDescription()).map((r) => String(r.id)));
      expect(queue.has(ids.ownProd)).toBe(true);
      expect(queue.has(ids.ownRunner)).toBe(true);
      for (const key of ['noJournal', 'edited', 'human', 'owner', 'fresh']) {
        expect({ key, inQueue: queue.has(ids[key]) }).toEqual({ key, inQueue: false });
      }
    });
  });

  // «НЕТ» модели и отказ проверки правды строку не меняют; без отметки она
  // возвращалась бы на каждом прогоне (ревью 23.10, миграция 1322).
  describe('очередь Editor: не описал — отдыхает', () => {
    const rest: Record<string, string> = {};

    async function emptyRoute(title: string): Promise<string> {
      const r = await pool.query<{ ark: string }>(
        `INSERT INTO kamchatka_routes (category, title, is_visible, description)
         VALUES ('trekking', $1::text, TRUE, NULL)
         RETURNING COALESCE(ark_id, id)::text AS ark`,
        [title],
      );
      return r.rows[0].ark;
    }

    beforeAll(async () => {
      rest.declinedNow = await emptyRoute('Отказ сегодня');
      rest.declinedOld = await emptyRoute('Отказ неделю назад');
      rest.rejectedByRunner = await emptyRoute('Раннер: выдумка');
      rest.declinedByRunner = await emptyRoute('Раннер: НЕТ');
      const { recordEditorNoWrite } = await import('@/lib/agents/editor');
      await recordEditorNoWrite({ id: rest.declinedNow, kind: 'route' }, 'declined', 'модель: нечего написать', 'editor-ai', 2);
      await recordEditorNoWrite({ id: rest.declinedOld, kind: 'route' }, 'declined', 'модель: нечего написать', 'editor-ai', 2);
      await pool.query(
        `UPDATE editor_no_write SET attempted_at = NOW() - INTERVAL '8 days' WHERE entity_id = $1::uuid`,
        [rest.declinedOld],
      );
    });

    it('свежий отказ не берётся, отказ старше недели — берётся снова', async () => {
      const { findRoutesNeedingDescription } = await import('@/lib/agents/editor');
      const queue = new Set((await findRoutesNeedingDescription()).map((r) => String(r.id)));
      expect(queue.has(rest.declinedNow)).toBe(false);
      expect(queue.has(rest.declinedOld)).toBe(true);
    });

    it('повторная отметка обновляет одну строку, а не копит историю', async () => {
      const { recordEditorNoWrite } = await import('@/lib/agents/editor');
      await recordEditorNoWrite({ id: rest.declinedNow, kind: 'route' }, 'truth_rejected', 'слова не из источника', 'editor-ai', 3);
      const { rows } = await pool.query<{ n: string; outcome: string }>(
        `SELECT COUNT(*)::text AS n, MAX(outcome) AS outcome FROM editor_no_write WHERE entity_id = $1::uuid`,
        [rest.declinedNow],
      );
      expect(rows[0]).toEqual({ n: '1', outcome: 'truth_rejected' });
    });

    it('приёмник раннера ставит на отдых «НЕТ» и текст, отвергнутый проверкой правды', async () => {
      process.env.CRON_SECRET = 'test-cron-secret';
      const { NextRequest } = await import('next/server');
      const { POST } = await import('@/app/api/cron/editor-result/route');
      const res = await POST(new NextRequest('http://localhost/api/cron/editor-result', {
        method: 'POST',
        headers: { authorization: 'Bearer test-cron-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          items: [{
            id: rest.rejectedByRunner,
            description: 'Тропа идёт через березняк, с перевала открываются красивые виды на долину и озёра.',
          }],
          declined: [rest.declinedByRunner],
        }),
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { written: number; rejected: Array<{ id: string; reason: string }>; declined_noted: number };
      expect(body.written).toBe(0);
      expect(body.rejected.map((r) => r.id)).toEqual([rest.rejectedByRunner]);
      expect(body.rejected[0].reason).toContain('проверка правды');
      expect(body.declined_noted).toBe(1);

      const { rows } = await pool.query<{ entity_id: string; outcome: string; attempted_by: string }>(
        `SELECT entity_id::text, outcome, attempted_by FROM editor_no_write
          WHERE entity_id = ANY($1::uuid[]) ORDER BY outcome`,
        [[rest.rejectedByRunner, rest.declinedByRunner]],
      );
      expect(rows).toEqual([
        { entity_id: rest.declinedByRunner, outcome: 'declined', attempted_by: 'editor-ai-runner:test-model' },
        { entity_id: rest.rejectedByRunner, outcome: 'truth_rejected', attempted_by: 'editor-ai-runner:test-model' },
      ]);

      const { findRoutesNeedingDescription } = await import('@/lib/agents/editor');
      const queue = new Set((await findRoutesNeedingDescription()).map((r) => String(r.id)));
      expect(queue.has(rest.rejectedByRunner)).toBe(false);
      expect(queue.has(rest.declinedByRunner)).toBe(false);
    });
  });

  describe('миграция 1309 — правилом карточки «написала модель»', () => {
    const TEXT = 'Озеро в кальдере, вода холодная круглый год, берег каменистый.';
    const EDITED = `${TEXT} Правлено человеком.`;
    interface Case { name: string; ark: string; before: string | null; last: { by: string | null; chars: number | null } | null; archived?: string }
    const cases: Case[] = [];

    beforeAll(async () => {
      const add = async (name: string, description: string, writes: Array<[string, number, number]>, archived: string | null = null) => {
        const ark = await place(name, description, archived);
        for (const [by, chars, ago] of writes) await wrote(ark, by, chars, ago);
        const last = writes.length ? [...writes].sort((a, b) => a[2] - b[2])[0] : null;
        cases.push({ name, ark, before: description, last: last ? { by: last[0], chars: last[1] } : null, archived: archived ?? undefined });
      };
      await add('Editor на проде', TEXT, [['editor-ai', TEXT.length, 5]]);
      await add('Editor на раннере', TEXT, [['editor-ai-runner:some-model', TEXT.length, 5]]);
      await add('enrich-places', TEXT, [['enrich-places-ai', TEXT.length, 5]]);
      await add('enrich-routes по названию', TEXT, [['enrich-routes-ai', TEXT.length, 5]]);
      await add('модель, потом правил человек', EDITED, [['enrich-routes-ai', TEXT.length, 5]]);
      await add('модель, потом решение владельца', TEXT, [['editor-ai', TEXT.length, 30], ['owner-decision', TEXT.length, 5]]);
      await add('решение владельца, потом модель', TEXT, [['owner-decision', TEXT.length, 30], ['editor-ai', TEXT.length, 5]]);
      await add('без журнала', TEXT, []);
      await add('архив уже занят дневником', TEXT, [['editor-ai', TEXT.length, 5]], 'Я поднялся сюда вчера.');
      await pool.query(MIGRATION_1309);
    });

    async function row(ark: string) {
      const r = await pool.query<{ description: string | null; withdrawn: string | null; reason: string | null }>(
        `SELECT description, description_withdrawn AS withdrawn, description_withdrawn_reason AS reason
           FROM places WHERE ark_id = $1::uuid`,
        [ark],
      );
      return r.rows[0];
    }

    it('снимает ровно то, что правило карточки называет «написала модель»', async () => {
      const verdicts: Array<[string, boolean, boolean]> = [];
      for (const c of cases) {
        const byModel = !c.archived && descriptionWrittenByModel(c.last, c.before?.length ?? null);
        const r = await row(c.ark);
        verdicts.push([c.name, byModel, r.description === null]);
      }
      // Сцена не пустая с обеих сторон: и снятые, и оставленные есть.
      expect(verdicts.filter(([, byModel]) => byModel).map(([n]) => n)).toEqual([
        'Editor на проде', 'Editor на раннере', 'enrich-places', 'enrich-routes по названию', 'решение владельца, потом модель',
      ]);
      for (const [name, byModel, removed] of verdicts) expect({ name, removed }).toEqual({ name, removed: byModel });
    });

    it('снятое лежит в архиве с причиной — вернуть можно', async () => {
      const r = await row(cases[0].ark);
      expect(r).toMatchObject({ description: null, withdrawn: TEXT });
      expect(r.reason).toContain('22.10');
    });

    it('архив, занятый раньше, не затирается', async () => {
      const r = await row(cases.find((c) => c.archived)!.ark);
      expect(r).toMatchObject({ description: TEXT, withdrawn: 'Я поднялся сюда вчера.' });
    });

    it('повтор миграции ничего не меняет', async () => {
      const before = await pool.query(`SELECT ark_id, description, description_withdrawn, description_withdrawn_at FROM places ORDER BY ark_id`);
      await pool.query(MIGRATION_1309);
      const after = await pool.query(`SELECT ark_id, description, description_withdrawn, description_withdrawn_at FROM places ORDER BY ark_id`);
      expect(after.rows).toEqual(before.rows);
    });
  });
});
