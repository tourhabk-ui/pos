/**
 * Черновики прайса перевозчика (1355) на настоящем PostgreSQL.
 *
 * Мок ответил бы на любой SQL; здесь решает сервер:
 *   - миграция 1355 применяется повторно без ошибки;
 *   - CHECK отвергают: правку с видом машины, правку без единого поля, новую
 *     строку без цены и направление без «куда»;
 *   - один pending на строку прайса: второй черновик дополняет первый
 *     (COALESCE), а не плодит второй; у новых строк общего ключа нет;
 *   - одобрение правки переписывает живую строку и ставит approved; при
 *     расхождении с тем, что видел модератор, — changed и прайс прежний;
 *   - одобрение новой строки вставляет её в прайс; дубль направления на
 *     тот же вид машины отвергает уникальный индекс 1185 — duplicate, черновик
 *     остаётся pending;
 *   - отказ живую строку не трогает; перевозчик видит причину (loadOwnDrafts).
 *
 * Своя база — копия шаблона схемы со ВСЕМИ миграциями каталога. Без
 * KERNEL_PG_TEST_URL файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[charter-price-edits.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'charter_price_edits_test';
const MIGRATION = join(process.cwd(), 'migrations', '1355_charter_price_edits.sql');

withPg('черновики прайса перевозчика на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let partnerId = '';
  let otherId = '';
  let priceId = '';

  const sqlState = async (p: Promise<unknown>): Promise<string | null> => {
    try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? 'без кода'; }
  };

  beforeAll(async () => {
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    const add = async (name: string, slug: string) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, contacts, is_verified, is_public, slug, short_description)
         VALUES ($1, 'transfer', '{"phone":"+70000000000"}', '{"phone":"+7 900 111-22-33"}', FALSE, TRUE, $2, 'Машина под заказ') RETURNING id`,
        [name, slug],
      );
      return r.rows[0].id;
    };
    partnerId = await add('Тестовый перевозчик А', 'test-carrier-a');
    otherId = await add('Тестовый перевозчик Б', 'test-carrier-b');
    const p = await pool.query<{ id: string }>(
      `INSERT INTO transfer_charter_prices (partner_id, vehicle_kind, line_kind, from_text, to_text, price_rub, valid_year)
       VALUES ($1, 'vahtovka', 'destination', 'Петропавловск', 'Авачинский', 65000, 2026) RETURNING id`,
      [partnerId],
    );
    priceId = p.rows[0].id;
  }, 240_000);

  afterAll(async () => {
    // Пул приложения (хранилище ходит через @/lib/db-pool) закрывается до сноса
    // базы: иначе DROP … FORCE рвёт его соединение, и 57P01 всплывает ошибкой вне тестов.
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('миграция 1355 применяется повторно без ошибки', async () => {
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    const { rows } = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'transfer_charter_price_edits_one_pending'`);
    expect(rows).toHaveLength(1);
  });

  it('CHECK: правка с видом машины, пустая правка, новая строка без цены и без «куда» — 23514', async () => {
    const ins = (cols: string, vals: string, params: unknown[]) =>
      pool.query(`INSERT INTO transfer_charter_price_edits (${cols}) VALUES (${vals})`, params);
    expect(await sqlState(ins('partner_id, price_id, vehicle_kind, price_rub', '$1, $2, $3, $4', [partnerId, priceId, 'jeep', 1000]))).toBe('23514');
    expect(await sqlState(ins('partner_id, price_id', '$1, $2', [partnerId, priceId]))).toBe('23514');
    expect(await sqlState(ins('partner_id, vehicle_kind, line_kind, from_text, to_text', '$1, $2, $3, $4, $5', [partnerId, 'jeep', 'destination', 'ПК', 'Горелый']))).toBe('23514');
    expect(await sqlState(ins('partner_id, vehicle_kind, line_kind, from_text, price_rub', '$1, $2, $3, $4, $5', [partnerId, 'jeep', 'destination', 'ПК', 1000]))).toBe('23514');
    expect(await sqlState(ins('partner_id, vehicle_kind, line_kind, price_rub', '$1, $2, $3, $4', [partnerId, 'jeep', 'per_hour', 0]))).toBe('23514');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM transfer_charter_price_edits');
    expect(rows[0].n).toBe(0);
  });

  it('один pending на строку: второй черновик дополняет первый, чужая строка не берётся', async () => {
    const { findOwnPriceRowById, savePricePatch, loadOwnDrafts } = await import('@/lib/transfers/price-edit-store');
    expect(await findOwnPriceRowById(otherId, priceId)).toEqual({ outcome: 'missing' });
    const found = await findOwnPriceRowById(partnerId, priceId);
    expect(found.outcome).toBe('one');
    if (found.outcome !== 'one') return;
    const first = await savePricePatch({ partnerId, row: found.row, patch: { priceRub: 70000, priceNote: null, conditions: null, isActive: null } });
    expect(first.outcome).toBe('saved');
    const second = await savePricePatch({ partnerId, row: found.row, patch: { priceRub: null, priceNote: 'плюс переправы', conditions: null, isActive: null } });
    expect(second.outcome).toBe('saved');
    if (second.outcome !== 'saved') return;
    expect(second.saved.draft).toEqual({ priceRub: 70000, priceNote: 'плюс переправы', conditions: null, isActive: null });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM transfer_charter_price_edits WHERE price_id = $1 AND moderation_status = 'pending'`, [priceId]);
    expect(rows[0].n).toBe(1);
    const own = await loadOwnDrafts(partnerId);
    expect(own.outcome === 'ok' && own.drafts).toHaveLength(1);
  });

  it('одобрение: расхождение с тем, что видел модератор, — changed и прайс прежний; совпало — живая строка переписана', async () => {
    const { decidePriceEdit, listPendingPriceEdits } = await import('@/lib/transfers/price-edit-store');
    const listed = await listPendingPriceEdits();
    expect(listed.outcome).toBe('ok');
    if (listed.outcome !== 'ok') return;
    const edit = listed.edits.find((e) => e.priceId === priceId)!;
    expect(edit.live?.priceRub).toBe(65000);
    // Модератор видел цену без примечания — перевозчик успел дописать.
    expect(await decidePriceEdit({ id: edit.id, action: 'approve', reason: null, moderatedBy: null, seen: { ...edit.draft, priceNote: null } }))
      .toEqual({ outcome: 'changed' });
    let live = await pool.query<{ price_rub: number; price_note: string | null }>('SELECT price_rub, price_note FROM transfer_charter_prices WHERE id = $1', [priceId]);
    expect(live.rows[0]).toEqual({ price_rub: 65000, price_note: null });
    const ok = await decidePriceEdit({ id: edit.id, action: 'approve', reason: null, moderatedBy: null, seen: edit.draft });
    expect(ok).toMatchObject({ outcome: 'approved', partnerId });
    live = await pool.query('SELECT price_rub, price_note FROM transfer_charter_prices WHERE id = $1', [priceId]);
    expect(live.rows[0]).toEqual({ price_rub: 70000, price_note: 'плюс переправы' });
    expect(await decidePriceEdit({ id: edit.id, action: 'approve', reason: null, moderatedBy: null, seen: edit.draft })).toEqual({ outcome: 'already' });
  });

  it('новая строка: одобрение вставляет её в прайс; дубль направления отвергает индекс — duplicate, черновик pending', async () => {
    const { saveNewPriceDraft, decidePriceEdit, listPendingPriceEdits, loadOwnPriceRows } = await import('@/lib/transfers/price-edit-store');
    const fresh = await saveNewPriceDraft({
      partnerId,
      row: { vehicleKind: 'jeep', lineKind: 'destination', fromText: 'Петропавловск', toText: 'Горелый', priceRub: 45000, priceNote: null, conditions: null, validYear: 2026 },
    });
    expect(fresh.outcome).toBe('saved');
    const dup = await saveNewPriceDraft({
      partnerId,
      row: { vehicleKind: 'vahtovka', lineKind: 'destination', fromText: 'Петропавловск', toText: 'Авачинский', priceRub: 1, priceNote: null, conditions: null, validYear: null },
    });
    expect(dup.outcome).toBe('saved');
    const listed = await listPendingPriceEdits();
    if (listed.outcome !== 'ok') throw new Error('очередь не прочитана');
    const freshEdit = listed.edits.find((e) => e.id === (fresh as { id: string }).id)!;
    const dupEdit = listed.edits.find((e) => e.id === (dup as { id: string }).id)!;
    expect(freshEdit.live).toBeNull();
    expect(await decidePriceEdit({ id: freshEdit.id, action: 'approve', reason: null, moderatedBy: null, seen: freshEdit.draft }))
      .toMatchObject({ outcome: 'approved', label: 'Петропавловск — Горелый (джип)' });
    const own = await loadOwnPriceRows(partnerId);
    expect(own.outcome === 'ok' && own.rows.map((r) => r.toText).sort()).toEqual(['Авачинский', 'Горелый']);
    expect(await decidePriceEdit({ id: dupEdit.id, action: 'approve', reason: null, moderatedBy: null, seen: dupEdit.draft }))
      .toEqual({ outcome: 'duplicate', label: 'Петропавловск — Авачинский (вахтовка)' });
    const { rows } = await pool.query('SELECT moderation_status FROM transfer_charter_price_edits WHERE id = $1', [dupEdit.id]);
    expect(rows[0].moderation_status).toBe('pending');
    // Отказ с причиной — живой прайс прежний, перевозчик видит причину.
    expect(await decidePriceEdit({ id: dupEdit.id, action: 'reject', reason: 'такое направление уже есть', moderatedBy: null, seen: null }))
      .toMatchObject({ outcome: 'rejected' });
    const { loadOwnDrafts } = await import('@/lib/transfers/price-edit-store');
    const drafts = await loadOwnDrafts(partnerId);
    expect(drafts.outcome === 'ok' && drafts.drafts.find((d) => d.id === dupEdit.id)).toMatchObject({ status: 'rejected', reason: 'такое направление уже есть' });
    const live = await pool.query('SELECT count(*)::int AS n FROM transfer_charter_prices WHERE partner_id = $1', [partnerId]);
    expect(live.rows[0].n).toBe(2);
  });

  it('updateVehicle: снять с линии и места «не записано» — своя машина; чужая — not_your_vehicle', async () => {
    const { addVehicle, updateVehicle } = await import('@/lib/transfers/service');
    const v = await addVehicle({ partnerId, kind: 'vahtovka', title: 'КамАЗ', seats: null });
    expect(v.seats).toBeNull();
    const off = await updateVehicle({ partnerId, vehicleId: v.id, patch: { isActive: false, seats: 26, notes: 'лебёдка' } });
    expect(off).toMatchObject({ ok: true, value: { is_active: false, seats: 26, notes: 'лебёдка' } });
    const back = await updateVehicle({ partnerId, vehicleId: v.id, patch: { isActive: true, seats: null } });
    expect(back).toMatchObject({ ok: true, value: { is_active: true, seats: null, notes: 'лебёдка' } });
    expect(await updateVehicle({ partnerId: otherId, vehicleId: v.id, patch: { isActive: false } })).toMatchObject({ ok: false, code: 'not_your_vehicle' });
  });
});
