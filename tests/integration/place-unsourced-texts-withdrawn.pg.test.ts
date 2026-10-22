/**
 * «Всю не правду» — слово владельца 22.10: с карточек мест снимается всякий
 * текст, у которого не записан ни автор, ни источник (миграция 1310). На
 * настоящем PostgreSQL.
 *
 * Судится то, что решает база, а мок ответил бы на любой SQL:
 *  - реестр 1310 — md5 текстов, положенных миграциями с источником, — не
 *    переписан руками, а пересчитывается из самих файлов: выражение вынимает
 *    tests/helpers/migration-place-texts, значение складывает PostgreSQL, как
 *    при выкате. Каждая строка реестра — текст, который та миграция
 *    действительно записала; ни один текст миграций реестра не забыт; каждая
 *    миграция 780–1309, пишущая текст карточки, либо в реестре, либо в списке
 *    «источник не назван» — с причиной;
 *  - правило снятия на каждом случае: перевод ГВП, журнал с автором-человеком,
 *    текст миграции с источником остаются; модель, «журнала нет», суть,
 *    доступ и сезон без источника, все заметки Кузьмича — в архив, и архив
 *    хранит снятое слово в слово; повтор ничего не меняет;
 *  - перепись description-writers-census после снятия: текста без журнала и
 *    без источника на видимых карточках нет.
 *
 * Своя база `place_unsourced_texts_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import {
  PLACE_TEXT_FIELDS, migrationNumber, migrationFiles, placeInserts, placeTextUpdates, type PlaceTextUpdate,
} from '../helpers/migration-place-texts';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[place-unsourced-texts-withdrawn.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'place_unsourced_texts_test';
const MIGRATION_1310 = readFileSync(join(process.cwd(), 'migrations/1310_place_unsourced_texts_withdrawn.sql'), 'utf-8');

/** Строки реестра из самой миграции: (поле, md5, номер миграции). */
const REGISTRY = [...MIGRATION_1310.matchAll(/\('(\w+)', '([0-9a-f]{32})', (\d+)\)/g)]
  .map((m) => ({ field: m[1], md5: m[2], migration: Number(m[3]) }));
const key = (r: { field: string; md5: string; migration: number }) => `${r.migration}:${r.field}:${r.md5}`;

/**
 * Миграции 780–1309, которые пишут текст карточки, но источника не называют.
 * Новая запись — с причиной; миграция перестала писать текст — запись
 * обязана уйти (сторож ниже требует, чтобы каждая здесь что-то писала).
 */
const NOT_SOURCED: Record<number, string> = {
  853: 'описания четырёх термальных источников «только проверяемое» по данным базы — внешнего источника и слова владельца нет',
  918: 'заглушка Зеленовских озерков: «озёра» — по имени маршрута; владелец назван источником одной координаты, не текста',
};

withPg('«всю не правду»: тексты мест без автора и источника — в архив (1310)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  /** md5 того, что запишет база, — выражение исполняется, а не склеивается в JS. */
  async function md5Of(expr: string): Promise<string> {
    const r = await pool.query<{ h: string }>(`SELECT md5(${expr}) AS h`);
    return r.rows[0].h;
  }

  /** md5 полей карточки у мест, которые вставляет оператор INSERT, — в откатываемой транзакции. */
  async function insertedTexts(stmt: string): Promise<Array<{ field: string; md5: string }>> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('TRUNCATE places CASCADE');
      await c.query(stmt);
      const r = await c.query<Record<string, string | null>>(
        `SELECT ${PLACE_TEXT_FIELDS.map((f) => `md5(${f}) AS ${f}`).join(', ')} FROM places`,
      );
      return r.rows.flatMap((row) => PLACE_TEXT_FIELDS.filter((f) => row[f]).map((f) => ({ field: f, md5: row[f] as string })));
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /** Все тексты карточки, которые записала миграция n, — как их запишет база. */
  async function textsOf(n: number, literalsBefore: Map<string, string>): Promise<string[]> {
    const out: string[] = [];
    for (const file of migrationFiles(n)) {
      for (const u of placeTextUpdates(file)) {
        let expr = u.expr;
        if (u.kind === 'append') {
          // Дописка к тексту, который положила для того же места миграция раньше.
          const base = u.placeIds.map((id) => literalsBefore.get(`${u.field}:${id}`)).find(Boolean);
          if (!base) throw new Error(`${file}: дописка к ${u.field} без прежнего литерала того же места`);
          expr = `(${base}) || ${u.expr}`;
        }
        out.push(`${n}:${u.field}:${await md5Of(expr)}`);
      }
      for (const stmt of placeInserts(file)) {
        for (const t of await insertedTexts(stmt)) out.push(`${n}:${t.field}:${t.md5}`);
      }
    }
    return out;
  }

  /** Литералы полей по местам — для дописок вида `поле || '…'`. */
  function literalsUpTo(n: number): Map<string, string> {
    const map = new Map<string, string>();
    const files = readdirSync(join(process.cwd(), 'migrations'))
      .filter((f) => f.endsWith('.sql') && (migrationNumber(f) ?? 0) >= 780 && (migrationNumber(f) ?? 0) < n)
      .sort((a, b) => (migrationNumber(a) ?? 0) - (migrationNumber(b) ?? 0));
    for (const f of files) {
      for (const u of placeTextUpdates(f) as PlaceTextUpdate[]) {
        if (u.kind !== 'literal') continue;
        for (const id of u.placeIds) map.set(`${u.field}:${id}`, u.expr);
      }
    }
    return map;
  }

  describe('реестр пересчитывается из файлов миграций', () => {
    const registryMigrations = [...new Set(REGISTRY.map((r) => r.migration))].sort((a, b) => a - b);
    /** Тексты карточки по миграциям 780–1309 — как их записала база. */
    const textsByMigration = new Map<number, string[]>();

    beforeAll(async () => {
      const candidates = [...new Set(readdirSync(join(process.cwd(), 'migrations'))
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => { const n = migrationNumber(f); return n !== null && n >= 780 && n <= 1309; })
        .filter((f) => placeTextUpdates(f).length > 0 || placeInserts(f).length > 0)
        .map((f) => migrationNumber(f) as number))].sort((a, b) => a - b);
      for (const n of candidates) {
        const texts = await textsOf(n, literalsUpTo(n));
        // INSERT места без текста (986 — каньон без описания) текста не пишет.
        if (texts.length > 0) textsByMigration.set(n, texts);
      }
    }, 120_000);

    it('реестр не пуст и без повторов', () => {
      expect(REGISTRY.length).toBeGreaterThan(50);
      expect(new Set(REGISTRY.map(key)).size).toBe(REGISTRY.length);
      expect(new Set(REGISTRY.map((r) => r.field))).toEqual(new Set(['description', 'essence', 'access_info', 'best_season']));
    });

    it('строки реестра — ровно тексты миграций с источником: ни лишней, ни забытой', () => {
      const expected = new Set(registryMigrations.flatMap((n) => textsByMigration.get(n) ?? []));
      const actual = new Set(REGISTRY.map(key));
      expect([...actual].filter((k) => !expected.has(k)), 'в реестре текст, которого миграция не писала').toEqual([]);
      expect([...expected].filter((k) => !actual.has(k)), 'текст миграции с источником не попал в реестр').toEqual([]);
    });

    it('каждая миграция 780–1309 с текстом карточки — в реестре или «источник не назван» с причиной', () => {
      const writers = [...textsByMigration.keys()];
      const unclassified = writers.filter((n) => !registryMigrations.includes(n) && !(n in NOT_SOURCED));
      expect(unclassified, 'миграция пишет текст карточки, а в реестре её нет и причины тоже').toEqual([]);
      for (const [n, why] of Object.entries(NOT_SOURCED)) {
        expect(writers, `${n} в «источник не назван», но текста карточки не пишет — запись устарела`).toContain(Number(n));
        expect(registryMigrations, `${n} и в реестре, и в «источник не назван»`).not.toContain(Number(n));
        expect(why.length).toBeGreaterThan(20);
      }
    });
  });

  describe('правило снятия', () => {
    const NOTE = 'Здесь всегда тихо, и только ветер шепчет древние легенды.';
    const SEASON = { лето: 'Комары размером с медведя.' };
    let sourced = { description: '', essence: '', access: '' };
    const ids: Record<string, string> = {};

    async function place(key: string, cols: Record<string, unknown>): Promise<string> {
      const names = Object.keys(cols);
      const r = await pool.query<{ id: string; ark: string }>(
        `INSERT INTO places (id, ark_id, name, slug, lat, lng, is_visible, location_type${names.map((n) => `, ${n}`).join('')})
         VALUES (gen_random_uuid()::text, gen_random_uuid(), $1::text, $1::text, 53.1, 158.4, TRUE, 'lake'${names.map((_, i) => `, $${i + 2}`).join('')})
         RETURNING id, ark_id::text AS ark`,
        [`1310 ${key}`, ...names.map((n) => (n === 'seasonal_notes' && cols[n] !== null ? JSON.stringify(cols[n]) : cols[n]))],
      );
      ids[key] = r.rows[0].id;
      return r.rows[0].ark;
    }

    async function wrote(ark: string, by: string, chars: number, minutesAgo: number): Promise<void> {
      await pool.query(
        `INSERT INTO description_provenance (entity_id, entity_kind, written_by, chars, written_at)
         VALUES ($1::uuid, 'place', $2, $3, NOW() - make_interval(mins => $4))`,
        [ark, by, chars, minutesAgo],
      );
    }

    async function get(k: string) {
      const r = await pool.query<{
        description: string | null; withdrawn: string | null; essence: string | null; access_info: string | null;
        best_season: string | null; seasonal_notes: unknown; kuzmich_review: string | null;
      }>(
        `SELECT description, description_withdrawn AS withdrawn, essence, access_info, best_season, seasonal_notes, kuzmich_review
           FROM places WHERE id = $1`,
        [ids[k]],
      );
      return r.rows[0];
    }

    async function archived(k: string) {
      const r = await pool.query<{ field: string; value: unknown; reason: string }>(
        `SELECT field, value, reason FROM place_text_archive WHERE place_id = $1 AND migration = '1310' ORDER BY field`,
        [ids[k]],
      );
      return r.rows;
    }

    beforeAll(async () => {
      // Тексты с источником — те самые, что лежат в файлах миграций: 1159
      // (Кайныран, Камчатский туристический портал), 1288 (Паланское,
      // Википедия), 1256 (Три Брата, доступ).
      const u1159 = placeTextUpdates(migrationFiles(1159)[0]).find((u) => u.field === 'description')!;
      const u1288 = placeTextUpdates(migrationFiles(1288)[0]).find((u) => u.field === 'essence')!;
      const u1256 = placeTextUpdates(migrationFiles(1256)[0]).find((u) => u.field === 'access_info')!;
      const val = async (expr: string) => (await pool.query<{ v: string }>(`SELECT (${expr}) AS v`)).rows[0].v;
      sourced = { description: await val(u1159.expr), essence: await val(u1288.expr), access: await val(u1256.expr) };

      const TEXT = 'Озеро в кальдере, вода холодная круглый год, берег каменистый.';
      await place('без журнала', { description: TEXT, kuzmich_review: NOTE });
      const model = await place('модель', { description: TEXT });
      await wrote(model, 'editor-ai', TEXT.length, 5);
      const modelBusy = await place('модель, архив занят', { description: TEXT, description_withdrawn: 'Я поднялся сюда вчера.' });
      await wrote(modelBusy, 'editor-ai', TEXT.length, 5);
      const owner = await place('решение владельца', { description: TEXT });
      await wrote(owner, 'owner-decision', TEXT.length, 5);
      const ownerThenModel = await place('владелец, потом модель', { description: `${TEXT} Дописано.` });
      await wrote(ownerThenModel, 'owner-decision', TEXT.length, 30);
      await wrote(ownerThenModel, 'editor-ai', TEXT.length + 9, 5);
      await place('ГВП', { description: 'Перевод справки Global Volcanism Program.' });
      await pool.query(
        `INSERT INTO place_description_drafts (place_id, source, source_ref, original_text, translated_text, model, status)
         VALUES ($1, 'gvp', '300270', 'Remarks', 'Перевод справки Global Volcanism Program.', 'm', 'approved')`,
        [ids['ГВП']],
      );
      await place('текст миграции с источником', { description: sourced.description, essence: sourced.essence, access_info: sourced.access });
      const sourcedAfterModel = await place('модель, потом текст миграции', { description: sourced.description });
      await wrote(sourcedAfterModel, 'editor-ai', 300, 30);
      await place('суть, доступ, сезон без источника', {
        essence: 'Самое загадочное место края.', access_info: 'Тридцать минут пешком от набережной.',
        best_season: 'круглый год', seasonal_notes: SEASON,
      });
      await place('скрытое место', { description: TEXT });
      await pool.query(`UPDATE places SET is_visible = FALSE WHERE id = $1`, [ids['скрытое место']]);
      await place('пустая заметка', { kuzmich_review: '' });
      await place('заметки нет', { kuzmich_review: null });

      await pool.query(MIGRATION_1310);
    }, 60_000);

    it('без журнала и источника — в архив, архивная колонка говорит карточке «убрано»', async () => {
      expect(await get('без журнала')).toMatchObject({ description: null, withdrawn: 'Озеро в кальдере, вода холодная круглый год, берег каменистый.' });
      const a = await archived('без журнала');
      expect(a.find((x) => x.field === 'description')?.value).toBe('Озеро в кальдере, вода холодная круглый год, берег каменистый.');
      expect(a.find((x) => x.field === 'description')?.reason).toContain('всю не правду');
    });

    it('написанное моделью — в архив; занятая архивная колонка не затирается, текст — в архив 1310', async () => {
      expect((await get('модель')).description).toBeNull();
      const busy = await get('модель, архив занят');
      expect(busy).toMatchObject({ description: null, withdrawn: 'Я поднялся сюда вчера.' });
      expect((await archived('модель, архив занят')).map((x) => x.value)).toContain('Озеро в кальдере, вода холодная круглый год, берег каменистый.');
    });

    it('автор-человек в журнале, перевод ГВП, текст миграции с источником — остаются', async () => {
      expect((await get('решение владельца')).description).toContain('Озеро в кальдере');
      expect((await get('ГВП')).description).toBe('Перевод справки Global Volcanism Program.');
      expect(await get('текст миграции с источником')).toMatchObject({
        description: sourced.description, essence: sourced.essence, access_info: sourced.access, withdrawn: null,
      });
      expect(await archived('текст миграции с источником')).toEqual([]);
    });

    it('последней писала модель — снято, даже если раньше было решение владельца', async () => {
      expect((await get('владелец, потом модель')).description).toBeNull();
    });

    it('текст миграции после записи модели — остаётся, и журнал называет миграцию', async () => {
      expect((await get('модель, потом текст миграции')).description).toBe(sourced.description);
      const r = await pool.query<{ by: string; chars: number }>(
        `SELECT dp.written_by AS by, dp.chars FROM description_provenance dp
           JOIN places p ON p.ark_id = dp.entity_id
          WHERE p.id = $1 ORDER BY dp.written_at DESC, dp.id DESC LIMIT 1`,
        [ids['модель, потом текст миграции']],
      );
      expect(r.rows[0]).toEqual({ by: expect.stringMatching(/^migration:(\d+,)*1159(,\d+)*$/), chars: sourced.description.length });
    });

    it('суть, доступ, сезон и «по сезонам» без источника — в архив, значения слово в слово', async () => {
      expect(await get('суть, доступ, сезон без источника')).toMatchObject({
        essence: null, access_info: null, best_season: null, seasonal_notes: null,
      });
      const a = await archived('суть, доступ, сезон без источника');
      expect(Object.fromEntries(a.map((x) => [x.field, x.value]))).toEqual({
        access_info: 'Тридцать минут пешком от набережной.', best_season: 'круглый год',
        essence: 'Самое загадочное место края.', seasonal_notes: SEASON,
      });
    });

    it('скрытое место чистится тоже — откроют обратно без выдумки', async () => {
      expect((await get('скрытое место')).description).toBeNull();
    });

    it('заметка Кузьмича — в архив и пустой строкой: писатель берёт только NULL', async () => {
      expect((await get('без журнала')).kuzmich_review).toBe('');
      const a = (await archived('без журнала')).find((x) => x.field === 'kuzmich_review');
      expect(a).toMatchObject({ value: NOTE });
      expect(a?.reason).toContain('писала модель');
      expect((await get('пустая заметка')).kuzmich_review).toBe('');
      expect((await get('заметки нет')).kuzmich_review).toBeNull();
      expect(await archived('заметки нет')).toEqual([]);
    });

    it('заметка владельца из канала (893) — в архив со своей причиной, не «писала модель»', async () => {
      // Текст — тот, что положила 893, и сложен базой, как при выкате.
      const literal = readFileSync(join(process.cwd(), 'migrations', migrationFiles(893)[0]), 'utf-8')
        .match(/SET kuzmich_review = ('(?:[^']|'')*')/)![1];
      const note = (await pool.query<{ v: string }>(`SELECT (${literal}) AS v`)).rows[0].v;
      await place('заметка владельца', { kuzmich_review: note });
      await pool.query(MIGRATION_1310);
      const a = (await archived('заметка владельца')).find((x) => x.field === 'kuzmich_review');
      expect(a?.value).toBe(note);
      expect(a?.reason).toContain('владельца');
      expect(a?.reason).not.toContain('писала модель');
    });

    it('по всей таблице: остался только текст с признаком, снятое — без признака', async () => {
      // Сюда входят и места, которые вставили сами миграции при постройке
      // схемы (1240 Кроноцкий заповедник, 918 Зеленовские озерки и др.): 1310
      // прошла по ним так же, как пройдёт по проду.
      const reg = (field: string) => new Set(REGISTRY.filter((r) => r.field === field).map((r) => r.md5));
      const { rows } = await pool.query<{
        id: string; name: string; d: string | null; e: string | null; a: string | null; b: string | null;
        seasonal: unknown; kuzmich: string | null; gvp: boolean; human: boolean;
      }>(
        `SELECT p.id, p.name, md5(NULLIF(btrim(p.description), '')) AS d, md5(NULLIF(btrim(p.essence), '')) AS e,
                md5(NULLIF(btrim(p.access_info), '')) AS a, md5(NULLIF(btrim(p.best_season), '')) AS b,
                p.seasonal_notes AS seasonal, p.kuzmich_review AS kuzmich,
                EXISTS (SELECT 1 FROM place_description_drafts d WHERE d.place_id = p.id AND d.source = 'gvp'
                          AND d.status = 'approved' AND d.translated_text = p.description) AS gvp,
                COALESCE((SELECT dp.written_by NOT IN ('editor-ai', 'enrich-places-ai', 'enrich-routes-ai')
                                 AND dp.written_by NOT LIKE 'editor-ai-runner:%'
                            FROM description_provenance dp WHERE dp.entity_id = p.ark_id
                           ORDER BY dp.written_at DESC, dp.id DESC LIMIT 1), FALSE) AS human
           FROM places p`,
      );
      const names = rows.map((r) => r.name);
      expect(names).toContain('Кроноцкий заповедник');
      for (const r of rows) {
        const bad: string[] = [];
        if (r.d && !r.gvp && !r.human && !reg('description').has(r.d)) bad.push('description');
        if (r.e && !reg('essence').has(r.e)) bad.push('essence');
        if (r.a && !reg('access_info').has(r.a)) bad.push('access_info');
        if (r.b && !reg('best_season').has(r.b)) bad.push('best_season');
        if (r.seasonal !== null) bad.push('seasonal_notes');
        if (r.kuzmich !== null && r.kuzmich.trim() !== '') bad.push('kuzmich_review');
        expect({ place: r.name, bad }).toEqual({ place: r.name, bad: [] });
      }
      // Снятое: значения без признака, а поле теперь пусто.
      const archivedRows = await pool.query<{ field: string; h: string | null; empty: boolean }>(
        `SELECT a.field, CASE WHEN jsonb_typeof(a.value) = 'string' THEN md5(a.value #>> '{}') END AS h,
                CASE a.field
                  WHEN 'description'    THEN p.description IS NULL
                  WHEN 'essence'        THEN p.essence IS NULL
                  WHEN 'access_info'    THEN p.access_info IS NULL
                  WHEN 'best_season'    THEN p.best_season IS NULL
                  WHEN 'seasonal_notes' THEN p.seasonal_notes IS NULL
                  WHEN 'kuzmich_review' THEN p.kuzmich_review = ''
                END AS empty
           FROM place_text_archive a JOIN places p ON p.id = a.place_id WHERE a.migration = '1310'`,
      );
      expect(archivedRows.rows.length).toBeGreaterThan(5);
      for (const a of archivedRows.rows) {
        expect(a.empty, `${a.field}: снято, но поле не пусто`).toBe(true);
        if (a.h && a.field !== 'kuzmich_review' && a.field !== 'seasonal_notes') {
          expect(reg(a.field).has(a.h), `${a.field}: снят текст из реестра`).toBe(false);
        }
      }
    });

    it('заглушка 918 без источника снята, справка 1240 с источником осталась целиком', async () => {
      const r = await pool.query<{ name: string; description: string | null; essence: string | null; access_info: string | null; best_season: string | null }>(
        `SELECT name, description, essence, access_info, best_season FROM places
          WHERE id IN ('f31f3774-65d4-47b7-a03e-4e3d4a575100', '4f1217e7-31a4-4d21-bc98-3d46aaba122e')`,
      );
      const kronotsky = r.rows.find((x) => x.name === 'Кроноцкий заповедник');
      const zelenovskie = r.rows.find((x) => x.name === 'Зеленовские озерки');
      expect(kronotsky?.description && kronotsky.essence && kronotsky.access_info && kronotsky.best_season).toBeTruthy();
      expect(zelenovskie).toMatchObject({ description: null });
    });

    it('повтор миграции ничего не меняет', async () => {
      const snap = async () => ({
        places: (await pool.query(`SELECT id, description, description_withdrawn, essence, access_info, best_season, seasonal_notes, kuzmich_review FROM places ORDER BY id`)).rows,
        archive: (await pool.query(`SELECT place_id, field, value FROM place_text_archive ORDER BY place_id, field`)).rows,
        journal: (await pool.query(`SELECT COUNT(*)::text AS n FROM description_provenance`)).rows,
      });
      const before = await snap();
      await pool.query(MIGRATION_1310);
      expect(await snap()).toEqual(before);
    });

    it('перепись после снятия: на видимых карточках нет текста без журнала и без источника', async () => {
      const prev = process.env.CRON_SECRET;
      process.env.CRON_SECRET = 'test-secret';
      const { GET } = await import('@/app/api/cron/description-writers-census/route');
      const { NextRequest } = await import('next/server');
      const res = await GET(new NextRequest('http://localhost/x', { headers: { authorization: 'Bearer test-secret' } }));
      process.env.CRON_SECRET = prev;
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, by_model: 0, no_journal_without_source: 0 });
      expect(body.gvp_source).toBeGreaterThanOrEqual(1);
      expect((body.archived_1310 as Record<string, number>).kuzmich_review).toBeGreaterThanOrEqual(2);
      expect((body.visible_with_field as Record<string, number>).kuzmich_review).toBe(0);
      expect((body.visible_with_field as Record<string, number>).seasonal_notes).toBe(0);
    });
  });
});
