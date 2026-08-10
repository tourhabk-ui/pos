/**
 * Крон, который падает каждый раз, не должен быть невидимым.
 *
 * Полевой случай 10.08: синк авиационных цветовых кодов вулканов (KVERT) в
 * последний раз отработал 28 июля. Дальше — отказ каждые шесть часов подряд,
 * тринадцать дней: источник сменил формат и стал отдавать HTML вместо VONA,
 * парсер распознавал ноль вулканов и честно отказывался писать. Отказывался
 * правильно. Но volcano_status замер на снимке двухнедельной давности, а
 * главная показывает вулканы только с повышенным кодом — пусто там значит либо
 * «спокойно», либо «мы смотрим в прошлое», и снаружи это неотличимо.
 *
 * Молчали оба сторожа, и каждый по своей причине:
 *   liveness  — читает историю без разбора статуса, упавший прогон для него
 *               отметка о жизни;
 *   cron-idle — берёт `status = 'success'`, а успешных прогонов нет вовсе, и
 *               срабатывает правило «меньше порога прогонов — судить рано».
 *
 * Тесты стерегут и обратное: проверка не кричит на здоровых кронах и на
 * единичном сбое сети.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findFailingCrons, formatFailingCrons, FAILING_RUNS_THRESHOLD,
  type CronStatusRow,
} from '@/lib/agents/cron-failing';
import type { CronEntry } from '@/lib/agents/cron-registry';

const KVERT: CronEntry = {
  key: 'kvert-acc', label: 'KVERT ACC',
  description: 'Авиационные цветовые коды вулканов (KVERT).',
  workflow: 'cron-kvert-acc.yml', cron: '17 */6 * * *', schedule: 'каждые 6 ч',
  everyMin: 360, tier: 'safety', agentId: 'kvert-acc', triggerable: false,
};

function run(over: Partial<CronStatusRow> = {}): CronStatusRow {
  return { agent_id: 'kvert-acc', status: 'failed', ended_at: '2026-08-09T19:01:10Z', ...over };
}

describe('серия отказов видна', () => {
  it('два подряд — находка с последней ошибкой и датой последнего успеха', () => {
    const found = findFailingCrons([KVERT], [
      run({ ended_at: '2026-08-09T19:01:10Z', error: 'KVERT: распознано 0 вулканов — источник отдал не VONA' }),
      run({ ended_at: '2026-08-09T13:15:30Z' }),
      run({ status: 'success', ended_at: '2026-07-28T03:36:30Z' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('kvert-acc');
    expect(found[0].lastSuccessAt).toBe('2026-07-28T03:36:30Z');
    expect(found[0].lastError).toContain('не VONA');
  });

  it('порядок строк на входе значения не имеет — сортируем сами', () => {
    const found = findFailingCrons([KVERT], [
      run({ ended_at: '2026-07-28T03:36:30Z', status: 'success' }),
      run({ ended_at: '2026-08-09T13:15:30Z' }),
      run({ ended_at: '2026-08-09T19:01:10Z', error: 'свежая' }),
    ]);
    expect(found[0].lastError).toBe('свежая');
  });

  it('успешных прогонов в истории может не быть вовсе', () => {
    const found = findFailingCrons([KVERT], [run({ ended_at: '2026-08-09T19:01:10Z' }), run()]);
    expect(found[0].lastSuccessAt).toBeNull();
  });
});

describe('здоровый крон молчит', () => {
  it('успешные прогоны тревоги не поднимают', () => {
    const ok = [run({ status: 'success' }), run({ status: 'success', ended_at: '2026-08-09T13:00:00Z' })];
    expect(findFailingCrons([KVERT], ok)).toEqual([]);
  });

  it('единичный сбой — не поломка: сеть моргает у всех', () => {
    const blip = [
      run({ ended_at: '2026-08-09T19:01:10Z' }),
      run({ status: 'success', ended_at: '2026-08-09T13:15:30Z' }),
    ];
    expect(findFailingCrons([KVERT], blip)).toEqual([]);
  });

  it('истории меньше порога — судить рано, это предмет liveness', () => {
    expect(findFailingCrons([KVERT], [run()])).toEqual([]);
    expect(findFailingCrons([KVERT], [])).toEqual([]);
  });

  it('крон без телеметрии пропускается, а не обвиняется', () => {
    const noTelemetry: CronEntry = { ...KVERT, agentId: null };
    expect(findFailingCrons([noTelemetry], [run(), run()])).toEqual([]);
  });

  it('чужие строки истории не приписываются', () => {
    const alien = [run({ agent_id: 'editor' }), run({ agent_id: 'editor' })];
    expect(findFailingCrons([KVERT], alien)).toEqual([]);
  });
});

describe('судим все кроны, а не только те, где ноль объявлен ненормальным', () => {
  it('серия отказов — это отказ при любой семантике нуля', () => {
    // cron-idle сознательно судит лишь там, где ноль ненормален. Здесь такой
    // оговорки быть не может: крон, который каждый раз падает, сломан всегда.
    const normalIdle: CronEntry = { ...KVERT, key: 'watchdog', label: 'Watchdog', agentId: 'watchdog' };
    const found = findFailingCrons([normalIdle], [
      run({ agent_id: 'watchdog' }), run({ agent_id: 'watchdog', ended_at: '2026-08-09T13:00:00Z' }),
    ]);
    expect(found).toHaveLength(1);
  });
});

describe('итог читается человеком', () => {
  it('в строке — что встало, сколько раз, с какого числа и почему', () => {
    const s = formatFailingCrons(findFailingCrons([KVERT], [
      run({ ended_at: '2026-08-09T19:01:10Z', error: 'источник отдал не VONA' }),
      run({ ended_at: '2026-08-09T13:15:30Z' }),
      run({ status: 'success', ended_at: '2026-07-28T03:36:30Z' }),
    ]));
    expect(s).toContain('KVERT ACC');
    expect(s).toContain('отказом');
    expect(s).toContain('28.07.2026');
    expect(s).toContain('не VONA');
  });
});

describe('проверка подключена к сторожу', () => {
  const WD = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');

  it('вызывается в общем прогоне и попадает в список алертов', () => {
    expect(WD).toMatch(/checkFailingCrons\(\)/);
    expect(WD).toMatch(/type: 'cron_failing'/);
  });

  it('историю берёт БЕЗ фильтра по статусу — иначе видеть нечего', () => {
    // Ровно этот фильтр в сторожe холостых и делал поломку невидимой.
    const body = WD.slice(WD.indexOf('async function checkFailingCrons'));
    const q = body.slice(0, body.indexOf('findFailingCrons'));
    expect(q).not.toMatch(/status = 'success'/);
    expect(q).toMatch(/error_msg/);
  });

  it('падение safety-крона поднимается как критическое', () => {
    const body = WD.slice(WD.indexOf('async function checkFailingCrons'));
    expect(body.slice(0, body.indexOf('return {') + 400)).toMatch(/tier === 'safety'/);
  });
});

describe('порог осознан', () => {
  it('два прогона подряд — половина суток при шестичасовом расписании', () => {
    expect(FAILING_RUNS_THRESHOLD).toBe(2);
  });
});
