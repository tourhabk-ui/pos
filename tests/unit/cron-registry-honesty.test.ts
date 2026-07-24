/**
 * Честность реестра кронов.
 *
 * Реестр — источник правды для liveness-панели «AI и автоматизации» и для
 * сторожа safety-кронов (watchdog). Его шапка сама запрещает врать зелёным про
 * непроверяемую джобу. Но реестр — РУЧНЫЕ данные, и он молча расходится с
 * .github/workflows.
 *
 * Сверка 24.07 нашла два расхождения, которые эти тесты фиксируют навсегда:
 *  1. redteam-kuzmich.yml (крон + вызов /api/cron/kuzmich-redteam) отсутствовал
 *     в реестре — имя файла не по шаблону cron-*.yml, поэтому джоба не
 *     показывалась в панели вообще.
 *  2. Запись недельного faithfulness-eval указывала agentId 'kuzmich-redteam' —
 *     телеметрию ДРУГОЙ (ежемесячной) джобы. Панель могла показывать недельный
 *     прогон живым по чужим запускам — ровно тот ложный зелёный, который
 *     реестр объявляет недопустимым.
 *
 * Тесты читают ФАЙЛЫ, а не рассуждают: workflow-файлы + исходники cron-роутов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';

const WF_DIR = join(process.cwd(), '.github', 'workflows');
const workflowFiles = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));

function read(f: string): string {
  return readFileSync(join(WF_DIR, f), 'utf8');
}
function cronsOf(src: string): string[] {
  return [...src.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
}
function cronEndpointsOf(src: string): string[] {
  return [...new Set([...src.matchAll(/\/api\/cron\/([a-z0-9-]+)/g)].map((m) => m[1]))];
}

describe('cron-registry: записи указывают на существующие workflow', () => {
  it('у каждой записи файл workflow существует (нет фантомов)', () => {
    const missing = CRON_REGISTRY
      .filter((e) => !existsSync(join(WF_DIR, e.workflow)))
      .map((e) => `${e.key} -> ${e.workflow}`);
    expect(missing, `в реестре есть записи без файла: ${missing.join(', ')}`).toEqual([]);
  });

  it('cron-выражение записи совпадает с workflow', () => {
    const mismatched = CRON_REGISTRY
      .filter((e) => existsSync(join(WF_DIR, e.workflow)))
      .filter((e) => !cronsOf(read(e.workflow)).includes(e.cron))
      .map((e) => `${e.key}: реестр '${e.cron}' vs workflow ${JSON.stringify(cronsOf(read(e.workflow)))}`);
    expect(mismatched, `расписания разошлись: ${mismatched.join(' | ')}`).toEqual([]);
  });

  it('ключи записей уникальны', () => {
    const keys = CRON_REGISTRY.map((e) => e.key);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

describe('cron-registry: покрыты все платформенные кроны', () => {
  it('каждый workflow с расписанием, дёргающий /api/cron/*, есть в реестре', () => {
    const registered = new Set(CRON_REGISTRY.map((e) => e.workflow));
    const uncovered = workflowFiles.filter((f) => {
      const src = read(f);
      return cronsOf(src).length > 0 && cronEndpointsOf(src).length > 0 && !registered.has(f);
    });
    expect(
      uncovered,
      `платформенные кроны вне реестра (не видны в liveness-панели): ${uncovered.join(', ')}`,
    ).toEqual([]);
  });
});

describe('cron-registry: agentId соответствует телеметрии своей джобы', () => {
  it('agentId записи реально пишется эндпоинтом её же workflow', () => {
    const problems: string[] = [];

    for (const e of CRON_REGISTRY) {
      if (!e.agentId) continue;                       // null = «нет телеметрии», это честно
      if (!existsSync(join(WF_DIR, e.workflow))) continue;

      const endpoints = cronEndpointsOf(read(e.workflow));
      if (endpoints.length === 0) continue;           // джоба без платформенного вызова

      // Собираем agent_id, которые пишут роуты ЭТОЙ джобы.
      const written = new Set<string>();
      let anyRouteFound = false;
      for (const ep of endpoints) {
        const routeFile = join(process.cwd(), 'app', 'api', 'cron', ep, 'route.ts');
        if (!existsSync(routeFile)) continue;
        anyRouteFound = true;
        const src = readFileSync(routeFile, 'utf8');
        for (const m of src.matchAll(/agent_id:\s*'([a-z0-9-]+)'/g)) written.add(m[1]);
        // Динамический agent_id (тернарник) — собираем обе ветки строк.
        for (const m of src.matchAll(/agent_id:[^,\n]*\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/g)) {
          written.add(m[1]); written.add(m[2]);
        }
      }
      if (!anyRouteFound || written.size === 0) continue; // нечего сверять

      if (!written.has(e.agentId)) {
        problems.push(
          `${e.key} (${e.workflow}): реестр ждёт '${e.agentId}', ` +
          `а роуты ${endpoints.join('/')} пишут ${JSON.stringify([...written])}`,
        );
      }
    }

    expect(
      problems,
      `ЛОЖНЫЙ ЗЕЛЁНЫЙ: запись живёт по чужой телеметрии — ${problems.join(' | ')}`,
    ).toEqual([]);
  });
});
