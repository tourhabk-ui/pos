/**
 * Volcano OS Cockpit (P3) — read-only наблюдение, не пульт управления.
 *
 * Панель заводилась с одним жёстким условием (модель автономии 27.08):
 * человек принимает ровно одно решение — merge/reject agent-PR В GITHUB.
 * Кокпит это решение ПОКАЗЫВАЕТ, но не исполняет: ни одной мутации ни в
 * API-роуте, ни в клиенте быть не должно. Панель, из которой можно
 * «подтолкнуть» задачу, — это второй операционный путь мимо policy ядра,
 * ровно то, что Kernel v1 закрывал.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prUrlFromResource } from '@/app/hub/admin/volcano/_VolcanoClient';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const API = read('app/api/admin/volcano/route.ts');
const CLIENT = read('app/hub/admin/volcano/_VolcanoClient.tsx');
const LAYOUT = read('app/hub/admin/layout.tsx');

describe('API кокпита: только чтение, только админ', () => {
  it('роут отдаёт ТОЛЬКО GET — других методов нет', () => {
    expect(API).toMatch(/export async function GET/);
    expect(API).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('вход только для админа', () => {
    expect(API).toMatch(/requireAdmin/);
    // Проверка стоит ДО первого запроса к БД.
    expect(API.indexOf('requireAdmin')).toBeLessThan(API.indexOf('pool.query'));
  });

  it('ни одной мутации в SQL — SELECT и только SELECT', () => {
    // Судим по коду без строк-комментариев: проза имеет право упоминать слова.
    const code = API.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/INSERT\s+INTO|UPDATE\s+agent|DELETE\s+FROM|TRUNCATE/i);
  });

  it('task_id проверяется как UUID до запроса — путь из URL не доверенный', () => {
    expect(API).toMatch(/UUID_RE/);
    expect(API.indexOf('UUID_RE.test')).toBeLessThan(API.indexOf('agent_tasks WHERE id'));
  });

  it('отсутствие прогонов Evo — «не было», а не пустая рамка (§4.0)', () => {
    expect(API).toMatch(/last_evo_run: lastEvoTask \?\? null/);
  });

  it('состав эволюции (29.08): статус стадий читается из note-событий последнего прогона, не выдуман при отсутствии задачи', () => {
    expect(API).toMatch(/evo_stages/);
    expect(API).toMatch(/if \(lastEvoTask\)/);
    // Без задачи — пустой массив, а не выдуманные ok:true/false.
    expect(API).toMatch(/let evoStages: Array<\{ key: string; ok: boolean \}> = \[\];/);
  });

  it('зависшие эффекты (P3) читаются тем же read-only путём, что и остальное', () => {
    expect(API).toMatch(/findStuckEffects/);
    expect(API.indexOf('requireAdmin')).toBeLessThan(API.indexOf('findStuckEffects'));
  });
});

describe('клиент кокпита: наблюдение без кнопок действия', () => {
  it('все fetch — на /api/admin/volcano, без методов мутации', () => {
    const fetches = CLIENT.match(/fetch\([^)]*\)/g) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) {
      expect(f).toContain('/api/admin/volcano');
      expect(f).not.toMatch(/POST|PUT|PATCH|DELETE/);
    }
  });

  it('нет обращений к мутирующим админ-роутам (execute-all, trigger и т.п.)', () => {
    expect(CLIENT).not.toMatch(/execute-all|\/trigger|merge_pull/);
  });

  it('отказ загрузки назван отказом, а не нулями', () => {
    expect(CLIENT).toMatch(/не смогла прочитать/);
    expect(CLIENT).toMatch(/отказ чтения, а не «задач нет»/);
  });

  it('раздел «Ждут моего решения» есть, решение отправляет в GitHub', () => {
    expect(CLIENT).toMatch(/Ждут моего решения/);
    expect(CLIENT).toMatch(/Открыть PR/);
    expect(CLIENT).toMatch(/принимаются в GitHub/);
  });

  it('дизайн — токены и ds-утилиты, без хардкод-hex и эмодзи', () => {
    expect(CLIENT).toMatch(/ds-page/);
    expect(CLIENT).toMatch(/ds-card/);
    expect(CLIENT).toMatch(/var\(--text-primary\)/);
    // Хардкод-цвет в className запрещён (§2); допускается только в токенах.
    // Всегда-тёмная подложка «Состав эволюции» — тоже без хардкода, через
    // fx-dark-* классы в globals.css (тот же приём, что у fx-glass).
    expect(CLIENT).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(CLIENT).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('«Состав эволюции» (29.08): ровно те стадии, что реально есть в orchestrator.ts, статус — из данных', () => {
    const orchestrator = readFileSync(join(process.cwd(), 'lib/agents/orchestrator.ts'), 'utf-8');
    // OrchestratorResult — источник правды по именам стадий; сверяем, что
    // клиент не выдумал и не забыл ни одну.
    const resultBlock = orchestrator.slice(
      orchestrator.indexOf('export interface OrchestratorResult'),
      orchestrator.indexOf('duration_ms: number'),
    );
    const orchestratorStages = [...resultBlock.matchAll(/^\s*(\w+): unknown;/gm)].map((m) => m[1]);
    expect(orchestratorStages.length).toBeGreaterThanOrEqual(10);

    const clientStages = [...CLIENT.matchAll(/key: '(\w+)', label:/g)].map((m) => m[1]);
    expect(clientStages.sort()).toEqual(orchestratorStages.sort());

    // Статус тайла — реальный тернарник по данным (data.evo_stages), не
    // захардкоженное «всегда прошла».
    expect(CLIENT).toMatch(/data\.evo_stages\.find/);
    expect(CLIENT).toMatch(/status\.ok\s*\?\s*'стадия прошла'\s*:\s*'стадия упала'/);
  });
});

describe('prUrlFromResource: ссылка на PR из ресурса задачи', () => {
  it('github_pr owner/repo#N → ссылка на pull', () => {
    expect(prUrlFromResource('github_pr', 'tourhabk-ui/pos#1419'))
      .toBe('https://github.com/tourhabk-ui/pos/pull/1419');
  });

  it('чужой тип ресурса или кривой id — null, а не выдуманная ссылка', () => {
    expect(prUrlFromResource('agent_approval', 'abc')).toBeNull();
    expect(prUrlFromResource('github_pr', 'нет-решётки')).toBeNull();
    expect(prUrlFromResource('github_pr', null)).toBeNull();
    expect(prUrlFromResource(null, null)).toBeNull();
  });
});

describe('вход в панель существует', () => {
  it('пункт меню админки ведёт на /hub/admin/volcano', () => {
    // Экран без ссылки в меню — невидимый экран (перепись достижимости 22.08).
    expect(LAYOUT).toMatch(/\/hub\/admin\/volcano/);
    expect(LAYOUT).toMatch(/Работа Volcano OS/);
  });
});
