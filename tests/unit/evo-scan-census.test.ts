/**
 * Прочёс называет, чего он не сделал (находки E-2 и E-3 аудита 30.08).
 *
 * E-2: `scanType` не проверялся ничем. Опечатка не совпадала ни с одной веткой,
 * прогон шёл по пустому списку и возвращал `success: true, status: 'completed'`
 * при нуле находок. Воркфлоу печатал «Evo Scan OK».
 *
 * E-3: аудит записал его как одиночный дефект `scanSecurity` (пустая заглушка).
 * Разбор показал семь мест: шесть объективов через `lens()`, который возвращал
 * пустоту при отказе, плюс глухой `catch {}` в `scanPerformance`. «0 проблем»
 * означало одно из трёх — чисто, ослепло, не реализовано.
 *
 * Сторож держит РАЗЛИЧИМОСТЬ этих трёх, а не наличие полей.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const query = vi.fn();
const connect = vi.fn();
// И `query`, и `connect`: прочёс ходит первым, роут — вторым. Мок один и на
// верхнем уровне намеренно — `vi.doMock` внутри теста протекал в соседние
// (первая версия сторожа так и слегла: замоканный alert возвращал null там,
// где проверялся настоящий).
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => query(...a), connect: (...a: unknown[]) => connect(...a) },
}));
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: vi.fn(),
  callAIWaterfall: vi.fn(),
  callAIFast: vi.fn(),
}));

/** Ответы pool.query по умолчанию: пусто на SELECT, id на INSERT прогона. */
function defaultQueries() {
  query.mockImplementation(async (sql: string) => {
    if (/INSERT INTO evo_growth_scans/i.test(sql)) return { rows: [{ id: 'scan-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

describe('E-2: тип прочёса — замкнутое множество, а не любая строка', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultQueries();
  });

  it('множество типов объявлено одним местом и содержит все ветки прочёса', async () => {
    const { EVO_SCAN_TYPES, isEvoScanType } = await import('@/lib/agents/evo/growth-agent');
    expect([...EVO_SCAN_TYPES]).toEqual(['full', 'code', 'security', 'performance']);
    expect(isEvoScanType('full')).toBe(true);
    expect(isEvoScanType('securty')).toBe(false);
    expect(isEvoScanType('')).toBe(false);
  });

  it('неизвестный тип — отказ прочёса, а не тихий ноль находок', async () => {
    const { runGrowthScan } = await import('@/lib/agents/evo/growth-agent');
    await expect(runGrowthScan('securty')).rejects.toThrow(/Неизвестный тип прочёса «securty»/);
    // Ни одной записи о «завершённом» прогоне: раньше сюда уходил
    // status='complete', issues_found=0.
    const inserts = query.mock.calls.filter((c) => /INSERT INTO evo_growth_scans/i.test(String(c[0])));
    expect(inserts, 'отказ по неизвестному типу не должен записываться как прогон').toHaveLength(0);
  });

  it('роут отвечает 400 и перечисляет допустимые, не занимая лок', async () => {
    // Оркестратор, run-logger, alert и kernel-адаптер НЕ мокаются: путь отказа
    // до них не доходит, и это часть утверждения — 400 отдаётся раньше всего,
    // что стоит денег или оставляет след.
    process.env.CRON_SECRET = 'test-cron-secret';

    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/cron/evo/route');
    const res = await GET(
      new NextRequest('http://localhost/api/cron/evo?type=db', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ success: false, status: 'rejected' });
    expect(body.error).toContain('«db»');
    expect(body.error).toContain('full, code, security, performance');
    // Отказ по параметру не трогает ни лок, ни kernel-задачу.
    expect(connect, 'неверный параметр не должен занимать advisory-lock').not.toHaveBeenCalled();
  });

  it('шапка миграции 151 больше не расходится с кодом', () => {
    // Расхождение и было уликой: DDL объявлял `db` (не реализован никогда),
    // код знал `performance` (не документирован). Источник теперь один.
    const ddl = readFileSync(join(process.cwd(), 'migrations/151_evo_system.sql'), 'utf8');
    const line = ddl.split('\n').find((l) => l.includes('scan_type')) ?? '';
    expect(line, 'шапка scan_type в миграции 151 обязана перечислять то же множество').toContain(
      'full, code, security, performance',
    );
  });
});

describe('E-3: перепись объективов — «не смотрели» отделено от «чисто»', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultQueries();
  });

  it('объектив безопасности объявлен отсутствующим, а не молча пустым', async () => {
    const { runGrowthScan } = await import('@/lib/agents/evo/growth-agent');
    const res = await runGrowthScan('security').catch((e: Error) => e);

    // Единственный объектив типа `security` не реализован — значит не смотрел
    // никто, и это отказ, а не «0 проблем».
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/не отработал ни один объектив/);
    expect((res as Error).message).toMatch(/«никто не смотрел», а не «чисто»/);
  });

  it('прогон без единого сработавшего объектива записывается как failed', async () => {
    const { runGrowthScan } = await import('@/lib/agents/evo/growth-agent');
    await runGrowthScan('security').catch(() => undefined);

    const insert = query.mock.calls.find((c) => /INSERT INTO evo_growth_scans/i.test(String(c[0])));
    expect(insert, 'попытка обязана остаться в истории — иначе «не состоялся» = «не было»').toBeTruthy();
    const params = insert![1] as unknown[];
    expect(params[1], 'status прогона без объективов').toBe('failed');
    expect(String(params[4])).toContain('НЕ ПРОВЕРЕНО');
  });

  it('упавший объектив попадает в перепись с причиной и не выдаётся за чистый', async () => {
    // Запрос индексов (объектив «производительность») отказывает; прочие пусты.
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO evo_growth_scans/i.test(sql)) return { rows: [{ id: 'scan-2' }], rowCount: 1 };
      if (/information_schema\.columns/i.test(sql)) {
        const err = new Error('relation "pg_indexes" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
      return { rows: [], rowCount: 0 };
    });

    const { runGrowthScan } = await import('@/lib/agents/evo/growth-agent');
    const res = await runGrowthScan('performance').catch((e: Error) => e);

    // Единственный объектив упал — смотреть было некому, значит отказ.
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/производительность/);
  });

  it('в code-прочёсе оба объектива отработали — ноль находок здесь честный', async () => {
    const { runGrowthScan } = await import('@/lib/agents/evo/growth-agent');
    const res = await runGrowthScan('code');

    expect(res.lenses.map((l) => l.status)).toEqual(['ok', 'ok']);
    expect(res.issues).toHaveLength(0);
    const insert = query.mock.calls.find((c) => /INSERT INTO evo_growth_scans/i.test(String(c[0])));
    expect((insert![1] as unknown[])[1]).toBe('complete');
    expect(String((insert![1] as unknown[])[4])).not.toContain('НЕ ПРОВЕРЕНО');
  });

  it('scanPerformance больше не глушит отказ пустым catch', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agents/evo/growth-agent.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async function scanPerformance'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body, 'пустой catch превращает поломку запроса в «индексов не нужно» (§4.0)').not.toMatch(
      /catch\s*\{\s*(\/\/[^\n]*\n\s*)*\}/,
    );
  });

  it('заглушки scanSecurity в коде больше нет', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agents/evo/growth-agent.ts'), 'utf8');
    expect(
      /async function scanSecurity/.test(src),
      'заглушка, возвращающая пустоту, неотличима от работающего объектива',
    ).toBe(false);
  });
});

describe('E-3: алерт печатает непроверенное', () => {
  const base = {
    evolution: { processed: 0, auto_fixes: 0 },
    rescue: { alerts: [] },
    errors: [] as string[],
  };

  it('прогон без новых находок, но с ослепшим объективом, не уходит в тишину', async () => {
    const { buildEvoAlert } = await import('@/lib/agents/evo/alert');
    const text = buildEvoAlert({
      ...base,
      scan: {
        issues: [], new_issues: 0, duration_ms: 1000,
        // files_reviewed: 0 — прод как он есть: AI-ревью уехало на раннер
        // GitHub. Заодно снимает постороннее условие «решатель молчит», иначе
        // оба теста срабатывали бы независимо от переписи — то есть проверяли
        // бы не то, что заявлено.
        coverage: { source: 'disk', files_listed: 10, files_reviewed: 0, mock_files_scanned: 2 },
        lenses: [
          { name: 'схема', status: 'ok' },
          { name: 'воронка', status: 'failed', reason: 'relation "funnel_events" does not exist' },
          { name: 'безопасность', status: 'not_implemented', reason: 'объектива нет' },
        ],
      },
    });

    expect(text, 'два непроверенных объектива — это не «ничего нового»').not.toBeNull();
    expect(text).toContain('НЕ ПРОВЕРЕНО: 2 из 3');
    expect(text).toContain('воронка');
    expect(text).toContain('отказ');
    expect(text).toContain('безопасность');
    expect(text).toContain('объектива нет');
  });

  it('только отсутствующий объектив и нового нет — молчим: это не событие', async () => {
    // Первый прод-прогон после E-3 прислал «НЕ ПРОВЕРЕНО: 1 из 10 —
    // безопасность» при пустом прочёсе. Отсутствие объектива — состояние
    // постоянное и осознанное; напоминать о нём трижды в сутки значит
    // научить не читать алерт (урок EVO_FLAGSHIP_DEFERRED в том же файле).
    const { buildEvoAlert } = await import('@/lib/agents/evo/alert');
    const text = buildEvoAlert({
      ...base,
      scan: {
        issues: [], new_issues: 0, duration_ms: 1000,
        coverage: { source: 'disk', files_listed: 10, files_reviewed: 0, mock_files_scanned: 20 },
        lenses: [
          { name: 'схема', status: 'ok' },
          { name: 'безопасность', status: 'not_implemented', reason: 'объектива нет' },
        ],
      },
    });
    expect(text, 'постоянное осознанное состояние не будит владельца').toBeNull();
  });

  it('но упавший объектив будит — отказ это событие, а не состояние', async () => {
    const { buildEvoAlert } = await import('@/lib/agents/evo/alert');
    const text = buildEvoAlert({
      ...base,
      scan: {
        issues: [], new_issues: 0, duration_ms: 1000,
        coverage: { source: 'disk', files_listed: 10, files_reviewed: 0, mock_files_scanned: 20 },
        lenses: [
          { name: 'схема', status: 'ok' },
          { name: 'безопасность', status: 'not_implemented', reason: 'объектива нет' },
          { name: 'воронка', status: 'failed', reason: 'relation "funnel_events" does not exist' },
        ],
      },
    });
    expect(text, 'отказ объектива обязан быть слышен').not.toBeNull();
    // В теле перечислены ОБА непроверенных — отсутствие тоже надо видеть,
    // когда алерт всё равно уходит; поводом оно при этом не было.
    expect(text).toContain('НЕ ПРОВЕРЕНО: 2 из 3');
    expect(text).toContain('воронка');
    expect(text).toContain('безопасность');
  });

  it('все объективы отработали и нового нет — молчим, как и раньше', async () => {
    const { buildEvoAlert } = await import('@/lib/agents/evo/alert');
    const text = buildEvoAlert({
      ...base,
      scan: {
        issues: [], new_issues: 0, duration_ms: 1000,
        // files_reviewed: 0 — прод как он есть: AI-ревью уехало на раннер
        // GitHub. Заодно снимает постороннее условие «решатель молчит», иначе
        // оба теста срабатывали бы независимо от переписи — то есть проверяли
        // бы не то, что заявлено.
        coverage: { source: 'disk', files_listed: 10, files_reviewed: 0, mock_files_scanned: 2 },
        lenses: [{ name: 'схема', status: 'ok' }, { name: 'воронка', status: 'ok' }],
      },
    });
    expect(text, 'честный ноль по-прежнему не будит владельца').toBeNull();
  });
});
