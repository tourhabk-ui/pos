// @vitest-environment node
/**
 * Журнал прогонов меряет работу (перепись пользы агентов, 05.11; слово
 * владельца «решай сам»).
 *
 * Перепись `agents-value-census` за 30 дней: у 8 из 60 агентов реестра
 * каждый прогон писал «успех» без чисел — сколько проверено, что найдено,
 * — и польза Watchdog, Rescue, Evo и сторожей вебхуков не читалась ни в
 * какую сторону («не мерили» ≠ «ноль», §4.0). Сторож держит две половины:
 *  1. поведение: роуты Watchdog и Rescue пишут в журнал проверенное и
 *     найденное (вызов роута с подменённым сканом);
 *  2. запрет: успешная запись журнала без меры в app/ и lib/ — красная,
 *     кроме записей KNOWN_UNMEASURED с причиной. Список самоустаревающий:
 *     появилась мера — тест требует убрать запись.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const logAgentRun = vi.fn();
const runWatchdog = vi.fn();
const runRescueScan = vi.fn();
vi.mock('@/lib/agents/run-logger', () => ({ logAgentRun: (...a: unknown[]) => logAgentRun(...a) }));
vi.mock('@/lib/agents/watchdog', () => ({ runWatchdog: () => runWatchdog() }));
vi.mock('@/lib/agents/evo/rescue-agent', () => ({ runRescueScan: () => runRescueScan() }));
vi.mock('@/lib/agents/cron-lease', () => ({
  claimCronWindow: vi.fn(async () => ({ state: 'claimed' })),
  shouldRun: () => true,
  leaseSkipBody: () => ({ skipped: true }),
}));

const SECRET = 'agent-runs-measured-secret';
const req = (path: string) => {
  const url = `https://vedarai.ru${path}`;
  return new Request(url, { headers: { authorization: `Bearer ${SECRET}` } });
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  logAgentRun.mockResolvedValue(true);
});

describe('роуты сторожей пишут меру работы', () => {
  it('Watchdog: проверено — отработавшие проверки, создано — тревоги', async () => {
    runWatchdog.mockResolvedValue({
      alerts: [{ level: 'warn' }, { level: 'crit' }],
      checked_at: '2026-11-05T10:00:00Z', duration_ms: 5,
      delivery: { state: 'sent' },
      checks: { total: 18, failed: [{ check: 'transfer', reason: 'нет таблицы' }] },
    });
    const { GET } = await import('@/app/api/cron/watchdog/route');
    await GET(req('/api/cron/watchdog') as never);
    expect(logAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'watchdog', status: 'partial', items_processed: 17, items_created: 2,
    }));
  });

  it('Rescue: проверено — отработавшие проверки, создано — тревоги без строк «проверка не отработала»', async () => {
    runRescueScan.mockResolvedValue({
      alerts: [
        { type: 'weather', severity: 'warning', title: 'ветер', body: '', action: '' },
        { type: 'check_failed', severity: 'warning', title: 'Проверка не отработала', body: 'отток', action: '' },
      ],
      failed_checks: ['отток операторов: SQLSTATE 57014'],
      checks_total: 4,
      scan_duration_ms: 3,
    });
    const { GET } = await import('@/app/api/cron/rescue/route');
    await GET(req('/api/cron/rescue') as never);
    expect(logAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'rescue', items_processed: 3, items_created: 1,
    }));
  });

  it('Rescue без проверок, отказавших и без тревог — ноль измерен, а не пропущен', async () => {
    runRescueScan.mockResolvedValue({ alerts: [], failed_checks: [], checks_total: 4, scan_duration_ms: 1 });
    const { GET } = await import('@/app/api/cron/rescue/route');
    await GET(req('/api/cron/rescue') as never);
    expect(logAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'rescue', status: 'success', items_processed: 4, items_created: 0,
    }));
  });
});

/**
 * Успешные записи журнала без меры, оставленные осознанно. Причина — почему
 * одной меры у прогона нет. Ключ — «файл · agent_id».
 */
const KNOWN_UNMEASURED: Record<string, string> = {
  'app/api/cron/data-repair/route.ts · data-repair':
    'ручная починка данных: исход — набор счётчиков по десятку шагов в metadata, '
    + 'одной меры нет; в реестре кронов её нет, и перепись пользы её не судит',
};

/** Успешные записи журнала без items в app/ и lib/: «файл · agent_id». */
function unmeasuredSuccessWrites(): string[] {
  const files = execSync("git ls-files 'app/**/*.ts' 'lib/**/*.ts'", { encoding: 'utf8' }).trim().split('\n');
  const out: string[] = [];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/recordCronRun\(\s*'([^']+)'\s*,[^,]+,\s*'success'\s*(\)|,\s*\{([^}]*)\})/g)) {
      if (!/\bitems\b/.test(m[3] ?? '')) out.push(`${f} · ${m[1]}`);
    }
    for (const m of s.matchAll(/logAgentRun\(\{([\s\S]*?)\}\);/g)) {
      const body = m[1];
      const id = /agent_id:\s*'([^']+)'/.exec(body)?.[1];
      if (!id || !/'success'/.test(body)) continue;
      if (!/items_processed|items_created/.test(body)) out.push(`${f} · ${id}`);
    }
  }
  return out;
}

describe('запрет: «успех» в журнале без меры', () => {
  const found = unmeasuredSuccessWrites();

  it('новых записей без меры нет', () => {
    const unexplained = found.filter((k) => !(k in KNOWN_UNMEASURED));
    expect(unexplained, 'успешный прогон пишется в журнал с items (проверено/создано); '
      + 'одной меры нет — запись в KNOWN_UNMEASURED с причиной').toEqual([]);
  });

  it('список исключений самоустаревающий', () => {
    const stale = Object.keys(KNOWN_UNMEASURED).filter((k) => !found.includes(k));
    expect(stale, 'у записи появилась мера или её больше нет — уберите из KNOWN_UNMEASURED').toEqual([]);
  });

  it('сканер видит запись без меры (иначе запрет пуст)', () => {
    expect(found).toContain('app/api/cron/data-repair/route.ts · data-repair');
  });
});
