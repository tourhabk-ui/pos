/**
 * Rescue запускается ровно одним расписанием (issue #1725).
 *
 * До 08.09 он шёл двумя сразу: свой крон каждые 30 минут (48 прогонов в
 * сутки, safety-tier, роут берёт аренду окна claimCronWindow) и ещё три раза
 * в сутки изнутри оркестратора эволюции — а этот путь звал функцию НАПРЯМУЮ,
 * аренды не брал, и остановить его было нечем.
 *
 * Цена: до 51 прогона вместо 48, три из них могли лечь через минуту после
 * планового; тревоги дублировались (runRescueScan шлёт в Telegram, а не
 * только считает); бюджет прогона эволюции тратился на только что сделанную
 * работу — ровно та болезнь, из-за которой 05.09 оттуда вынули Scout Digest.
 *
 * И CLAUDE.md §8 описывала только второй путь: одна из двух записей была
 * неверна всегда. Оставлен свой крон — Rescue в safety-tier, погодные угрозы
 * ближайшим турам стоят получаса, а не восьми.
 *
 * ── 20.09: тот же инвариант, другая физика ──────────────────────────────
 *
 * `cron-rescue.yml` (отдельный файл) сведён в `cron-safety-heartbeat.yml`
 * вместе с шестью другими получасовыми safety/ops-кронами — семь отдельных
 * scheduled-записей конкурировали за очередь GitHub Actions, и замер 20.09
 * (Actions API, не логи) показал, что смещение минуты эту конкуренцию не
 * снимает. Физический файл сменился; инвариант, который держит этот тест, —
 * НЕТ, единственный триггер, оркестратор не дублирует — остаётся тем же.
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

  it('крон на месте — и в workflow, и в реестре, и это один и тот же файл', () => {
    const registry = read('lib/agents/cron-registry.ts');
    const m = registry.match(/key: 'rescue'[\s\S]{0,200}workflow: '([^']+)'/);
    expect(m, 'ключ rescue не найден в реестре').not.toBeNull();
    const workflow = m![1];
    expect(existsSync(join(process.cwd(), '.github/workflows', workflow)), `реестр указывает на ${workflow}, файла нет`).toBe(true);
    // Rescue делит workflow-файл с другими safety/ops-кронами с 20.09 —
    // проверяем, что в НЁМ реально есть шаг, дёргающий /api/cron/rescue, а
    // не просто что файл существует под любым содержимым.
    expect(read(join('.github/workflows', workflow))).toContain('/api/cron/rescue');
  });

  it('CLAUDE.md говорит про него то же самое, а не про эволюцию', () => {
    const md = read('CLAUDE.md');
    expect(md).toMatch(/\*\*Rescue\*\* \|.*cron-safety-heartbeat\.yml/);
    expect(md).not.toMatch(/\*\*Rescue\*\* \| В Evo/);
  });
});
