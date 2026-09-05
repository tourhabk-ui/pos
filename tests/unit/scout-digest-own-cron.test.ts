// @vitest-environment node
/**
 * Дайджест идёт своим кроном, а не стадией эволюции (05.09, решение владельца).
 *
 * Замер прогона 389: evo.run 321 с, из них дайджест 321 с, остальные стадии
 * вместе меньше 30 с. Роут — maxDuration 300; прогоны 386-388 умерли на
 * сервере без ответа и без записи. Один агент съедал бюджет всей системы.
 *
 * Три звена, и сторожатся все: расписание у workflow есть; ожидание «своей
 * сборки» не крутится 25 минут по расписанию; реестр знает крон и его
 * журнал; оркестратор дайджест не зовёт (это стережёт scout-run-journal).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_REGISTRY, CRON_IDLE_MEANING } from '@/lib/agents/cron-registry';

const WF = readFileSync(join(process.cwd(), '.github/workflows/cron-scout-digest.yml'), 'utf-8');
const EVO_WF = readFileSync(join(process.cwd(), '.github/workflows/cron-evo.yml'), 'utf-8');

describe('у дайджеста своё расписание', () => {
  it('workflow идёт по schedule', () => {
    expect(WF).toMatch(/^\s+schedule:\n\s+- cron: '0 7,17 \* \* \*'/m);
  });

  it('ожидание своей сборки — только у запуска маркером', () => {
    // По расписанию head_commit пуст, NEED=0, и шаг ждал бы 25 минут ничего.
    const step = WF.slice(WF.indexOf('- name: Wait for fresh deploy'), WF.indexOf('- name: Scout Digest'));
    expect(step).toMatch(/if: github\.event_name == 'push'/);
  });

  it('реестр знает крон и его журнал', () => {
    const entry = CRON_REGISTRY.find((e) => e.key === 'scout-digest');
    expect(entry).toBeTruthy();
    expect(entry!.workflow).toBe('cron-scout-digest.yml');
    expect(entry!.cron).toBe('0 7,17 * * *');
    // agent_run_history пишет runScoutDigestJournaled под этим id — liveness честный.
    expect(entry!.agentId).toBe('scout-digest');
    expect(CRON_IDLE_MEANING['scout-digest']).toBe('unknown');
  });

  it('эволюция дайджест не дёргает вторым путём', () => {
    expect(EVO_WF).not.toMatch(/scout-digest/);
  });
});
