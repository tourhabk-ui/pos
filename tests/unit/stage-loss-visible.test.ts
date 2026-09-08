/**
 * Работа, которая пропала, не должна выглядеть как работа, которой не было.
 *
 * Две находки из «потерянных» тринадцати, обе — §4.0 в чистом виде.
 *
 * 1. РЕФЛЕКТОР ИНСАЙТОВ. Модель давала инсайты, запись каждого могла упасть, и
 *    `consolidated` становился нулём. Дальше вызывалась дымовая проверка с
 *    claimed = consolidated = 0, а она на нуле отвечает «сверять нечего» —
 *    то есть проверка ОТКЛЮЧАЛА САМА СЕБЯ ровно в том случае, ради которого
 *    её заводили. Наверх уходило smoke_passed: true, оркестратор видел
 *    выполненную стадию, ядро — успешный прогон.
 *
 * 2. ДВА EDITOR ПОД ОДНИМ ИМЕНЕМ. У записи `editor-runner` в реестре стоял
 *    `agentId: 'editor'` — тот же, что у прод-крона, — при том что
 *    комментарий рядом объявлял целью: «молчание любой из них должно быть
 *    видно отдельно». Живость раннера читалась по прогонам прода: раннер мог
 *    молчать неделями при зелёном стороже. Своей строки в истории он не
 *    писал вообще.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';

const REFLECTOR = readFileSync('lib/agents/memory-reflector.ts', 'utf8');
const ORCH = readFileSync('lib/agents/orchestrator.ts', 'utf8');
const RESULT_ROUTE = readFileSync('app/api/cron/editor-result/route.ts', 'utf8');

describe('рефлектор: потеря записи краснеет', () => {
  it('сверка идёт по ЗАЯВЛЕННОМУ моделью, а не по записанному', () => {
    // Иначе полный отказ записи обнуляет claimed, и проверка выключается.
    expect(REFLECTOR).toMatch(/smokeTestKnowledgeWrites\(AGENT_ID, insights\.length, startedAt\)/);
    expect(REFLECTOR).not.toMatch(/smokeTestKnowledgeWrites\(AGENT_ID, consolidated,/);
  });

  it('в результате есть и заявленное, и записанное — разницу видно', () => {
    expect(REFLECTOR).toMatch(/attempted: number/);
    expect(REFLECTOR).toMatch(/attempted: insights\.length/);
  });

  it('исход трёхзначный, и потеря — это failed', () => {
    expect(REFLECTOR).toMatch(/verdict: 'passed' \| 'failed' \| 'unknown'/);
    expect(REFLECTOR).toMatch(/consolidated === 0 \? 'failed'/);
    expect(REFLECTOR).toMatch(/consolidated < insights\.length \? 'failed'/);
  });

  it('молчание провайдеров — «не смог», а не успех, и пишется в лог', () => {
    expect(REFLECTOR).toMatch(/verdict: 'unknown', reason: 'ai_unavailable'/);
    expect(REFLECTOR).toContain("logSwallowedFailure('memory-reflector'");
  });

  it('оркестратор переносит потерю в свои ошибки', () => {
    expect(ORCH).toMatch(/reflector\?\.verdict === 'failed'/);
    expect(ORCH).toContain('инсайты потеряны при записи');
    expect(ORCH).toMatch(/reflector\?\.verdict === 'unknown'/);
  });
});

describe('два Editor различимы в истории', () => {
  it('у прод-крона и раннера РАЗНЫЕ agentId', () => {
    const prod = CRON_REGISTRY.find((e) => e.key === 'editor');
    const runner = CRON_REGISTRY.find((e) => e.key === 'editor-runner');
    expect(prod?.agentId).toBe('editor');
    expect(runner?.agentId).toBe('editor-runner');
    expect(runner?.agentId).not.toBe(prod?.agentId);
  });

  it('вообще ни одна пара записей реестра не делит agentId', () => {
    // Общее правило, а не заплатка на один случай: общий идентификатор
    // делает живость любой из пары нечитаемой.
    const seen = new Map<string, string>();
    for (const e of CRON_REGISTRY) {
      if (e.agentId === null) continue;
      const prev = seen.get(e.agentId);
      expect(prev, `${e.key} и ${prev} делят agentId ${e.agentId}`).toBeUndefined();
      seen.set(e.agentId, e.key);
    }
  });

  it('раннер оставляет СВОЮ строку в истории', () => {
    expect(RESULT_ROUTE).toMatch(/agent_id: 'editor-runner'/);
    expect(RESULT_ROUTE).toContain('items_created: written');
  });

  it('ноль принятых при непустом ответе раннера — отказ, а не успех', () => {
    expect(RESULT_ROUTE).toMatch(/written === 0 && items\.length > 0 \? 'failed'/);
    expect(RESULT_ROUTE).toMatch(/rejected\.length > 0 \? 'partial'/);
  });
});
