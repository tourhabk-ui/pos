/**
 * Сторож матрицы прав в PlatformAgent.
 *
 * Находка аудита 08.09, подтверждённая уликой: `canDispatchIntent` был
 * написан в `permissions.ts`, но в `platform-agent.ts` не вызывался НИ РАЗУ.
 *
 * Ключевой классификатор роль учитывает сам, а ветка `classifyWithAI` — нет:
 * её единственная проверка это `VALID_INTENTS.includes(cleaned)`, то есть
 * «такой интент вообще бывает», а не «этой роли он положен». Стоило модели
 * вернуть туристу `rescue_sos_stats` — и маршрутизатор шёл в RescueAgency с
 * `FROM sos_events`; на `channel_post_route` — публиковал в канал.
 *
 * Правило простое и держится здесь: согласие модели с инструкцией о роли —
 * не проверка прав. Проверка обязана быть детерминированной и стоять между
 * классификацией и маршрутизацией.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { canDispatchIntent, allowedIntentsForRole } from '../../lib/agents/permissions';

const AGENT = readFileSync('lib/agents/platform-agent.ts', 'utf8');

describe('матрица прав действительно спрашивается', () => {
  it('platform-agent импортирует и зовёт canDispatchIntent', () => {
    expect(AGENT).toContain("from '@/lib/agents/permissions'");
    expect(AGENT).toMatch(/canDispatchIntent\(params\.role, intent\)/);
  });

  it('проверка стоит МЕЖДУ классификацией и маршрутизацией', () => {
    const ai = AGENT.indexOf('await this.classifyWithAI(');
    const gate = AGENT.indexOf('canDispatchIntent(params.role, intent)');
    const route = AGENT.indexOf('await this.route(intent,');
    expect(ai).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(ai);
    expect(route).toBeGreaterThan(gate);
  });

  it('непозволенный интент гасится в unknown, а не исполняется', () => {
    const gate = AGENT.slice(AGENT.indexOf('canDispatchIntent(params.role, intent)'));
    expect(gate.slice(0, 500)).toContain("intent = 'unknown';");
  });

  it('отказ пишется в лог поимённо: в ответе его не видно', () => {
    expect(AGENT).toContain('[platform-agent] интент не положен роли');
    expect(AGENT).toMatch(/role: params\.role \?\? 'anonymous'/);
  });

  it('одной проверки VALID_INTENTS недостаточно — она про существование, не про права', () => {
    // Строка остаётся на месте (она нужна), но одна собой матрицу не заменяет.
    expect(AGENT).toContain('VALID_INTENTS.includes(cleaned)');
    expect(AGENT).toMatch(/canDispatchIntent/);
  });
});

describe('сама матрица: кому что положено', () => {
  it('туристу закрыты сводка SOS и публикация в канал', () => {
    expect(canDispatchIntent('tourist', 'rescue_sos_stats')).toBe(false);
    expect(canDispatchIntent('tourist', 'channel_post_route')).toBe(false);
    expect(canDispatchIntent('tourist', 'op_revenue')).toBe(false);
  });

  it('аноним не может ничего', () => {
    expect(allowedIntentsForRole('anonymous')).toEqual([]);
    expect(canDispatchIntent('anonymous', 'rescue_sos_stats')).toBe(false);
    expect(canDispatchIntent(null, 'tourist_recommend')).toBe(false);
  });

  it('роль неизвестного вида прав не получает', () => {
    // Пустой список для незнакомой роли, а не «раз не знаем — пускаем».
    expect(canDispatchIntent('superuser', 'rescue_sos_stats')).toBe(false);
    expect(canDispatchIntent(undefined, 'op_revenue')).toBe(false);
  });

  it('гиду сводка SOS положена, оператору — свои интенты', () => {
    expect(canDispatchIntent('guide', 'rescue_sos_stats')).toBe(true);
    expect(canDispatchIntent('operator', 'op_revenue')).toBe(true);
    expect(canDispatchIntent('operator', 'rescue_sos_stats')).toBe(false);
  });

  it('админу открыто всё', () => {
    expect(canDispatchIntent('admin', 'rescue_sos_stats')).toBe(true);
    expect(canDispatchIntent('admin', 'channel_post_route')).toBe(true);
  });
});
