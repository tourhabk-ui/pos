/**
 * P0 внешнего аудита Agent OS (27.08) — эффекты закрыты и не откатываются.
 *
 * Четыре края, каждый уже был нарушен или нарушался бы первым же ретраем:
 *
 * 1. Публикация тура — ИДЕМПОТЕНТНАЯ команда целевого состояния.
 *    `SET is_published = NOT is_published` отменял уже достигнутый результат
 *    при повторе вызова (retry модели, сеть, двойной клик).
 * 2. Evo не идёт двумя прогонами одновременно: workflow concurrency.
 * 3. Терминальная запись прогона — контракт, не необязательная телеметрия:
 *    logAgentRun возвращает исход, критичный крон (evo) его показывает.
 * 4. Атомарный захват и метод-барьер execute-all держит его собственный
 *    сторож execute-all-auth.test.ts; семантику tour_create_draft —
 *    approval-required.test.ts. Здесь — остальное.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('set_tour_published: команда называет целевое состояние', () => {
  // Судим по коду, а не по прозе в нём: файл хранит историю переименования
  // в комментарии, и она не должна ловиться как нарушение (тот же приём,
  // что в kuzmich-tour-real-photos.test.ts).
  const src = read('lib/agents/sdk/operator-tools.ts')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

  it('инструмент set_tour_published существует, toggle удалён', () => {
    expect(src).toContain("name: 'set_tour_published'");
    expect(src).not.toContain('toggle_tour_publish');
  });

  it('SQL не инвертирует состояние', () => {
    expect(src, 'вернулся NOT is_published — повтор вызова отменяет результат')
      .not.toMatch(/is_published\s*=\s*NOT\s+is_published/);
    expect(src).toMatch(/SET is_published = \$3/);
  });

  it('published — обязательный булев параметр', () => {
    expect(src).toMatch(/required: \['tour_id', 'published'\]/);
    expect(src).toMatch(/typeof args\.published !== 'boolean'/);
  });

  it('эффект оставляет след в ai_actions_log, отказ записи не молчит', () => {
    // В существующие колонки (059: action_type + metadata), не в фантомные
    // agent_id/details из ALLOWLIST фантомного сторожа.
    expect(src).toMatch(/INSERT INTO ai_actions_log \(action_type, metadata\)/);
    expect(src).toMatch(/'set_tour_published'/);
    expect(src).toMatch(/audit set_tour_published не записан/);
  });
});

describe('cron-evo.yml: один прогон за раз, терминальная запись обязательна', () => {
  const wf = read('.github/workflows/cron-evo.yml');

  it('concurrency group без cancel-in-progress', () => {
    expect(wf).toMatch(/concurrency:\s*\n\s*group: cron-evo\s*\n\s*cancel-in-progress: false/);
  });

  it('run_logged=false красит джоб', () => {
    expect(wf).toMatch(/\.run_logged == false/);
  });
});

describe('run-logger: исход записи возвращается вызывающему', () => {
  it('logAgentRun возвращает boolean, а не void', () => {
    const src = read('lib/agents/run-logger.ts');
    expect(src).toMatch(/logAgentRun\(params: RunLogParams\): Promise<boolean>/);
    expect(src).toMatch(/return true;/);
    expect(src).toMatch(/return false;/);
  });

  it('критичный крон evo ждёт запись и показывает исход в ответе', () => {
    const src = read('app/api/cron/evo/route.ts');
    expect(src).toMatch(/await logAgentRun\(/);
    expect(src, 'fire-and-forget вернулся — итог прогона снова может пропасть молча')
      .not.toMatch(/void logAgentRun\(/);
    expect(src).toMatch(/run_logged: runLogged/);
  });
});
