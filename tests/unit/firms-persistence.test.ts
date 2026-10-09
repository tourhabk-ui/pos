// @vitest-environment node
/**
 * Термоточки FIRMS, стоящие на месте несколько суток (скрин владельца 09.10:
 * «неделю в одном месте»). Чистая логика и форма переписи.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MIN_DAYS, DEFAULT_RADIUS_KM, STATIC_FEATURE_KM, distanceKm, judgeStatic, parseFirmsRows, persistentClusters,
  type FirmsRow, type NearFeature, type PersistentCluster,
} from '@/lib/services/safety/firms-persistence';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

const HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';
const line = (lat: number, lng: number, date: string, conf = 'n', frp = 11, dn = 'N', time = '1530') =>
  `${lat},${lng},330,0.4,0.4,${date},${time},N,VIIRS,${conf},2.0NRT,290,${frp},${dn}`;

function row(over: Partial<FirmsRow> = {}): FirmsRow {
  return { lat: 54.62, lng: 160.3, acqDate: '2026-10-01', acqTime: '1530', frp: 11, confidence: 'n', daynight: 'N', satellite: 'N', ...over };
}

describe('разбор: все строки, по именам колонок', () => {
  it('сохраняет и низкую уверенность (перепись видит то, что приём отбросил), время, день/ночь, спутник', () => {
    const rows = parseFirmsRows([HEADER, line(54.62, 160.3, '2026-10-02', 'l', 4, 'D', '0210')].join('\n'));
    expect(rows).toEqual([{ lat: 54.62, lng: 160.3, acqDate: '2026-10-02', acqTime: '0210', frp: 4, confidence: 'l', daynight: 'D', satellite: 'N' }]);
  });

  it('битые строки и CSV без нужных колонок — пусто, а не мусор; текст ошибки FIRMS — не CSV', () => {
    expect(parseFirmsRows('Invalid MAP_KEY')).toEqual([]);
    expect(parseFirmsRows(`${HEADER}\nне,число,x`)).toEqual([]);
    expect(parseFirmsRows('a,b,c\n1,2,3')).toEqual([]);
    expect(parseFirmsRows('')).toEqual([]);
  });

  it('колонок времени/мощности нет — пустые поля, а не выдуманные числа', () => {
    const rows = parseFirmsRows('latitude,longitude,acq_date\n54.6,160.3,2026-10-01');
    expect(rows[0]).toMatchObject({ acqTime: '', frp: 0, confidence: '', daynight: '' });
  });
});

describe('кластеры, где обнаружения повторяются в разные сутки', () => {
  const week = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];

  it('неделя на одном месте — один кластер, 7 суток, разброс ~0, порядок суток по возрастанию', () => {
    const rows = [...week].reverse().map((d) => row({ acqDate: d, frp: 9 + (d.endsWith('4') ? 4 : 0) }));
    const cells = persistentClusters(rows);
    expect(cells).toHaveLength(1);
    expect(cells[0].days).toEqual(week);
    expect(cells[0].perDay).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(cells[0].spreadKm).toBe(0);
    expect(cells[0].frpMax).toBe(13);
    expect(cells[0].frpMin).toBe(9);
    expect(cells[0].night).toBe(7);
    expect([cells[0].firstDay, cells[0].lastDay]).toEqual(['2026-10-01', '2026-10-07']);
  });

  it('несколько обнаружений за одни сутки — одни сутки, а не несколько', () => {
    const rows = [row(), row({ acqTime: '0200' }), row({ acqDate: '2026-10-02' }), row({ acqDate: '2026-10-03' })];
    const [c] = persistentClusters(rows);
    expect(c.days).toHaveLength(3);
    expect(c.detections).toBe(4);
    expect(c.perDay).toEqual([2, 1, 1]);
  });

  it('порог по умолчанию — три суток; меньше не считается «стоящей»', () => {
    expect(DEFAULT_MIN_DAYS).toBe(3);
    expect(persistentClusters([row(), row({ acqDate: '2026-10-02' })])).toEqual([]);
    expect(persistentClusters([row(), row({ acqDate: '2026-10-02' })], { minDays: 2 })).toHaveLength(1);
  });

  it('движущийся фронт не склеивается в «стоящий»: каждые сутки в 5,5 км от прошлых — разные кластеры', () => {
    const rows = week.map((d, i) => row({ acqDate: d, lat: 54.62 + i * 0.05 }));
    expect(persistentClusters(rows)).toEqual([]);
  });

  it('источник на стыке прежних «ячеек» не распадается надвое: решает расстояние, а не сетка', () => {
    // 54.600 — рубеж, на котором сеточные ячейки по 0,05° резали бы источник; здесь две точки в 0,5 км друг от друга
    const rows = [row({ lat: 54.5995 }), row({ acqDate: '2026-10-02', lat: 54.6005 }), row({ acqDate: '2026-10-03', lat: 54.5995 })];
    expect(persistentClusters(rows)).toHaveLength(1);
  });

  it('разброс считается между обнаружениями кластера (километры, а не градусы)', () => {
    const rows = [row({ lat: 54.625 }), row({ acqDate: '2026-10-02', lat: 54.633 }), row({ acqDate: '2026-10-03', lat: 54.625 })];
    const [c] = persistentClusters(rows);
    expect(c.spreadKm).toBeGreaterThan(0.8);
    expect(c.spreadKm).toBeLessThan(1);
    expect(distanceKm(54.625, 160.3, 54.633, 160.3)).toBeCloseTo(c.spreadKm, 5);
  });

  it('радиус кластера — три километра: дальше это уже другое место', () => {
    expect(DEFAULT_RADIUS_KM).toBe(3);
    const near = [row({ lat: 54.62 }), row({ acqDate: '2026-10-02', lat: 54.62 + 2.5 / 111.2 }), row({ acqDate: '2026-10-03', lat: 54.62 })];
    expect(persistentClusters(near)).toHaveLength(1);
    const far = [row({ lat: 54.62 }), row({ acqDate: '2026-10-02', lat: 54.62 + 4 / 111.2 }), row({ acqDate: '2026-10-03', lat: 54.62 })];
    // два на месте (двое суток) + один в стороне (одни сутки): кластера на три суток нет
    expect(persistentClusters(far)).toEqual([]);
  });

  it('результат не зависит от порядка строк на входе', () => {
    const rows = week.map((d, i) => row({ acqDate: d, lat: 54.62 + (i % 2) * 0.004, acqTime: i % 2 ? '0100' : '1530' }));
    const a = persistentClusters(rows);
    const b = persistentClusters([...rows].reverse());
    expect(b.map((c) => [c.days, c.detections, c.perDay])).toEqual(a.map((c) => [c.days, c.detections, c.perDay]));
  });

  it('сначала те, что стоят дольше; потом те, где больше обнаружений', () => {
    const a = week.slice(0, 5).map((d) => row({ acqDate: d, lat: 54.1 }));
    const b = week.slice(0, 3).flatMap((d) => [row({ acqDate: d, lat: 55.3 }), row({ acqDate: d, lat: 55.3, acqTime: '0100' })]);
    const cells = persistentClusters([...b, ...a]);
    expect(cells.map((c) => c.days.length)).toEqual([5, 3]);
  });
});

describe('приговор judgeStatic: гасить можно, только когда известно всё', () => {
  const TODAY = '2026-10-07';
  const days = ['2026-10-04', '2026-10-05', '2026-10-06', TODAY];
  /** Кластер из заданных суточных чисел обнаружений и мощностей. */
  function cluster(perDay: number[], perDayFrp: number[], over: Partial<PersistentCluster> = {}): PersistentCluster {
    const d = days.slice(days.length - perDay.length);
    return {
      lat: 54.6126, lng: 160.2949, days: d, detections: perDay.reduce((a, b) => a + b, 0), perDay, perDayFrp,
      frpMin: 1, frpMax: 20, frpMean: 8, spreadKm: 1.9, night: 5, firstDay: d[0], lastDay: d[d.length - 1], members: [],
      ...over,
    };
  }
  const vent: NearFeature = { name: 'Вулкан Крашенинникова', type: 'volcano', km: 2.1 };
  const steady = cluster([8, 4, 6, 8], [40, 20, 30, 40]);

  it('ровно та картина 09.10: 3+ суток, вулкан в 2 км, сегодня не крупнее обычного — постоянный источник', () => {
    expect(judgeStatic(steady, TODAY, vent)).toEqual({ isStatic: true, reason: 'static_source' });
  });

  it('повторяется меньше суток, чем нужно — пожар, пока не доказано иное (хоть вулкан и рядом)', () => {
    const young = cluster([3, 4], [20, 25]);
    expect(judgeStatic(young, TODAY, vent)).toEqual({ isStatic: false, reason: 'not_persistent' });
    expect(judgeStatic(null, TODAY, vent)).toEqual({ isStatic: false, reason: 'not_persistent' });
  });

  it('граница «рядом» — пять километров; это число из замера (вулкан в 2,1 км), а не «чем шире, тем безопаснее»', () => {
    expect(STATIC_FEATURE_KM).toBe(5);
  });

  it('стоит давно, но вулкана/источника рядом нет — чем это тепло, не знаем, тревога остаётся', () => {
    expect(judgeStatic(steady, TODAY, null)).toEqual({ isStatic: false, reason: 'no_known_feature' });
    expect(judgeStatic(steady, TODAY, { ...vent, km: STATIC_FEATURE_KM + 0.1 })).toEqual({ isStatic: false, reason: 'no_known_feature' });
    expect(judgeStatic(steady, TODAY, { ...vent, km: STATIC_FEATURE_KM })).toEqual({ isStatic: true, reason: 'static_source' });
  });

  it('не смогли спросить, что рядом (база не ответила) — «не знаю» не гасит', () => {
    expect(judgeStatic(steady, TODAY, undefined)).toEqual({ isStatic: false, reason: 'feature_unknown' });
  });

  it('сегодня сильно крупнее бывшего — могла вспыхнуть настоящий пожар у вулкана: не гасим', () => {
    const flare = cluster([3, 4, 3, 12], [15, 20, 15, 120]);
    expect(judgeStatic(flare, TODAY, vent)).toEqual({ isStatic: false, reason: 'escalating' });
    // только по числу точек
    expect(judgeStatic(cluster([2, 2, 2, 9], [10, 10, 10, 25]), TODAY, vent).reason).toBe('escalating');
    // только по мощности
    expect(judgeStatic(cluster([4, 4, 4, 5], [20, 20, 20, 90]), TODAY, vent).reason).toBe('escalating');
  });

  it('рост от малых чисел — не рост пожара: с 1 до 3 точек и с 4 до 12 МВт не будят', () => {
    expect(judgeStatic(cluster([1, 1, 1, 3], [4, 4, 4, 12]), TODAY, vent).isStatic).toBe(true);
  });

  it('порядок проверок: рост важнее соседства с вулканом и важнее «не знаем, что рядом»', () => {
    const flare = cluster([3, 4, 3, 12], [15, 20, 15, 120]);
    expect(judgeStatic(flare, TODAY, undefined).reason).toBe('escalating');
    expect(judgeStatic(flare, TODAY, null).reason).toBe('escalating');
  });

  it('сегодняшних обнаружений в кластере нет (точка вчерашняя) — рост не судится, остальное по-прежнему', () => {
    const yesterdayOnly = cluster([8, 4, 6], [40, 20, 30], { days: ['2026-10-03', '2026-10-04', '2026-10-05'] });
    expect(judgeStatic(yesterdayOnly, TODAY, vent).isStatic).toBe(true);
  });
});

describe('приём FIRMS применяет то же правило, что показывает перепись', () => {
  const ING = read('lib/services/safety/wildfire-firms.ts');
  const ROUTE = read('app/api/cron/safety-ingest/route.ts');

  it('окно 5 суток (по одним суткам стоящую точку не узнать), кандидаты — только сегодняшние', () => {
    expect(ING).toMatch(/VIIRS_SNPP_NRT\/\$\{west\},\$\{south\},\$\{east\},\$\{north\}\/5/);
    expect(ING).toMatch(/h\.acqDate === today/);
  });

  it('гасит только через judgeStatic и только по вулкану/гейзеру/источнику; отказ базы не гасит и не глушится', () => {
    expect(ING).toContain('judgeStatic(cluster, today, nearest)');
    expect(ING).toMatch(/HEAT_FEATURE_TYPES = \['volcano', 'geyser', 'hot_spring'\]/);
    expect(ING).toMatch(/\? undefined/); // features === null → nearest undefined → feature_unknown
    expect(ING).toMatch(/console\.error\('\[wildfire-firms\] places/);
  });

  it('подавленное видно в ответе приёма (не молчание), а не только в логе', () => {
    expect(ROUTE).toContain('suppressed_static');
  });

  it('перепись и приём перечисляют одни и те же греющие типы мест', () => {
    const CENSUS = read('app/api/cron/firms-persistence-census/route.ts');
    expect(CENSUS).toMatch(/HEAT_TYPES = \['volcano', 'geyser', 'hot_spring'\]/);
    expect(CENSUS).toContain('judgeStatic(c, today, heat)');
  });
});

describe('перепись: только чтение, три исхода', () => {
  const SRC = read('app/api/cron/firms-persistence-census/route.ts');

  it('ничего не пишет; секрет сверяется до любого запроса к БД и к FIRMS', () => {
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    const secretAt = SRC.indexOf('timingSafeCompare');
    expect(secretAt).toBeGreaterThan(0);
    expect(secretAt).toBeLessThan(SRC.indexOf('pool.query'));
    expect(secretAt).toBeLessThan(SRC.indexOf('fetchWindow(key)'));
  });

  it('нет ключа и отказ FIRMS — «не смогли спросить» (asked:false с причиной), а не пустой список', () => {
    expect(SRC).toMatch(/asked: false, reason: 'no_key'/);
    expect(SRC).toMatch(/asked: false, reason: 'firms_failed'/);
    expect(SRC).toMatch(/console\.error\('\[firms-persistence-census\] FIRMS не ответил'/);
  });

  it('ошибку FIRMS с кодом 200 (текст вместо CSV) не принимает за ответ', () => {
    expect(SRC).toMatch(/!\/latitude\/i\.test\(csv\.split/);
  });

  it('просит 10 суток, при отказе 5, и называет, сколько получил (window_days)', () => {
    expect(SRC).toMatch(/const WINDOWS = \[10, 5\]/);
    expect(SRC).toMatch(/window_days: got\.days/);
  });

  it('запускающий назван: свой workflow, маркер, ожидание свежей сборки', () => {
    const wf = read('.github/workflows/firms-persistence-census.yml');
    expect(wf).toContain('.github/triggers/firms-persistence-census.json');
    expect(wf).toContain('/api/cron/firms-persistence-census');
    expect(wf).toContain('run: bash scripts/wait-for-deploy.sh');
    expect(wf).toMatch(/REQUIRE_FRESH: '1'/);
  });
});
