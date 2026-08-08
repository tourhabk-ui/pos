/**
 * Мост Intelligence Monitor → Эволюция (владелец 08.08: «бот KiloClaw больше
 * не задействован, только эта сессия работает»).
 *
 * До моста находки монитора жили write-only: карточка в админке с чек-листом
 * «0/3 готово» и кнопкой отправки боту, которого нет. В петлю эволюции
 * (evo_growth_issues → issue-reporter → GitHub Issues) они не попадали —
 * туда ходил только дайджест Scout.
 *
 * Сторож держит: мост детерминированный (никакой модели — action items уже
 * сформулированы как действия), подключён к циклу монитора, дедупится
 * intelSignature по всей истории intel, а мёртвый канал KiloClaw
 * действительно выведен из роута и UI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorFindingsToProposals, type MonitorFinding } from '@/lib/agents/evo/intel-bridge';

const ROOT = process.cwd();
const MONITOR = readFileSync(join(ROOT, 'lib/services/intelligence-monitor.service.ts'), 'utf-8');
const BRIDGE = readFileSync(join(ROOT, 'lib/agents/evo/intel-bridge.ts'), 'utf-8');
const ACTION_ROUTE = readFileSync(join(ROOT, 'app/api/admin/intelligence-feed/[id]/action/route.ts'), 'utf-8');
const FEED_UI = readFileSync(join(ROOT, 'app/hub/admin/intelligence/_IntelligenceSourcesClient.tsx'), 'utf-8');

const finding = (over: Partial<MonitorFinding>): MonitorFinding => ({
  domain: 'ai_tech',
  urgency: 'notable',
  summary: 'Появился новый инструмент для агентов.',
  action_items: ['[высокий] — Оценить инструмент для Кузьмича'],
  ...over,
});

describe('monitorFindingsToProposals (чистая)', () => {
  it('important-находки превращаются в предложения; приоритетный префикс срезан', () => {
    const out = monitorFindingsToProposals([finding({})]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Оценить инструмент для Кузьмича');
    expect(out[0]!.severity).toBe('medium');
    expect(out[0]!.description).toContain('[ai_tech]');
  });

  it('critical идёт впереди notable и получает severity high', () => {
    const out = monitorFindingsToProposals([
      finding({ action_items: ['[низкий] — Задача notable'] }),
      finding({ urgency: 'critical', action_items: ['[высокий] — Задача critical'] }),
    ]);
    expect(out[0]!.title).toBe('Задача critical');
    expect(out[0]!.severity).toBe('high');
    expect(out[1]!.severity).toBe('medium');
  });

  it('informational не мостится — это фон, а не задача', () => {
    expect(monitorFindingsToProposals([finding({ urgency: 'informational' })])).toEqual([]);
  });

  it('кап на прогон — слоты не съедаются одной многословной находкой', () => {
    const items = ['[высокий] — Раз', '[высокий] — Два задачи', '[высокий] — Три задачи', '[высокий] — Четыре задачи'];
    const out = monitorFindingsToProposals([finding({ action_items: items })]);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('мусор и пустышки отсеиваются', () => {
    const out = monitorFindingsToProposals([
      finding({ action_items: ['', 'ok', 'нет релевантных действий', 'x'.repeat(200)] }),
    ]);
    expect(out).toEqual([]);
  });
});

describe('мост подключён и детерминирован', () => {
  it('цикл монитора зовёт bridgeMonitorFindings', () => {
    expect(MONITOR).toMatch(/bridgeMonitorFindings\(/);
    expect(MONITOR).toMatch(/from '@\/lib\/agents\/evo\/intel-bridge'/);
  });

  it('дедуп — intelSignature по всей истории intel', () => {
    const fn = /export async function bridgeMonitorFindings[\s\S]*?\n\}/.exec(BRIDGE)![0];
    expect(fn).toMatch(/WHERE category = 'intel'/);
    expect(fn).toMatch(/intelSignature/);
  });

  it('в мосте нет вызова модели — только детерминированные вставки', () => {
    const fn = /export async function bridgeMonitorFindings[\s\S]*?\n\}/.exec(BRIDGE)![0];
    expect(fn).not.toMatch(/callAI/);
  });
});

describe('KiloClaw выведен (владелец 08.08)', () => {
  it('в action-роуте нет отправки KiloClaw', () => {
    expect(ACTION_ROUTE).not.toMatch(/action === 'send_to_kiloclaw'/);
    expect(ACTION_ROUTE).not.toMatch(/async function sendToKiloClaw/);
  });

  it('в UI нет кнопки отправки — только исторический бейдж', () => {
    expect(FEED_UI).not.toMatch(/action: 'send_to_kiloclaw'/);
  });
});
