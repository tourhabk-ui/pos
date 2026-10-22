/**
 * Заметка Кузьмича о месте сверяется с данными, по которым её писали (14.10,
 * владелец: «кузьмич навыдумывал много»).
 *
 * Держится:
 *  - улики считаются верно: число и опасность без опоры, рассказ от первого
 *    лица; опора — описание места, высота и произносимый профиль (шаблон 070
 *    опорой не считается);
 *  - агент не сохраняет заметку с уликой, не пишет заметку по
 *    описанию-дневнику и не глотает отказ;
 *  - перепись отвечает четырьмя счетами и сама ничего не пишет.
 * Судится вызовом на данных, а не текстом исходника.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const waterfallMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIWaterfall: (...a: unknown[]) => waterfallMock(...a),
  isWaterfallErrorResponse: () => false,
}));
vi.mock('@/lib/scraping/brightdata', () => ({ fetchViaBrightData: async () => null }));
// С 22.10 новые заметки выключены словом владельца (model-place-text-paused.test.ts
// держит выключенное). Здесь судится путь записи на день, когда его включат снова:
// без проверки после модели он вернулся бы с прежними выдумками.
vi.mock('@/lib/places/model-place-text', () => ({ MODEL_WRITES_PLACE_TEXT: true, MODEL_PLACE_TEXT_PAUSED_MESSAGE: '' }));

import { reviewClaims, reviewRewriteReason } from '@/lib/kuzmich/review-claims';
import { runKuzmichPlaceEnricher, recheckExistingReviews } from '@/lib/agents/kuzmich-place-enricher';
import { GET as census } from '@/app/api/cron/kuzmich-review-census/route';

/** Описание Вачкажца после 1151 (справка по Википедии) — дословно его начало и конец. */
const VACH_DESCRIPTION =
  'Вачкажец (Вачкажеч, устаревшее Вацкажач) — горный массив на юге Камчатки, в 80 км к западу от '
  + 'Петропавловска-Камчатского; памятник природы регионального значения. Высшая точка — гора Вачкажец, '
  + '1556 м. Нынешний рельеф — кары, цирки и троговые долины — оставил ледник площадью около 120 км², '
  + 'существовавший 60–10 тыс. лет назад; толщина льда достигала 150 м. Летом здесь трекинг, наблюдение '
  + 'за птицами и цветами, зимой — лыжный туризм и фрирайд.';
/** Заметка, стоявшая на карточке Вачкажца до 1244 (проба 832). */
const VACH_REVIEW =
  'Вачкажец с юга — это чёрный базальтовый разлом под ногами. Часа четыре идти по осыпи и снежнику на одну '
  + 'из трёх вершин, но на гребне откроются цирки с айсбергами в чаше озера. Место серьёзное: погода '
  + 'меняется быстро, медведи встречаются, так что без опыта и подготовки не суйтесь.';

describe('улики в заметке', () => {
  it('Вачкажец: четыре часа и три вершины без опоры, медведи без опоры', () => {
    const v = reviewClaims(VACH_REVIEW, { description: VACH_DESCRIPTION, hazardCodes: [], altitudeM: null });
    expect(v.flags).toEqual(['number_not_in_data', 'hazard_not_in_data']);
    expect(v.numbers).toEqual(expect.arrayContaining(['четыре', 'трёх']));
    expect(v.hazards).toEqual(['bears']);
  });

  it('пересказ данных — без улик; высота из описания и профиля опирается', () => {
    const v = reviewClaims(
      'Горный массив, который оставил ледник: кары, цирки, троговые долины. Вершина — 1 556 м, льда было до 150 м.',
      { description: VACH_DESCRIPTION, hazardCodes: [], altitudeM: null },
    );
    expect(v.flags).toEqual([]);
    expect(reviewClaims('Подъём до 1600 м.', { description: 'Гора.', hazardCodes: [], altitudeM: 1600 }).flags).toEqual([]);
  });

  it('опасность опирается на описание или на произносимый профиль', () => {
    const r = 'Медведи здесь хозяева — держите дистанцию.';
    expect(reviewClaims(r, { description: 'У реки часто кормятся медведи.', hazardCodes: [], altitudeM: null }).flags).toEqual([]);
    expect(reviewClaims(r, { description: 'Река.', hazardCodes: ['bears'], altitudeM: null }).flags).toEqual([]);
    expect(reviewClaims(r, { description: 'Река.', hazardCodes: [], altitudeM: null }).hazards).toEqual(['bears']);
  });

  it('рассказ от первого лица — улика', () => {
    expect(reviewClaims('Я поднялся сюда в июле.', { description: 'Гора.', hazardCodes: [], altitudeM: null }).flags).toContain('diary');
  });

  it('впечатление — не улика, а голос', () => {
    const v = reviewClaims('Тишина у озера стоит такая, что слышно воду.', { description: 'Озеро.', hazardCodes: [], altitudeM: null });
    expect(v.flags).toEqual([]);
    expect(v.voice).toBe('impression');
  });
});

const PLACE = {
  id: 'p1', name: 'Вачкажец', location_type: 'mountain', description: VACH_DESCRIPTION, zone: 'western',
  lat: 53.08, lng: 157.93, altitude_m: null, difficulty_level: '2', hazard_types: ['wildlife', 'weather'],
  terrain_type: 'forest', profile_source: 'type_template',
};

describe('агент заметок', () => {
  beforeEach(() => {
    queryMock.mockReset();
    waterfallMock.mockReset();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout);
  });

  /**
   * Ответы базы по смыслу запроса: перепроверка стоящих заметок, выбор
   * очереди, снятие на перезапись, запись новой.
   */
  function db(opts: { reviewed?: unknown[]; candidates?: unknown[]; resetCount?: number; saveError?: Error; recheckError?: Error }) {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("btrim(p.kuzmich_review) <> ''")) {
        if (opts.recheckError) throw opts.recheckError;
        return { rows: opts.reviewed ?? [] };
      }
      if (s.includes('kuzmich_review IS NULL')) return { rows: opts.candidates ?? [] };
      if (s.includes('unnest(')) return { rows: [], rowCount: opts.resetCount ?? 0 };
      if (s.includes('SET kuzmich_review = $1')) {
        if (opts.saveError) throw opts.saveError;
        return { rows: [] };
      }
      throw new Error(`неожиданный запрос: ${s}`);
    });
  }

  function saves(): unknown[][] {
    return queryMock.mock.calls.filter((c) => String(c[0]).includes('SET kuzmich_review = $1'));
  }

  it('заметку с уликой не сохраняет и называет причину', async () => {
    db({ candidates: [PLACE] });
    waterfallMock.mockResolvedValueOnce(VACH_REVIEW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runKuzmichPlaceEnricher(1);
    expect(r).toMatchObject({ processed: 1, enriched: 0, rejected: 1 });
    expect(saves()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('сказано сверх данных места'), expect.objectContaining({ hazards: ['bears'] }));
    warn.mockRestore();
  });

  it('заметку без улик сохраняет', async () => {
    db({ candidates: [PLACE] });
    waterfallMock.mockResolvedValueOnce('Массив выточил ледник: кары, цирки и троговые долины видны с тропы, а зимой сюда едут за фрирайдом.');
    const r = await runKuzmichPlaceEnricher(1);
    expect(r).toMatchObject({ enriched: 1, rejected: 0 });
    expect(saves()).toHaveLength(1);
    // Район в промпте — словами: «, western» был заказом на слаг в заметке (16.10).
    const prompt = JSON.stringify(waterfallMock.mock.calls[0]);
    expect(prompt).toContain('Западная Камчатка');
    expect(prompt).not.toMatch(/, western/);
  });

  it('место с описанием-дневником в партию не берётся — модель зовётся только для справочного', async () => {
    const diary = { ...PLACE, id: 'd', description: 'Вчера я поднялся на гребень и увидел озеро — вода ледяная, вокруг ни души, до вершины мы шли пять часов.' };
    db({ candidates: [diary, diary, diary, PLACE] });
    waterfallMock.mockResolvedValueOnce('Массив выточил ледник: кары, цирки и троговые долины.');
    const r = await runKuzmichPlaceEnricher(1);
    expect(waterfallMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ processed: 1, enriched: 1 });
    // Очередь берётся с запасом: дневники не съедают партию.
    const pick = queryMock.mock.calls.find((c) => String(c[0]).includes('kuzmich_review IS NULL'))!;
    expect(pick[1]).toEqual([5]);
  });

  it('отказ записи — в лог с именем места, а не тишина', async () => {
    db({ candidates: [PLACE], saveError: Object.assign(new Error('boom'), { code: '57014' }) });
    waterfallMock.mockResolvedValueOnce('Массив выточил ледник: кары, цирки и троговые долины.');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runKuzmichPlaceEnricher(1);
    expect(r.errors).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('заметка о месте «Вачкажец»'), expect.objectContaining({ code: '57014' }));
    err.mockRestore();
  });
});

describe('перепроверка стоящих заметок (владелец 14.10: «1 да» — на перезапись)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    waterfallMock.mockReset();
  });

  const STOOD = {
    id: 'v', name: 'Вачкажец', description: VACH_DESCRIPTION, kuzmich_review: VACH_REVIEW,
    hazard_types: ['wildlife', 'weather'], profile_source: 'type_template', altitude_m: null,
  };
  const CLEAN = { ...STOOD, id: 'c', name: 'Озеро', description: 'Озеро в кратере.', kuzmich_review: 'Озеро в кратере — тихое место.' };
  const ON_DIARY = { ...CLEAN, id: 'd', name: 'Сопка', description: 'Вчера я поднялся на сопку, мы шли три часа.', kuzmich_review: 'Сопка у дороги.' };

  it('снимает заметку с уликой и заметку по описанию-дневнику; чистую не трогает', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("btrim(p.kuzmich_review) <> ''")) return { rows: [STOOD, CLEAN, ON_DIARY] };
      if (s.includes('unnest(')) return { rows: [], rowCount: 2 };
      throw new Error(`неожиданный запрос: ${s}`);
    });
    const r = await recheckExistingReviews();
    expect(r).toEqual({ checked: 3, reset: 2, reasons: { evidence: 1, diary_description: 1 } });
    const upd = queryMock.mock.calls.find((c) => String(c[0]).includes('unnest('))!;
    expect(String(upd[0])).toMatch(/SET kuzmich_review = NULL/);
    // Снимается ровно проверенный текст: исправленное рукой за это время не трогается.
    expect(String(upd[0])).toMatch(/AND p\.kuzmich_review = s\.review/);
    expect(upd[1]).toEqual([['v', 'd'], [VACH_REVIEW, 'Сопка у дороги.']]);
  });

  it('снимать нечего — записи нет вовсе', async () => {
    queryMock.mockResolvedValueOnce({ rows: [CLEAN] });
    const r = await recheckExistingReviews();
    expect(r.reset).toBe(0);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('прогон агента начинается с перепроверки и называет, сколько снято', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("btrim(p.kuzmich_review) <> ''")) return { rows: [STOOD] };
      if (s.includes('unnest(')) return { rows: [], rowCount: 1 };
      if (s.includes('kuzmich_review IS NULL')) return { rows: [] };
      throw new Error(`неожиданный запрос: ${s}`);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runKuzmichPlaceEnricher(20);
    expect(r).toMatchObject({ reset: 1, recheck_failed: false, processed: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('сняты на перезапись'), expect.objectContaining({ reset: 1 }));
    warn.mockRestore();
  });

  it('перепроверка не выполнилась — «не смог» в ответе и в логе, новые заметки пишутся', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("btrim(p.kuzmich_review) <> ''")) throw Object.assign(new Error('down'), { code: '08006' });
      if (s.includes('kuzmich_review IS NULL')) return { rows: [] };
      throw new Error(`неожиданный запрос: ${s}`);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runKuzmichPlaceEnricher(20);
    expect(r).toMatchObject({ reset: 0, recheck_failed: true });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('перепроверка стоящих заметок'), expect.objectContaining({ code: '08006' }));
    err.mockRestore();
  });

  it('правило перезаписи: улика или описание-дневник', () => {
    const facts = { description: VACH_DESCRIPTION, hazardCodes: [], altitudeM: null };
    expect(reviewRewriteReason(VACH_REVIEW, facts)).toBe('evidence');
    expect(reviewRewriteReason('Массив выточил ледник.', facts)).toBeNull();
    expect(reviewRewriteReason('Сопка у дороги.', { ...facts, description: 'Я поднялся сюда вчера.' })).toBe('diary_description');
  });
});

describe('перепись заметок', () => {
  const req = (secret: string) => new NextRequest('https://vedarai.ru/api/cron/kuzmich-review-census', {
    headers: { authorization: `Bearer ${secret}` },
  });

  beforeEach(() => {
    queryMock.mockReset();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('без секрета — 401 и в базу не ходит', async () => {
    const res = await census(req('wrong'));
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('четыре счёта; опасность без опоры — первой; только чтение', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { id: '1', slug: 'vachkazhets', name: 'Вачкажец', description: VACH_DESCRIPTION, kuzmich_review: VACH_REVIEW, hazard_types: ['wildlife', 'weather'], profile_source: 'type_template', altitude_m: null },
      { id: '2', slug: 'a', name: 'Авача', description: 'Река.', kuzmich_review: 'Тихая река у города.', hazard_types: null, profile_source: null, altitude_m: null },
      { id: '3', slug: 'b', name: 'Бухта', description: 'Бухта.', kuzmich_review: '', hazard_types: null, profile_source: null, altitude_m: null },
      { id: '4', slug: 'c', name: 'Сопка', description: null, kuzmich_review: null, hazard_types: null, profile_source: null, altitude_m: null },
    ] });
    const res = await census(req('test-secret'));
    const body = await res.json();
    expect(body.reviews).toEqual({ with_evidence: 1, no_evidence: 1, empty: 1, missing: 1 });
    expect(body.by_flag).toEqual({ diary: 0, number_not_in_data: 1, hazard_not_in_data: 1 });
    expect(body.rewrite_queue).toEqual({ evidence: 1, diary_description: 0 });
    expect(body.items[0]).toMatchObject({ slug: 'vachkazhets', hazards: ['bears'] });
    for (const [sql] of queryMock.mock.calls) expect(String(sql)).not.toMatch(/UPDATE|INSERT|DELETE/i);
  });

  it('база не ответила — 503 с кодом, а не пустая перепись', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '08006' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await census(req('test-secret'));
    expect(res.status).toBe(503);
    expect((await res.json()).sqlstate).toBe('08006');
    err.mockRestore();
  });
});
