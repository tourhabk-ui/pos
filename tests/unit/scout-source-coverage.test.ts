/**
 * Разведка называет молчащие фиды поимённо и сторожит их все.
 *
 * Владелец 28.07 запустил дайджест вручную и получил в ответе
 *   {"sources_ok":6,"sources_total":12,"dead_sources":[]}
 * — половина разведки молчит, ни одного мёртвого источника не названо. Обе
 * половины этой строки оказались неинформативны по разным причинам:
 *
 *  1. `dead_sources` пуст не потому, что всё живо. `evaluateDeadSources` идёт
 *     по SCOUT_SOURCE_EXPECTATIONS, а там было 9 ключей на 12 фидов: АТОР,
 *     Skift и Product Hunt добавили в разведку и забыли добавить в сторожа.
 *     Эти три могли молчать неограниченно долго — сторож про них не знал.
 *  2. «6 из 12» — тревога без адреса. Какие шесть и почему (упал / отдал
 *     пусто) — в ответе не было, а фиды из среды сборки недостижимы: прогон —
 *     единственный свидетель. Разбирать было буквально нечего.
 *
 * Тот же класс, что KVERT и kamgov: агрегат выглядит как здоровье, потому что
 * не показывает, из чего сложился.
 */
import { describe, it, expect } from 'vitest';
import { RSS_SOURCES } from '@/lib/agents/scout-digest';
import {
  SCOUT_SOURCE_EXPECTATIONS,
  buildSourceReport,
  applyRun,
  type ScoutHealthMap,
} from '@/lib/services/scout/source-health';

describe('сторож покрывает всю разведку', () => {
  const watched = new Set(SCOUT_SOURCE_EXPECTATIONS.map((e) => e.key));
  const configured = new Set(RSS_SOURCES.map((s) => s.key));

  it('каждый настроенный фид имеет порог тишины', () => {
    const unwatched = RSS_SOURCES.filter((s) => !watched.has(s.key)).map((s) => s.key);
    expect(unwatched, 'фид без ожидания не сторожится и не попадёт в dead_sources').toEqual([]);
  });

  it('нет ожиданий по фидам, которых уже нет', () => {
    const phantom = SCOUT_SOURCE_EXPECTATIONS.filter((e) => !configured.has(e.key)).map((e) => e.key);
    expect(phantom, 'фантомное ожидание вечно висит как молчащий источник').toEqual([]);
  });

  it('порог тишины осмысленный: не ноль и не вечность', () => {
    for (const e of SCOUT_SOURCE_EXPECTATIONS) {
      expect(e.maxSilenceHours, e.key).toBeGreaterThanOrEqual(48);
      expect(e.maxSilenceHours, e.key).toBeLessThanOrEqual(336);
    }
  });
});

describe('пофидовый отчёт прогона', () => {
  const NOW = Date.parse('2026-07-28T07:00:00Z');
  const entries = [
    { key: 'skift', label: 'Skift', category: 'reference', status: 'empty' as const, rawItems: 0, inserted: 0 },
    { key: 'rata', label: 'RATA', category: 'travel', status: 'ok' as const, rawItems: 5, inserted: 0 },
    { key: 'ator', label: 'АТОР', category: 'travel', status: 'error' as const, rawItems: 0, inserted: 0 },
  ];

  it('называет каждый фид, его исход и сколько он молчит', () => {
    const prev: ScoutHealthMap = {
      skift: {
        label: 'Skift', last_status: 'empty', last_run_at: '2026-07-27T07:00:00Z',
        last_nonempty_at: '2026-07-24T07:00:00Z', first_seen_at: '2026-06-01T07:00:00Z',
        last_alerted_at: null, raw_items: 0,
      },
    };
    const map = applyRun(prev, entries, new Date(NOW).toISOString());
    const report = buildSourceReport(entries, map, NOW);

    const skift = report.find((r) => r.key === 'skift');
    expect(skift?.status).toBe('empty');
    expect(skift?.silent_hours).toBe(96);

    // Живой фид: молчания нет, отчёт это показывает нулём, а не пустотой.
    const rata = report.find((r) => r.key === 'rata');
    expect(rata?.status).toBe('ok');
    expect(rata?.items).toBe(5);
    expect(rata?.silent_hours).toBe(0);
  });

  it('фид, не дававший данных ни разу, отличим от давно молчащего', () => {
    const map = applyRun({}, entries, new Date(NOW).toISOString());
    const ator = buildSourceReport(entries, map, NOW).find((r) => r.key === 'ator');
    // null, а не 0 и не огромное число: «неизвестно с каких пор» — это факт,
    // а выдуманный срок на safety-платформе хуже отсутствия срока.
    expect(ator?.last_ok).toBeNull();
    expect(ator?.silent_hours).toBeNull();
    expect(ator?.status).toBe('error');
  });

  it('раздел дайджеста виден по категории — понятно, что именно опустеет', () => {
    const map = applyRun({}, entries, new Date(NOW).toISOString());
    const report = buildSourceReport(entries, map, NOW);
    expect(report.map((r) => r.category)).toEqual(['reference', 'travel', 'travel']);
  });

  it('без памяти отчёт всё равно честен по статусам', () => {
    const report = buildSourceReport(entries, {}, NOW);
    expect(report).toHaveLength(3);
    expect(report.every((r) => r.silent_hours === null)).toBe(true);
    expect(report.find((r) => r.key === 'rata')?.status).toBe('ok');
  });
});
