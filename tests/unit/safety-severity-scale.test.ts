/**
 * Тяжесть предупреждения называется по настоящей шкале (проверка MCP 29.09).
 *
 * safety_status говорил «максимальная тяжесть N из 5», а производители пишут
 * 0..3: предупреждение о цунами (3 — чрезвычайная) внешний агент пересказал
 * бы как середину шкалы. Сторож держит связку: верх шкалы в тексте совпадает
 * с верхом у производителей — парсера лент и формы админа.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ALERT_SEVERITY_WORDS, alertSeverityWord, formatSafetyStatusForAgent } from '@/lib/safety/current-status';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('шкала тяжести external_alerts', () => {
  it('верх шкалы — тот же, что у производителей', () => {
    const top = ALERT_SEVERITY_WORDS.length - 1;
    expect(read('lib/services/safety/seismic-parser.ts')).toMatch(new RegExp(`severity: 0 \\| 1 \\| 2 \\| ${top};`));
    expect(read('app/api/admin/external-alerts/route.ts')).toMatch(new RegExp(`severity: z\\.number\\(\\)\\.int\\(\\)\\.min\\(0\\)\\.max\\(${top}\\)`));
  });

  it('цунами (3) — чрезвычайная, без «из 5»', () => {
    const text = formatSafetyStatusForAgent({
      hasAlert: true, maxSeverity: 3, activeCount: 2, topTitle: 'Угроза цунами', topType: 'tsunami_warning',
      dataUpdatedAt: null, source: 'КФ ЕГС', feedCount: 1, feedTitles: [],
    } as Parameters<typeof formatSafetyStatusForAgent>[0]);
    expect(text).toMatch(/«чрезвычайная ситуация», 3 по шкале 0–3/);
    expect(text).not.toMatch(/из 5/);
  });

  it('экран планирования — та же шкала словом, без «из 5»', () => {
    const ui = read('app/planning/_PlanningClient.tsx');
    expect(ui).not.toMatch(/maxSeverity\} из 5/);
    expect(ui).toMatch(/alertSeverityWord\(snap\.maxSeverity\)/);
    expect(ui).toMatch(/from '@\/lib\/safety\/severity-words'/);
  });

  it('слово по уровню и за краями шкалы', () => {
    expect(alertSeverityWord(0)).toBe('справочное');
    expect(alertSeverityWord(2)).toBe('опасно');
    expect(alertSeverityWord(9)).toBe('чрезвычайная ситуация');
  });
});
