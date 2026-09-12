/**
 * Раннер черновиков описаний (#1830) — сеть, БД и AI замоканы.
 *
 * Главные гарантии этого файла:
 * 1. dry_run НЕ зовёт AI и не пишет в БД — только читает.
 * 2. Уже рассмотренный человеком черновик (approved/rejected) не
 *    переписывается повторным прогоном — решение не отменяется молча.
 * 3. Пишущий запрос — ТОЛЬКО в place_description_drafts, никогда в
 *    places.description напрямую (публикация — отдельный, ручной роут).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

const aiMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIQualityOrNull: (...args: unknown[]) => aiMock(...args),
}));

vi.mock('@/lib/geo/gvp-confirmed-pairs', () => ({
  GVP_CONFIRMED_PAIRS: [
    { placeId: 'p-1', placeName: 'Тестовый Толбачик', volcanoNumber: 300240, gvpName: 'Tolbachik', distanceKm: 4.3, confidence: 'exact' },
    { placeId: 'p-2', placeName: 'Тестовый Без Remarks', volcanoNumber: 999999, gvpName: 'Nothing', distanceKm: 0.1, confidence: 'exact' },
  ],
}));

import { runGvpRemarksDrafts, fetchGvpRemarks } from '@/lib/geo/gvp-remarks-runner';

const GVP_FEATURES = [{
  type: 'Feature',
  properties: { VolcanoNumber: 300240, Remarks: 'Tolbachik is a large basaltic volcano...' },
}];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryMock.mockReset();
  aiMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/SELECT place_id FROM place_description_drafts/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  aiMock.mockResolvedValue('Толбачик — крупный базальтовый вулкан...');
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ type: 'FeatureCollection', features: GVP_FEATURES }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runGvpRemarksDrafts — dry_run', () => {
  it('не зовёт AI и не пишет в БД', async () => {
    await runGvpRemarksDrafts({ dryRun: true });
    expect(aiMock).not.toHaveBeenCalled();
    expect(
      queryMock.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/i.test(sql as string)),
    ).toBe(true);
  });

  it('всё равно сообщает охват (у кого есть Remarks, у кого нет)', async () => {
    const result = await runGvpRemarksDrafts({ dryRun: true });
    const byId = new Map(result.outcomes.map(o => [o.placeId, o.status]));
    expect(byId.get('p-1')).toBe('written');
    expect(byId.get('p-2')).toBe('skipped_no_remarks');
  });
});

describe('runGvpRemarksDrafts — боевой прогон', () => {
  it('переводит и пишет ТОЛЬКО в place_description_drafts', async () => {
    await runGvpRemarksDrafts({ dryRun: false });
    expect(aiMock).toHaveBeenCalledTimes(1); // один вулкан с Remarks
    const writeCall = queryMock.mock.calls.find(([sql]) => /INSERT/i.test(sql as string));
    expect(writeCall).toBeDefined();
    const sql = String(writeCall![0]);
    expect(sql).toMatch(/INSERT INTO place_description_drafts/);
    expect(sql).not.toMatch(/UPDATE\s+places\s+SET/i);
    expect(queryMock.mock.calls.some(([s]) => /UPDATE\s+places\s+SET/i.test(s as string))).toBe(false);
  });

  it('без Remarks у вулкана — не пишет черновик, не зовёт AI для этой пары', async () => {
    const result = await runGvpRemarksDrafts({ dryRun: false });
    const outcome = result.outcomes.find(o => o.placeId === 'p-2');
    expect(outcome?.status).toBe('skipped_no_remarks');
  });

  it('отказ AI (null) — помечается, черновик не пишется выдуманным текстом', async () => {
    aiMock.mockResolvedValue(null);
    const result = await runGvpRemarksDrafts({ dryRun: false });
    const outcome = result.outcomes.find(o => o.placeId === 'p-1');
    expect(outcome?.status).toBe('skipped_translation_failed');
    expect(queryMock.mock.calls.some(([s]) => /INSERT/i.test(s as string))).toBe(false);
  });

  it('уже рассмотренный человеком черновик — пропускается, не переводится заново', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT place_id FROM place_description_drafts/.test(sql)) {
        return { rows: [{ place_id: 'p-1' }] };
      }
      return { rows: [] };
    });
    const result = await runGvpRemarksDrafts({ dryRun: false });
    expect(aiMock).not.toHaveBeenCalled();
    const outcome = result.outcomes.find(o => o.placeId === 'p-1');
    expect(outcome?.status).toBe('skipped_reviewed');
  });
});

describe('fetchGvpRemarks', () => {
  it('не-ok ответ — бросает ошибку с кодом', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(
      fetchGvpRemarks({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 }),
    ).rejects.toThrow(/503/);
  });
});
