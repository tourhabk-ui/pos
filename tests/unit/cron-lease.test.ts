/**
 * Сторож: один прогон в окне, сколько бы ни было планировщиков.
 *
 * ── Зачем ────────────────────────────────────────────────────────────────
 *
 * 29.08 у safety-кронов стало три источника запуска: расписание GitHub
 * (доставляет 1-4% запрошенного), внешний cron-job.org и супервизор
 * контейнера. Без аренды Watchdog слал бы один алерт дважды, а
 * sos-events-bridge дважды выпускал бы одно SOS-событие в шину — а на том
 * конце это второй наряд по одному сигналу.
 *
 * Аренда держится ключом в таблице, а не договорённостью между
 * планировщиками: договорённость живёт, пока её помнят и пока никто не
 * завёл четвёртый.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { windowStart, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';

describe('окно выровнено от эпохи, а не от первого запуска', () => {
  it('два планировщика в одном окне получают ОДИН ключ', () => {
    // На этом и держится замок. Была бы у каждого своя сетка окон — они не
    // пересеклись бы никогда, и аренда не поймала бы ни одного дубля.
    const a = windowStart(Date.parse('2026-08-29T09:03:00Z'), 30);
    const b = windowStart(Date.parse('2026-08-29T09:27:59Z'), 30);
    expect(a.toISOString()).toBe(b.toISOString());
    expect(a.toISOString()).toBe('2026-08-29T09:00:00.000Z');
  });

  it('соседние окна различаются', () => {
    const a = windowStart(Date.parse('2026-08-29T09:29:59Z'), 30);
    const b = windowStart(Date.parse('2026-08-29T09:30:00Z'), 30);
    expect(a.toISOString()).not.toBe(b.toISOString());
  });

  it('часовое окно режет по часу', () => {
    expect(windowStart(Date.parse('2026-08-29T09:59:00Z'), 60).toISOString())
      .toBe('2026-08-29T09:00:00.000Z');
  });

  it('нулевое окно не делит на ноль', () => {
    expect(() => windowStart(Date.now(), 0)).not.toThrow();
  });
});

describe('«не смог проверить» пропускает к работе', () => {
  it('отказ БД не отменяет safety-крон', () => {
    // §4.0 требует третьего исхода, но что с ним делать — решает цена
    // ошибки. Лишний прогон сейсмо-ингеста стоит одного запроса,
    // пропущенный — незамеченного цунами. Обратный выбор ронял бы всю
    // safety-цепочку при первом сбое соединения с БД.
    expect(shouldRun('unknown')).toBe(true);
  });

  it('занятое окно — единственный повод не работать', () => {
    expect(shouldRun('claimed')).toBe(true);
    expect(shouldRun('held')).toBe(false);
  });
});

describe('пропуск называет себя', () => {
  it('в теле есть причина, а не голый успех', () => {
    const body = leaseSkipBody('watchdog', 30);
    expect(body.skipped).toBe('lease_held');
    expect(body.agent_id).toBe('watchdog');
  });
});

describe('аренда не притворяется прогоном', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/agents/cron-lease.ts'), 'utf-8');
  // Судим КОД, не комментарии: разбор рядом с правкой обязан иметь право
  // назвать таблицу, в которую тут намеренно НЕ пишут.
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('не пишет в agent_run_history', () => {
    // Своя строка при пропуске дала бы cron-idle серию успехов с нулём
    // сделанного и ложную тревогу «крон работает вхолостую».
    expect(CODE).not.toMatch(/agent_run_history/);
    expect(CODE).not.toMatch(/logAgentRun|recordCronRun/);
  });

  it('отказ захвата не глушится', () => {
    expect(SRC).toMatch(/console\.error\(/);
  });
});

describe('safety-роуты берут аренду', () => {
  const ROUTES: Array<[string, string]> = [
    ['watchdog', 'app/api/cron/watchdog/route.ts'],
    ['sos-events-bridge', 'app/api/cron/sos-events-bridge/route.ts'],
    ['danger-analysis', 'app/api/cron/danger-analysis/route.ts'],
    ['rescue', 'app/api/cron/rescue/route.ts'],
    ['checkin-watchdog', 'app/api/cron/checkin-watchdog/route.ts'],
  ];

  for (const [agent, path] of ROUTES) {
    it(`${agent} — аренда до работы`, () => {
      const src = readFileSync(join(process.cwd(), path), 'utf-8');
      expect(src, `${agent} остался без аренды: два планировщика сделают его работу дважды`)
        .toMatch(/claimCronWindow\(/);
      expect(src).toMatch(new RegExp(`claimCronWindow\\('${agent}'`));
    });

    it(`${agent} — 401 объясняет себя`, () => {
      // Владелец 29.08 получил голый {"error":"Unauthorized"} пять раз
      // подряд и не мог отличить «секрет не дошёл» от «секрет не тот» и от
      // «CRON_SECRET не задан на сервере». Три беды, три разных места.
      const src = readFileSync(join(process.cwd(), path), 'utf-8');
      expect(src, `${agent}: 401 снова молчит о причине`).toMatch(/diagnoseCronAuth\(/);
    });
  }
});

describe('супервизор ведёт весь safety-разряд', () => {
  const START = readFileSync(join(process.cwd(), 'start.js'), 'utf-8');

  it('в списке все шесть кронов, а не один ингест', () => {
    for (const p of [
      'safety-ingest', 'sos-events-bridge', 'danger-analysis',
      'rescue', 'watchdog', 'checkin-watchdog',
    ]) {
      expect(START, `${p} не ведётся супервизором — остаётся на планировщике, который его роняет`)
        .toContain(`/api/cron/${p}`);
    }
  });

  it('старты разнесены — залпом шести задач два ядра не занимаем', () => {
    const offsets = [...START.matchAll(/startAfterMs:\s*(\d+)/g)].map(m => Number(m[1]));
    expect(offsets.length).toBe(6);
    expect(new Set(offsets).size, 'смещения совпали — задачи стартуют залпом').toBe(6);
  });

  it('секрет уходит заголовком, а не в адресной строке', () => {
    // В query он оседает в логах сервера и прокси.
    expect(START).toMatch(/authorization.*Bearer/);
    expect(START).not.toMatch(/\?secret=/);
  });
});
