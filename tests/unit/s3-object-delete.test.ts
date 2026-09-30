/**
 * Удаление брошенного снимка места из хранилища — обещания инструмента.
 *
 * Удаление необратимо, поэтому держится всё сразу: только ключи снимков
 * мест, ссылка из базы запрещает удаление, непроверенное — не удаляется,
 * «удалено» — только после обратного чтения. Правила —
 * lib/storage/orphan-delete.ts, роут — app/api/cron/s3-object-delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const query = vi.fn();
const deleteFromS3 = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/storage/s3', () => ({
  isS3Configured: true,
  s3PublicBase: () => 'https://s3.example/bucket',
  deleteFromS3: (...a: unknown[]) => deleteFromS3(...a),
}));

import { isPlaceImageKey, REFERENCE_COLUMNS, referenceCountSql } from '@/lib/storage/orphan-delete';
import { POST } from '@/app/api/cron/s3-object-delete/route';

const KEY = 'places/7190e0a4-52f1-47fb-ba17-0fcb493d99df/f30b51e0-01bf-4d41-beed-bee7e3a1c76a.jpg';
const NO_REFS = { rows: REFERENCE_COLUMNS.map((c) => ({ col: c.table, n: 0 })) };

function req(body: unknown, auth = 'Bearer test-secret') {
  return new Request('https://vedarai.ru/api/cron/s3-object-delete', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

/** Ответы HEAD по очереди: 200 с размером или 404. */
function heads(...statuses: number[]) {
  const fetchMock = vi.fn();
  for (const s of statuses) {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: s, headers: s === 200 ? { 'content-length': '380846' } : {} }));
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  query.mockReset();
  deleteFromS3.mockReset();
  vi.unstubAllGlobals();
});

describe('какие ключи вообще можно удалять', () => {
  it('только снимки мест: places/<uuid>/<файл>.jpg|png|webp', () => {
    expect(isPlaceImageKey(KEY)).toBe(true);
    expect(isPlaceImageKey('places/7190e0a4-52f1-47fb-ba17-0fcb493d99df/commons-x.webp')).toBe(true);
  });

  it('пакеты карты, треки, чужие папки и попытки выйти из папки — нет', () => {
    for (const k of [
      'map-packs/cell-53n158e.places.geojson',
      'places/not-a-uuid/x.jpg',
      'places/7190e0a4-52f1-47fb-ba17-0fcb493d99df/../../map-packs/x.jpg',
      'places/7190e0a4-52f1-47fb-ba17-0fcb493d99df/sub/x.jpg',
      'places/7190e0a4-52f1-47fb-ba17-0fcb493d99df/x.geojson',
      `/${KEY}`,
    ]) expect(isPlaceImageKey(k), k).toBe(false);
  });
});

describe('ссылки из базы', () => {
  it('проверяются все колонки, где живут адреса снимков', () => {
    const cols = REFERENCE_COLUMNS.map((c) => `${c.table}.${c.expr}`);
    for (const need of ['ai_route_images.s3_key', 'ai_route_images.s3_url', 'place_gallery_photos.s3_url',
      'places.photo_url', 'places.images::text', 'user_place_photos.url']) {
      expect(cols).toContain(need);
    }
    // strpos, а не LIKE: `_` в ключе для LIKE — подстановка.
    expect(referenceCountSql()).not.toMatch(/LIKE/i);
    expect(referenceCountSql()).toContain('strpos(');
  });
});

describe('роут', () => {
  it('без секрета — 401, без причины — 400, больше десяти — 400', async () => {
    expect((await POST(req({ reason: 'x'.repeat(10), keys: [KEY] }, 'Bearer nope'))).status).toBe(401);
    expect((await POST(req({ keys: [KEY] }))).status).toBe(400);
    expect((await POST(req({ reason: 'x'.repeat(10), keys: Array(11).fill(KEY) }))).status).toBe(400);
  });

  it('по умолчанию сухой прогон: план с размером, ничего не удаляется', async () => {
    query.mockResolvedValue(NO_REFS);
    heads(200);
    const res = await (await POST(req({ reason: 'заглушка из интернета', keys: [KEY] }))).json();
    expect(res.dry_run).toBe(true);
    expect(res.results[0]).toEqual({ key: KEY, outcome: 'would_delete', bytes: 380846 });
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('объект, на который ссылается строка, не удаляется даже боевым прогоном', async () => {
    query.mockResolvedValue({ rows: [{ col: 'ai_route_images.s3_key', n: 1 }] });
    const res = await (await POST(req({ dry_run: false, reason: 'заглушка из интернета', keys: [KEY] }))).json();
    expect(res.results[0].outcome).toBe('refused_referenced');
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('проверка ссылок упала — отказ, а не «ссылок нет» (§4.0)', async () => {
    query.mockRejectedValue(Object.assign(new Error('relation missing'), { code: '42P01' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await (await POST(req({ dry_run: false, reason: 'заглушка из интернета', keys: [KEY] }))).json();
    expect(res.results[0].outcome).toBe('refused_check_failed');
    expect(deleteFromS3).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('чужой ключ отказывается до всякой проверки', async () => {
    const res = await (await POST(req({ dry_run: false, reason: 'заглушка из интернета', keys: ['map-packs/x.geojson'] }))).json();
    expect(res.results[0].outcome).toBe('refused_bad_key');
    expect(query).not.toHaveBeenCalled();
  });

  it('«удалено» — только когда хранилище после удаления отвечает 404', async () => {
    query.mockResolvedValue(NO_REFS);
    heads(200, 404);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await (await POST(req({ dry_run: false, reason: 'заглушка из интернета', keys: [KEY] }))).json();
    expect(deleteFromS3).toHaveBeenCalledWith(KEY);
    expect(res.results[0]).toEqual({ key: KEY, outcome: 'deleted', bytes: 380846 });
    warn.mockRestore();
  });

  it('объект после удаления всё ещё отдаётся — не «удалено», а «не подтверждено»', async () => {
    query.mockResolvedValue(NO_REFS);
    heads(200, 200);
    const res = await (await POST(req({ dry_run: false, reason: 'заглушка из интернета', keys: [KEY] }))).json();
    expect(res.results[0].outcome).toBe('delete_unverified');
    expect(res.summary.unverified).toBe(1);
  });

  it('объекта уже нет — так и сказано, удалять не пытается', async () => {
    query.mockResolvedValue(NO_REFS);
    heads(404);
    const res = await (await POST(req({ dry_run: false, reason: 'заглушка из интернета', keys: [KEY] }))).json();
    expect(res.results[0].outcome).toBe('already_absent');
    expect(deleteFromS3).not.toHaveBeenCalled();
  });
});

describe('связка', () => {
  it('роут запускает workflow по маркеру, маркер по умолчанию сухой', () => {
    const wf = readFileSync(join(process.cwd(), '.github/workflows/s3-object-delete.yml'), 'utf-8');
    expect(wf).toContain('/api/cron/s3-object-delete');
    expect(wf).toContain(".github/triggers/s3-object-delete.json");
    expect(wf).toMatch(/marker\.get\('mode'\) or 'dry'/);
    const markerPath = join(process.cwd(), '.github/triggers/s3-object-delete.json');
    expect(existsSync(markerPath)).toBe(true);
  });
});
