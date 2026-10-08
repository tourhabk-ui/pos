// @vitest-environment node
/**
 * Предупреждения Росгидромета в ленте тревог (meteoalert, 08.10).
 *
 * До этого дня штормовое УГМС доходило до ленты только пересказом МЧС — без
 * уровня и срока. Сторож держит связку целиком (правило 10.09: производитель,
 * потребитель, сторож):
 * 1. разбор настоящей формы ответа (фикстура — дословно проба 04.10);
 * 2. уровень → тяжесть, слово явления → вид тревоги, регионы → зоны;
 * 3. одинаковое для севера и юга — одна тревога, истёкшее не возвращается;
 * 4. отказ источника — в errors; «нет регионов Камчатки» и устаревший ответ —
 *    отказ, не тишина и не «жив»;
 * 5. heartbeat зовёт приём, здоровье пишется и ждётся, происхождение узнаётся.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const dbQuery = vi.fn(async (..._a: unknown[]) => ({ rows: [], rowCount: 0 }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));

vi.mock('@/lib/services/safety/seismic-parser', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/services/safety/seismic-parser')>();
  return { ...orig, saveEvent: vi.fn(async () => 'inserted' as const) };
});

import {
  parseMeteoalert, meteoalertEvents, meteoAlertType, ingestMeteoalert,
  METEOALERT_PREFIX, METEOALERT_URL,
} from '@/lib/services/safety/meteoalert';
import { alertOrigin } from '@/lib/safety/alert-origin';
import { saveEvent } from '@/lib/services/safety/seismic-parser';
import { SAFETY_SOURCE_EXPECTATIONS } from '@/lib/services/safety/source-health';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); dbQuery.mockClear(); });

const NOW = 1791154800; // 2026-10-04 23:00 UTC — «сейчас» той пробы

/** Ответ информера 04.10, регионы Камчатки и соседи — дословно. */
const SAMPLE = {
  '0': {
    '97': { '0': 'Магаданская обл., побережье Охотского моря', '1': '11', '3': { '21': { '0': { '0': 'Ветер', '1': 'Местами на Охотском побережье ожидается ветер восточный 17-22 м/с.', '2': 1791277200, '3': 720 } } } },
    '95': { '0': 'Камчатский край, север', '1': '12', '3': {
      '001': { '0': { '0': 'Оповещения о погоде не требуется', '1': '', '2': NOW, '3': 2040 } },
      '21': { '0': { '0': 'Ветер', '1': 'в прибрежных районах местами 15-20 м/с', '2': NOW, '3': 4920 } },
    } },
    '96': { '0': 'Камчатский край, юг', '1': '12', '3': {
      '21': { '0': { '0': 'Ветер', '1': 'в прибрежных районах местами 15-20 м/с', '2': NOW, '3': 4920 } },
    } },
  },
  '1': NOW,
};

describe('разбор ответа', () => {
  it('берёт только Камчатку и только уровни от жёлтого', () => {
    const p = parseMeteoalert(SAMPLE)!;
    expect(p.regions).toEqual(['95', '96']);
    expect(p.warnings).toHaveLength(2); // «оповещения не требуется» — не предупреждение
    expect(p.warnings[0]).toMatchObject({ regionId: '95', key: '21', level: 2, phenomenon: 'Ветер', minutes: 4920 });
  });

  it('не та форма — null (отказ), а не пустой список', () => {
    expect(parseMeteoalert(null)).toBeNull();
    expect(parseMeteoalert([])).toBeNull();
    expect(parseMeteoalert({ error: 'x' })).toBeNull();
  });
});

describe('предупреждение → тревога', () => {
  it('одно и то же для севера и юга — одна тревога на весь край', () => {
    const events = meteoalertEvents(parseMeteoalert(SAMPLE)!.warnings, NOW * 1000);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.alert_type).toBe('weather');
    expect(e.severity).toBe(1);
    expect(e.title).toBe('Росгидромет: ветер — жёлтый уровень (север и юг края)');
    expect(e.description).toContain('в прибрежных районах местами 15-20 м/с.');
    expect(e.description).toContain('жёлтый — потенциально опасно');
    expect([...e.affected_zones].sort()).toEqual(['avachinsky', 'eastern', 'northern', 'western']);
    expect(e.expires_hours).toBe(82);
    expect(e.source_id.startsWith(`${METEOALERT_PREFIX}/95+96/21/${NOW}/t`)).toBe(true);
  });

  it('только север — только северная зона', () => {
    const w = parseMeteoalert(SAMPLE)!.warnings.filter((x) => x.regionId === '95');
    expect(meteoalertEvents(w, NOW * 1000)[0].affected_zones).toEqual(['northern']);
  });

  it('оранжевый — «опасно» (2, порог пуша), красный — 3', () => {
    const base = { regionId: '96', phenomenon: 'Ветер', text: 'до 30 м/с', startUnix: NOW, minutes: 600 };
    expect(meteoalertEvents([{ ...base, key: '31', level: 3 }], NOW * 1000)[0].severity).toBe(2);
    expect(meteoalertEvents([{ ...base, key: '41', level: 4 }], NOW * 1000)[0].severity).toBe(3);
  });

  it('вид тревоги — по слову источника, неузнанное — погода', () => {
    expect(meteoAlertType('Лавинная опасность')).toBe('avalanche');
    expect(meteoAlertType('Пожарная опасность')).toBe('fire_danger');
    expect(meteoAlertType('Паводок')).toBe('flood');
    expect(meteoAlertType('Гололёд')).toBe('weather');
  });

  it('только действующее: истёкшее и ещё не начавшееся не возвращаются (проба 715)', () => {
    const base = { regionId: '95', key: '21', level: 2 as const, phenomenon: 'Ветер', text: 'местами 15-20 м/с' };
    expect(meteoalertEvents([{ ...base, startUnix: NOW - 7200, minutes: 60 }], NOW * 1000)).toEqual([]);
    // Случай 08.10 дословно: жёлтый ветер севера «через 39 часов» рядом с
    // действующим оранжевым читался как два уровня одного ветра сразу.
    const ahead = { ...base, startUnix: NOW + 39 * 3600, minutes: 2820 };
    const orange = { ...base, key: '31', level: 3 as const, text: '15-20 м/с, местами 25-30 м/с', startUnix: NOW, minutes: 900 };
    const events = meteoalertEvents([ahead, orange], NOW * 1000);
    expect(events.map((e) => e.title)).toEqual(['Росгидромет: ветер — оранжевый уровень (север края)']);
    expect(events[0].expires_hours).toBe(15);
  });

  it('срок не дан — сутки, и это сказано в тексте', () => {
    const e = meteoalertEvents([{ regionId: '96', key: '21', level: 2, phenomenon: 'Ветер', text: '', startUnix: NOW, minutes: null }], NOW * 1000)[0];
    expect(e.expires_hours).toBe(24);
    expect(e.description).toContain('Срок действия источник не указал.');
  });

  it('срок не входит в текст — продление того же предупреждения продлевает строку (контентный дедуп)', () => {
    const base = { regionId: '96', key: '21', level: 2 as const, phenomenon: 'Ветер', text: '15-20 м/с' };
    const a = meteoalertEvents([{ ...base, startUnix: NOW, minutes: 600 }], NOW * 1000)[0];
    const b = meteoalertEvents([{ ...base, startUnix: NOW + 3600, minutes: 900 }], (NOW + 3600) * 1000)[0];
    expect(b.title).toBe(a.title);
    expect(b.description).toBe(a.description);
  });
});

describe('приём', () => {
  // «Сейчас» — момент пробы: свежесть сверяется с отметкой самого информера.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW * 1000 + 600_000); });

  it('ответ → тревоги, живость — по регионам', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe(METEOALERT_URL);
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }));
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 });
    const r = await ingestMeteoalert();
    expect(r.errors).toEqual([]);
    expect(r.rawItems).toBe(2);
    // Полный свежий ответ — снятие отменённого зовётся с действующими.
    expect(r.retracted).toBe(1);
    const [sql, params] = dbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SET expires_at = NOW\(\)/);
    expect(sql).not.toMatch(/DELETE/i);
    expect(params[0]).toBe('meteoalert/%');
    expect(params[1]).toEqual(['Росгидромет: ветер — жёлтый уровень (север и юг края)']);
    expect(r.regions).toEqual([
      { id: '95', label: 'север края', warnings: 1 },
      { id: '96', label: 'юг края', warnings: 1 },
    ]);
  });

  it('ответ без одного из регионов — ничего не снимается (это выключило бы сигнализацию)', async () => {
    const { '96': _south, ...north } = SAMPLE['0'];
    void _south;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ '0': north, '1': NOW }), { status: 200 })));
    const r = await ingestMeteoalert();
    expect(r.rawItems).toBe(1);
    expect(r.retracted).toBe(0);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('запись не удалась — не снимаем: незаписанное выглядело бы отменённым', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 })));
    vi.mocked(saveEvent).mockRejectedValueOnce(new Error('DB save failed'));
    const r = await ingestMeteoalert();
    expect(r.errors[0]).toContain('DB save failed');
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('HTTP-отказ — в errors, не исключением', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));
    const r = await ingestMeteoalert();
    expect(r.errors[0]).toContain('503');
    expect(r.rawItems).toBeUndefined();
  });

  it('200 без регионов Камчатки — отказ, а не «предупреждений нет»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ '0': {}, '1': NOW }), { status: 200 })));
    const r = await ingestMeteoalert();
    expect(r.errors[0]).toMatch(/нет регионов Камчатки/);
  });

  it('устаревший ответ — отказ: застрявший кэш не выдаётся за живой источник', async () => {
    vi.setSystemTime((NOW + 7 * 3600) * 1000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 })));
    const r = await ingestMeteoalert();
    expect(r.errors[0]).toMatch(/устарел на 7 ч/);
    expect(r.rawItems).toBeUndefined();
    expect(r.events).toEqual([]);
  });

  it('нет отметки времени — отказ, а не «свежо»', async () => {
    const { '1': _drop, ...noStamp } = SAMPLE;
    void _drop;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(noStamp), { status: 200 })));
    const r = await ingestMeteoalert();
    expect(r.errors[0]).toMatch(/нет отметки времени/);
  });
});

describe('связка с конвейером', () => {
  const ROUTE = readFileSync('app/api/cron/safety-ingest/route.ts', 'utf8');

  it('heartbeat зовёт приём один раз и пишет здоровье', () => {
    expect((ROUTE.match(/ingestMeteoalert\(\)/g) ?? []).length).toBe(1);
    expect(ROUTE).toContain("entryFor('meteoalert'");
  });

  it('тишина источника ждётся по регионам, а не по вставленным тревогам', () => {
    const exp = SAFETY_SOURCE_EXPECTATIONS.find((e) => e.key === 'meteoalert');
    expect(exp?.aliveBy).toBe('raw_items');
  });

  it('происхождение узнаётся по форме id', () => {
    const e = meteoalertEvents(parseMeteoalert(SAMPLE)!.warnings, NOW * 1000)[0];
    expect(alertOrigin(e.source_id, e.source_url)?.label).toBe('Росгидромет (meteoalert.meteoinfo.ru)');
  });
});
