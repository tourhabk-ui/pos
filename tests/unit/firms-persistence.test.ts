// @vitest-environment node
/**
 * Термоточки FIRMS, стоящие на месте несколько суток (скрин владельца 09.10:
 * «неделю в одном месте»). Чистая логика и форма переписи.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MIN_DAYS, distanceKm, parseFirmsRows, persistentCells, type FirmsRow,
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

describe('ячейки, где обнаружения повторяются в разные сутки', () => {
  const week = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];

  it('неделя на одном месте — одна ячейка, 7 суток, разброс ~0, порядок суток по возрастанию', () => {
    const rows = [...week].reverse().map((d) => row({ acqDate: d, frp: 9 + (d.endsWith('4') ? 4 : 0) }));
    const cells = persistentCells(rows);
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
    const [c] = persistentCells(rows);
    expect(c.days).toHaveLength(3);
    expect(c.detections).toBe(4);
    expect(c.perDay).toEqual([2, 1, 1]);
  });

  it('порог по умолчанию — три суток; меньше не считается «стоящей»', () => {
    expect(DEFAULT_MIN_DAYS).toBe(3);
    expect(persistentCells([row(), row({ acqDate: '2026-10-02' })])).toEqual([]);
    expect(persistentCells([row(), row({ acqDate: '2026-10-02' })], { minDays: 2 })).toHaveLength(1);
  });

  it('движущийся фронт не склеивается в «стоящий»: каждые сутки в 5 км от прошлых — это разные ячейки', () => {
    const rows = week.map((d, i) => row({ acqDate: d, lat: 54.62 + i * 0.05 }));
    expect(persistentCells(rows)).toEqual([]);
  });

  it('разброс считается между обнаружениями ячейки (километры, а не градусы)', () => {
    // 54.625 и 54.633 — внутри одной ячейки (не на её краю: край режет источник надвое, см. шапку persistentCells)
    const rows = [row({ lat: 54.625 }), row({ acqDate: '2026-10-02', lat: 54.633 }), row({ acqDate: '2026-10-03', lat: 54.625 })];
    const [c] = persistentCells(rows);
    expect(c.spreadKm).toBeGreaterThan(0.8);
    expect(c.spreadKm).toBeLessThan(1);
    expect(distanceKm(54.625, 160.3, 54.633, 160.3)).toBeCloseTo(c.spreadKm, 5);
  });

  it('сначала те, что стоят дольше; потом те, где больше обнаружений', () => {
    const a = week.slice(0, 5).map((d) => row({ acqDate: d, lat: 54.1 }));
    const b = week.slice(0, 3).flatMap((d) => [row({ acqDate: d, lat: 55.3 }), row({ acqDate: d, lat: 55.3, acqTime: '0100' })]);
    const cells = persistentCells([...b, ...a]);
    expect(cells.map((c) => c.days.length)).toEqual([5, 3]);
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
