/**
 * Высоты из DEM — данные, а не украшение.
 *
 * Проба прода 09.08 показала, что у idilesom высот нет вовсе
 * (`pointsWithThird: 0`), и модель рельефа осталась единственным источником.
 * Значит именно здесь легче всего повторить ошибку, из-за которой профиль на
 * «На маршруте» рисовал широту вместо высоты: подставить правдоподобное число
 * там, где источник промолчал.
 *
 * Тесты стерегут четыре правила: не спрашивать чаще ячейки модели, не
 * придумывать деталь между отсчётами, не писать неправдоподобное и не
 * подменять молчание нулём.
 */
import { describe, it, expect } from 'vitest';
import {
  sampleIndices, spreadElevations, fetchDemBatch, readTrack,
  DEM_SAMPLE_STEP_M, DEM_MAX_M, DEM_MIN_ANSWERED, DEM_PROBE_POINTS,
  DEM_REQUEST_TIMEOUT_MS,
} from '@/lib/services/relief/dem-backfill';

/** Прямой трек на восток: шаг примерно stepM метров. */
function line(n: number, stepM: number) {
  const dLng = stepM / (111_320 * Math.cos((53 * Math.PI) / 180));
  return Array.from({ length: n }, (_, i) => ({ lat: 53, lng: 158 + i * dLng }));
}

function okResponse(values: Array<number | null>) {
  return async () => new Response(
    JSON.stringify({ status: 'OK', results: values.map(v => ({ elevation: v })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('сколько спрашивать', () => {
  it('точки ближе ячейки модели не спрашиваем повторно', () => {
    // Трек с шагом 5 м: спрашивать каждую точку — тратить лимит на тот же
    // ответ, детали мельче 30 м у SRTM нет.
    const idx = sampleIndices(line(101, 5));
    expect(idx.length).toBeLessThan(30);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(100);
  });

  it('редкий трек спрашиваем целиком', () => {
    const idx = sampleIndices(line(10, DEM_SAMPLE_STEP_M * 4));
    expect(idx).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('вырожденный трек не ломает выборку', () => {
    expect(sampleIndices([])).toEqual([]);
    expect(sampleIndices(line(2, 1000))).toEqual([0, 1]);
  });
});

describe('как раскладывать ответы', () => {
  const track = line(11, DEM_SAMPLE_STEP_M);

  it('между отсчётами — линейно, без ступеньки «плоско-скачок»', () => {
    const out = spreadElevations(track, [0, 10], [100, 200]);
    expect(out[0]).toBe(100);
    expect(out[10]).toBe(200);
    // Середина — ровно посередине, а не «ещё 100» и потом рывок.
    expect(out[5]).toBeGreaterThan(140);
    expect(out[5]).toBeLessThan(160);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
  });

  it('молчащий отсчёт закрывают соседи, а не ноль', () => {
    const out = spreadElevations(track, [0, 5, 10], [100, null, 200]);
    expect(out.every(z => z !== null && z >= 100 && z <= 200)).toBe(true);
  });

  it('никто не ответил — вернулись пустые высоты, а не выдуманные', () => {
    expect(spreadElevations(track, [0, 10], [null, null]).every(z => z === null)).toBe(true);
  });

  it('края без ответа берут ближайший известный, а не обрываются', () => {
    const out = spreadElevations(track, [0, 5, 10], [null, 300, null]);
    expect(out[0]).toBe(300);
    expect(out[10]).toBe(300);
  });
});

describe('чему верить в ответе источника', () => {
  it('высота вне правдоподобного диапазона Камчатки — это не высота', async () => {
    // Высшая точка полуострова — Ключевская, 4750 м. Ответ в десятки тысяч
    // означает сбой источника, и записать его хуже, чем не записать ничего.
    const got = await fetchDemBatch([{ lat: 53, lng: 158 }, { lat: 54, lng: 159 }],
      okResponse([DEM_MAX_M + 1000, 1200]));
    expect(got).toEqual([null, 1200]);
  });

  it('null от источника остаётся null', async () => {
    expect(await fetchDemBatch([{ lat: 53, lng: 158 }], okResponse([null]))).toEqual([null]);
  });

  it('ошибка источника не превращается в тихий ноль', async () => {
    const bad = async () => new Response('{"status":"INVALID_REQUEST","error":"bad"}', { status: 400 });
    await expect(fetchDemBatch([{ lat: 53, lng: 158 }], bad)).rejects.toThrow();
  });

  it('порог покрытия не позволяет писать трек по паре ответов', () => {
    expect(DEM_MIN_ANSWERED).toBeGreaterThanOrEqual(0.8);
  });

  it('зависший источник — ошибка партии, а не бесконечное ожидание', async () => {
    // Прогон 09.08 оборвался по таймауту curl: бюджет проверяется МЕЖДУ
    // запросами, и застряв внутри одного, роут не возвращался вовсе.
    let sawSignal = false;
    const hang = async (_u: unknown, init?: { signal?: AbortSignal }) => {
      sawSignal = init?.signal instanceof AbortSignal;
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    };
    await expect(fetchDemBatch([{ lat: 53, lng: 158 }], hang as unknown as typeof fetch))
      .rejects.toThrow(/не ответил/);
    // Предел ставим мы, а не надежда на вежливость чужого хоста.
    expect(sawSignal).toBe(true);
    expect(DEM_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('исчерпанный лимит назван лимитом, а не сбоем', async () => {
    // Иначе следующий прогон будут чинить, а чинить нечего — надо подождать.
    const limited = async () => new Response('{}', { status: 429 });
    await expect(fetchDemBatch([{ lat: 53, lng: 158 }], limited))
      .rejects.toThrow(/лимит запросов/);
  });

  it('проба спрашивает точки с заранее известной высотой', () => {
    // Достижимость — половина ответа: источник может отвечать и врать.
    expect(DEM_PROBE_POINTS.length).toBeGreaterThanOrEqual(3);
    expect(DEM_PROBE_POINTS.some(p => /Ключевск/i.test(p.name))).toBe(true);
    expect(DEM_PROBE_POINTS.every(p => p.expect.trim().length > 0)).toBe(true);
  });
});

describe('чтение трека', () => {
  it('обычный LineString читается', () => {
    expect(readTrack({ coordinates: [[158, 53], [159, 54]] })).toEqual([
      { lat: 53, lng: 158 }, { lat: 54, lng: 159 },
    ]);
  });

  it('битая координата отбраковывает весь трек, а не пропускается молча', () => {
    expect(readTrack({ coordinates: [[158, 53], [159]] })).toEqual([]);
    expect(readTrack({ coordinates: [[158, 53], ['x', 'y']] })).toEqual([]);
    expect(readTrack(null)).toEqual([]);
  });

  it('высота из трека не мешает чтению координат', () => {
    expect(readTrack({ coordinates: [[158, 53, 400]] })).toEqual([{ lat: 53, lng: 158 }]);
  });
});
