/**
 * Сторож: перепись маршрутов называет, когда сделаны сверки с источником и
 * когда они устареют.
 *
 * ── Повод (13.11.2026) ─────────────────────────────────────────────────────
 *
 * Право вести по линии без путевых точек (решение A плана порядка маршрутов)
 * держится на трёх уликах, и одна из них — свежая сверка нашей копии с
 * оригиналом. Сверку с чужим сайтом владелец снял 07.09 вместе со
 * скрейперами. Сохранённые сверки годны 90 дней и сделаны одним прогоном,
 * значит устаревают разом: в один день право пропадает у двухсот маршрутов, и
 * порог еженедельной переписи краснеет.
 *
 * Перепись печатала «свежих 231» — сколько, но не до какого дня. Дату
 * пришлось выводить по истории запусков GitHub. Владелец: «читай базу прода».
 * Прямого доступа к базе у сессии нет; читает её перепись на проде, и теперь
 * она отдаёт сами даты.
 *
 * Судится поведение: функция — вызовом, перепись — вызовом с подставной
 * базой, печать итога — исполнением настоящего скрипта из workflow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { sourceCheckDates, checkFreshness, CHECK_FRESH_DAYS, SOURCE_RECHECK_AVAILABLE } from '@/lib/routes/track-reconcile';
import { runGeometryAudit } from '@/lib/routes/geometry-audit';

const NOW = new Date('2026-11-13T05:00:00Z');

describe('даты сверок: когда сделаны и когда устареют', () => {
  it('самая ранняя, самая поздняя, счёт по дням и срок — из самих сверок', () => {
    // Первые две строки — в том виде, в каком PostgreSQL отдаёт checked_at::text.
    const r = sourceCheckDates(
      ['2026-08-19 00:00:05.123456+00', '2026-08-19 00:13:50+00', new Date('2026-08-20T10:00:00Z')],
      NOW,
    );
    expect(r).toEqual({
      readable: true, total: 3, undated: 0,
      oldest_checked_at: '2026-08-19T00:00:05.123Z',
      newest_checked_at: '2026-08-20T10:00:00.000Z',
      by_day: { '2026-08-19': 2, '2026-08-20': 1 },
      fresh_days: CHECK_FRESH_DAYS,
      first_expires_at: '2027-08-19T00:00:05.123Z',
      last_expires_at: '2027-08-20T10:00:00.000Z',
      expired: 0,
      recheck_available: false,
    });
  });

  it('просроченные считаются тем же правилом, что свежесть улики', () => {
    const at = '2026-08-19T00:13:50Z';
    // За секунду до срока — ещё свежая, через секунду после — уже нет.
    expect(sourceCheckDates([at], new Date('2027-08-19T00:13:49Z')).expired).toBe(0);
    expect(sourceCheckDates([at], new Date('2027-08-19T00:13:51Z')).expired).toBe(1);
    for (const now of ['2026-11-23T04:10:00Z', '2027-08-19T00:13:49Z', '2027-08-19T00:13:51Z', '2027-08-23T04:10:00Z']) {
      const n = new Date(now);
      const stale = checkFreshness({ checkedAt: at, geometryHash: null }, null, n) === 'review_due';
      expect(sourceCheckDates([at], n).expired, now).toBe(stale ? 1 : 0);
    }
  });

  it('срок устаревания — ровно дата сверки плюс срок годности', () => {
    const r = sourceCheckDates(['2026-08-19T00:13:50Z'], NOW);
    const termMs = CHECK_FRESH_DAYS * 86_400_000;
    expect(new Date(r.first_expires_at as string).getTime() - new Date(r.oldest_checked_at as string).getTime()).toBe(termMs);
    expect(r.first_expires_at).toBe(r.last_expires_at);
  });

  it('сверок нет — нули и пустые даты, а не выдуманный срок', () => {
    expect(sourceCheckDates([], NOW)).toMatchObject({
      readable: true, total: 0, undated: 0, oldest_checked_at: null, newest_checked_at: null,
      by_day: {}, first_expires_at: null, last_expires_at: null, expired: 0,
    });
  });

  it('дата не разобралась — строка посчитана отдельно и срока не двигает', () => {
    const r = sourceCheckDates(['2026-08-19T00:00:00Z', null, undefined, 'не дата'], NOW);
    expect(r.total).toBe(4);
    expect(r.undated).toBe(3);
    expect(r.by_day).toEqual({ '2026-08-19': 1 });
    expect(r.oldest_checked_at).toBe('2026-08-19T00:00:00.000Z');
    expect(sourceCheckDates([null, 'не дата'], NOW)).toMatchObject({ total: 2, undated: 2, oldest_checked_at: null, first_expires_at: null });
  });

  it('таблица не прочиталась — «не смог», а не «сверок нет»', () => {
    const r = sourceCheckDates(['2026-08-19T00:00:00Z'], NOW, false);
    expect(r.readable).toBe(false);
    expect(r).toMatchObject({ total: 0, oldest_checked_at: null, first_expires_at: null, by_day: {} });
  });
});

describe('срок сверки — год (слово владельца 13.11 «продлить»)', () => {
  // Все сверки на проде сделаны 19.08.2026 с 00:06 до 00:14 UTC (перепись 13.11).
  const check = { checkedAt: '2026-08-19T00:13:48Z', geometryHash: 'h' };

  it('сверка 19.08.2026 свежа в понедельники 16.11 и 23.11.2026 и устаревает через год', () => {
    expect(CHECK_FRESH_DAYS).toBe(365);
    for (const monday of ['2026-11-16T12:00:00Z', '2026-11-23T12:00:00Z', '2027-08-16T12:00:00Z']) {
      expect([monday, checkFreshness(check, 'h', new Date(monday))]).toEqual([monday, 'current']);
    }
    expect(checkFreshness(check, 'h', new Date('2027-08-19T00:13:49Z'))).toBe('review_due');
    expect(checkFreshness(check, 'h', new Date('2027-08-23T12:00:00Z'))).toBe('review_due');
  });

  it('продление не подменяет другую линию: изменилась геометрия — улика неизвестна, как и была', () => {
    expect(checkFreshness(check, 'другая', new Date('2026-11-23T12:00:00Z'))).toBe('unknown');
  });

  it('«повторить сверку нечем» — правда о коде: строк в таблицу сверок никто не пишет', () => {
    // Запрет, а не форма: появился писатель — константу меняют в том же PR.
    // Обходится весь репозиторий, а не три каталога (ревью к #3326): сверки
    // вернула бы и миграция с INSERT, и шаг workflow, и скрипт вне scripts/.
    // Чего сторож не видит и не обещает: имя таблицы, собранное из переменной.
    const SKIP = new Set(['node_modules', '.git', '.next', 'public', 'media', 'coverage', 'dist', 'out', 'tests', 'test', 'docs']);
    const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sql|py|sh|ya?ml)$/;
    const WRITES = /\b(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|MERGE\s+INTO|COPY)\s+(?:"?public"?\s*\.\s*)?"?route_source_checks\b/i;
    const writers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path);
        else if (e.isFile() && CODE.test(e.name) && WRITES.test(readFileSync(path, 'utf8'))) writers.push(relative(process.cwd(), path));
      }
    };
    walk(process.cwd());
    expect(SOURCE_RECHECK_AVAILABLE).toBe(false);
    expect(writers).toEqual([]);
    // Сам шаблон узнаёт запись в тех видах, в каких её пишут.
    for (const sql of [
      'INSERT INTO route_source_checks (route_id) VALUES ($1)',
      'insert into public.route_source_checks select 1',
      'INSERT INTO "route_source_checks" DEFAULT VALUES',
      'UPDATE ONLY route_source_checks SET verdict = $1',
      'COPY route_source_checks FROM STDIN',
      'MERGE INTO route_source_checks t USING s ON true',
    ]) expect([sql, WRITES.test(sql)]).toEqual([sql, true]);
    for (const sql of ['SELECT * FROM route_source_checks', 'CREATE TABLE IF NOT EXISTS route_source_checks (', 'COMMENT ON TABLE route_source_checks IS']) {
      expect([sql, WRITES.test(sql)]).toEqual([sql, false]);
    }
  });
});

describe('перепись отдаёт даты сверок', () => {
  const ROUTES = [{ id: 'r1', title: 'Тропа', geometry: { type: 'LineString', coordinates: [[158.6, 53.0], [158.7, 53.1]] } }];
  let errSpy: ReturnType<typeof vi.spyOn>;

  function scene(checks: 'throws' | Array<{ route_id: string; verdict: string; checked_at: string | null; geometry_hash: string | null }>) {
    queryMock.mockImplementation((sql: string) => {
      const q = String(sql);
      if (q.includes('FROM route_source_checks')) {
        if (checks === 'throws') return Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
        return Promise.resolve({ rows: checks });
      }
      if (q.includes('COUNT(*)')) return Promise.resolve({ rows: [{ n: String(ROUTES.length) }] });
      if (q.includes('FROM route_waypoints')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: ROUTES });
    });
  }

  beforeEach(() => {
    queryMock.mockReset();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it('строки сверок есть — в ответе их даты и день, когда они устареют', async () => {
    scene([
      { route_id: 'r1', verdict: 'same', checked_at: '2026-08-19 00:00:05+00', geometry_hash: 'h' },
      { route_id: 'r2', verdict: 'same', checked_at: '2026-08-19 00:13:50+00', geometry_hash: 'h' },
    ]);
    const { source_checks: sc } = await runGeometryAudit();
    expect(sc).toMatchObject({
      readable: true, total: 2, undated: 0,
      oldest_checked_at: '2026-08-19T00:00:05.000Z',
      newest_checked_at: '2026-08-19T00:13:50.000Z',
      by_day: { '2026-08-19': 2 },
      first_expires_at: '2027-08-19T00:00:05.000Z',
      last_expires_at: '2027-08-19T00:13:50.000Z',
      recheck_available: false,
    });
  });

  it('сверок в таблице нет — блок есть, дат нет', async () => {
    scene([]);
    const { source_checks: sc } = await runGeometryAudit();
    expect(sc).toMatchObject({ readable: true, total: 0, oldest_checked_at: null, first_expires_at: null });
  });

  it('таблица не прочиталась — перепись жива, отказ назван в ответе и в логе', async () => {
    scene('throws');
    const audit = await runGeometryAudit();
    expect(audit.routes_counted).toBe(1);
    expect(audit.source_checks).toMatchObject({ readable: false, total: 0, oldest_checked_at: null });
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('route_source_checks');
    expect(logged).toContain('sqlstate=42P01');
  });
});

// Итог прогона печатает скрипт внутри workflow. Он исполняется настоящим
// python3 на подставном ответе переписи: судится то, что прочтёт человек.
describe('итог прогона переписи называет даты сверок', () => {
  type WfStep = { name?: string; run?: string };
  const WF = readFileSync(join(process.cwd(), '.github/workflows/route-data-audit.yml'), 'utf8');
  const doc = load(WF) as { jobs: Record<string, { steps: WfStep[] }> };
  const step = Object.values(doc.jobs).flatMap((j) => j.steps).find((st) => st.name === 'Спросить перепись и показать ответ');
  const run = step?.run ?? '';
  const from = run.indexOf("python3 - <<'PY'\n");
  const to = run.indexOf('\nPY', from);
  const script = from >= 0 && to > from ? run.slice(from + "python3 - <<'PY'\n".length, to) : '';

  function summary(audit: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'census-summary-'));
    try {
      const file = join(dir, 'audit.json');
      writeFileSync(file, JSON.stringify(audit));
      const r = spawnSync('python3', ['-'], {
        input: script.split("'/tmp/audit.json'").join(JSON.stringify(file)),
        encoding: 'utf8', env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8' },
      });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const BASE = { routes_counted: 368, trust: { states: { navigable: 210 }, led_by_evidence: 203, freshness: { current: 231 } } };

  it('скрипт итога найден и читает ответ переписи из файла', () => {
    expect(script.length).toBeGreaterThan(1000);
    expect(script).toContain("'/tmp/audit.json'");
  });

  it('даты стоят в итоге — после слова ИТОГ, с днём устаревания', () => {
    const out = summary({
      ...BASE,
      source_checks: {
        readable: true, total: 231, undated: 0,
        oldest_checked_at: '2026-08-19T00:00:05.000Z', newest_checked_at: '2026-08-19T00:13:50.000Z',
        by_day: { '2026-08-19': 231 }, fresh_days: 365,
        first_expires_at: '2027-08-19T00:00:05.000Z', last_expires_at: '2027-08-19T00:13:50.000Z', expired: 0,
        recheck_available: false,
      },
    });
    const tail = out.slice(out.indexOf('ИТОГ'));
    expect(out.indexOf('ИТОГ')).toBeGreaterThanOrEqual(0);
    expect(tail).toContain('сверок с источником записано: 231');
    expect(tail).toContain('сделаны: с 2026-08-19T00:00:05.000Z по 2026-08-19T00:13:50.000Z');
    expect(tail).toContain('по дням: 2026-08-19 — 231');
    expect(tail).toContain('годны 365 дней: устареют с 2027-08-19T00:00:05.000Z по 2027-08-19T00:13:50.000Z');
    expect(tail).toContain('уже за сроком: 0');
    // Продление срока сверку не обновляет — это сказано рядом с датой.
    expect(tail).toContain('повторить сверку нечем: после этого срока право по трём уликам пропадёт насовсем');
  });

  it('сверку можно повторить или сборка об этом молчит — строки «нечем» нет', () => {
    const dated = {
      readable: true, total: 1, undated: 0, oldest_checked_at: '2026-08-19T00:00:05.000Z', newest_checked_at: '2026-08-19T00:00:05.000Z',
      by_day: { '2026-08-19': 1 }, fresh_days: 365, first_expires_at: '2027-08-19T00:00:05.000Z', last_expires_at: '2027-08-19T00:00:05.000Z', expired: 0,
    };
    expect(summary({ ...BASE, source_checks: { ...dated, recheck_available: true } })).not.toContain('повторить сверку нечем');
    expect(summary({ ...BASE, source_checks: dated })).not.toContain('повторить сверку нечем');
  });

  it('таблица не прочиталась — так и сказано, числа не печатаются', () => {
    const out = summary({ ...BASE, source_checks: { readable: false, total: 0 } });
    expect(out).toContain('ДАТЫ СВЕРОК НЕ ПРОЧИТАЛИСЬ');
    expect(out).not.toContain('сверок с источником записано');
  });

  it('сверок нет — число названо, выдуманных дат нет', () => {
    const out = summary({ ...BASE, source_checks: { readable: true, total: 0, undated: 0, oldest_checked_at: null, by_day: {}, fresh_days: 90, expired: 0 } });
    expect(out).toContain('сверок с источником записано: 0');
    expect(out).not.toContain('устареют с');
  });

  it('старая сборка без блока — о датах ни слова, а не «сверок нет»', () => {
    const out = summary(BASE);
    expect(out).not.toContain('сверок с источником');
    expect(out).not.toContain('ДАТЫ СВЕРОК');
  });
});
