/**
 * Rescue запускается ровно одним расписанием (issue #1725).
 *
 * До 08.09 он шёл двумя сразу: свой крон `cron-rescue.yml` каждые 30 минут
 * (48 прогонов в сутки, safety-tier, роут берёт аренду окна claimCronWindow)
 * и ещё три раза в сутки изнутри оркестратора эволюции — а этот путь звал
 * функцию НАПРЯМУЮ, аренды не брал, и остановить его было нечем.
 *
 * Цена: до 51 прогона вместо 48, три из них могли лечь через минуту после
 * планового; тревоги дублировались (runRescueScan шлёт в Telegram, а не
 * только считает); бюджет прогона эволюции тратился на только что сделанную
 * работу — ровно та болезнь, из-за которой 05.09 оттуда вынули Scout Digest.
 *
 * И CLAUDE.md §8 описывала только второй путь: одна из двух записей была
 * неверна всегда. Оставлен свой крон — Rescue в safety-tier, погодные угрозы
 * ближайшим турам стоят получаса, а не восьми.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('Rescue: один запускающий', () => {
  it('оркестратор эволюции его не зовёт', () => {
    const orch = read('lib/agents/orchestrator.ts');
    expect(orch).not.toMatch(/runRescueScan\(\)/);
    expect(orch).not.toMatch(/from '@\/lib\/agents\/evo\/rescue-agent'/);
  });

  it('но и не молчит о том, что стадии здесь больше нет', () => {
    // Пропавшая стадия без отметки читалась бы кокпитом как «не выполнялась».
    expect(read('lib/agents/orchestrator.ts')).toMatch(/rescue_skip_reason: 'own_cron'/);
  });

  it('свой крон на месте — и в workflow, и в реестре', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/cron-rescue.yml'))).toBe(true);
    const registry = read('lib/agents/cron-registry.ts');
    expect(registry).toMatch(/key: 'rescue'[\s\S]{0,200}workflow: 'cron-rescue\.yml'/);
  });

  it('CLAUDE.md говорит про него то же самое, а не про эволюцию', () => {
    const md = read('CLAUDE.md');
    expect(md).toMatch(/\*\*Rescue\*\* \| Свой крон `cron-rescue\.yml`/);
    expect(md).not.toMatch(/\*\*Rescue\*\* \| В Evo/);
  });
});
