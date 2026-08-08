/**
 * Прод-ошибки в петле эволюции (Эволюция 3.0, п.1, владелец 08.08: «действуй»).
 *
 * До этого 500-ки прода не попадали в петлю вовсе: эволюция читала только код,
 * а правда жила на проде — мёртвый /time-slots и вечный degraded /api/tours
 * вскрылись лишь ручной пробой с раннера. Контур: onRequestError →
 * ai_actions_log(server_error) → объектив scanProdErrors → находка Evo.
 *
 * Сторож — по исходникам (контур живёт на проде, юнитом его не прогнать):
 * держит перехватчик подключённым, троттлинг живым, заголовок находки
 * стабильным (дедуп идёт по file_path+title — счётчик в заголовке плодил бы
 * новую находку каждый день).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prodRouteToFile } from '@/lib/agents/evo/growth-agent';

const ROOT = process.cwd();
const INSTR = readFileSync(join(ROOT, 'instrumentation.ts'), 'utf-8');
const GROWTH = readFileSync(join(ROOT, 'lib/agents/evo/growth-agent.ts'), 'utf-8');

describe('перехватчик onRequestError', () => {
  it('экспортирован и пишет server_error в ai_actions_log', () => {
    expect(INSTR).toMatch(/export async function onRequestError/);
    expect(INSTR).toMatch(/INSERT INTO ai_actions_log/);
    expect(INSTR).toMatch(/'server_error'/);
  });

  it('троттлинг per-route есть — шторм не заливает журнал', () => {
    expect(INSTR).toMatch(/ERROR_LOG_THROTTLE_MS/);
    expect(INSTR).toMatch(/errorLoggedAt/);
  });

  it('сбой записи журнала проглатывается — не усугубляет исходную ошибку', () => {
    const fn = /export async function onRequestError[\s\S]*?\n\}/.exec(INSTR)![0];
    expect(fn).toMatch(/catch \{/);
  });
});

describe('объектив scanProdErrors', () => {
  it('подключён к прочёсу и читает журнал за сутки', () => {
    expect(GROWTH).toMatch(/scanProdErrors\(\)/);
    expect(GROWTH).toMatch(/action_type = 'server_error'/);
    expect(GROWTH).toMatch(/INTERVAL '25 hours'/);
  });

  it('заголовок находки стабилен: без счётчиков, счётчик — в описании', () => {
    const lens = /async function scanProdErrors[\s\S]*?\n\}/.exec(GROWTH)![0];
    const title = /title: `([^`]*)`/.exec(lens)![1];
    expect(title).toBe('Прод 500: ${r.route}');
    expect(lens).toMatch(/description:[\s\S]*\$\{r\.n\}/);
  });

  it('находки детерминированные — модель не привлекается', () => {
    const lens = /async function scanProdErrors[\s\S]*?\n\}/.exec(GROWTH)![0];
    expect(lens).toMatch(/model: 'deterministic'/);
  });
});

describe('prodRouteToFile: маппинг роута на файл для дедупа', () => {
  it('API-роут → файл обработчика', () => {
    expect(prodRouteToFile('/api/tours/[id]/slots')).toBe('app/api/tours/[id]/slots/route.ts');
  });
  it('не-API путь — без файла (страницы чинят по роуту из заголовка)', () => {
    expect(prodRouteToFile('/catalog')).toBeUndefined();
  });
});
