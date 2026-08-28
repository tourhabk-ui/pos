import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRunEvoOrchestrator = vi.fn();
const mockLogAgentRun = vi.fn();

vi.mock('@/lib/agents/orchestrator', () => ({
  runEvoOrchestrator: (...args: unknown[]) => mockRunEvoOrchestrator(...args),
}));

vi.mock('@/lib/agents/evo/alert', () => ({
  buildEvoAlert: () => null,
}));

vi.mock('@/lib/agents/run-logger', () => ({
  logAgentRun: (...args: unknown[]) => mockLogAgentRun(...args),
}));

// Kernel-адаптер здесь не под тестом (у него свой сторож agent-kernel.test.ts);
// null-handle — легальный fail-soft путь, и контракт обязан отдавать
// kernel_task_id: null честно, а не прятать поле.
const mockStartEvoRunTask = vi.fn();
vi.mock('@/lib/agents/kernel/adapters/evo-run-task', () => ({
  startEvoRunTask: (...args: unknown[]) => mockStartEvoRunTask(...args),
  finishEvoRunTask: vi.fn(),
  failEvoRunTask: vi.fn(),
}));

// Concurrency-guard роута — pg_try_advisory_lock напрямую через pool.connect()
// (ревью 28.08: замена check-then-act проверки на атомарный лок Postgres).
// Мокаем на уровне клиента, а не всего пула, чтобы проверять именно
// последовательность query/release, как делает сам роут.
const mockClient = { query: vi.fn(), release: vi.fn() };
const mockConnect = vi.fn(async () => mockClient);
vi.mock('@/lib/db-pool', () => ({
  pool: { connect: () => mockConnect() },
}));

const completedResult = {
  scan: {},
  evolution: {},
  rescue: {},
  evolver: {},
  intel: {},
  models: {},
  duration_ms: 42,
  errors: [] as string[],
};

function request(): NextRequest {
  return new NextRequest('http://localhost/api/cron/evo?type=full', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

describe('GET /api/cron/evo: честный контракт результата', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartEvoRunTask.mockResolvedValue(null);
    mockConnect.mockImplementation(async () => mockClient);
    // По умолчанию лок захватывается сразу — большинство тестов проверяют
    // не сам лок, а поведение после него.
    mockClient.query.mockImplementation(async () => ({ rows: [{ locked: true }] }));
    process.env.CRON_SECRET = 'test-cron-secret';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  it('возвращает completed/success=true, когда все стадии завершились без ошибок', async () => {
    mockRunEvoOrchestrator.mockResolvedValueOnce(completedResult);
    mockLogAgentRun.mockResolvedValueOnce(true);

    const { GET } = await import('@/app/api/cron/evo/route');
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: 'completed', errors: [], run_logged: true });
    expect(mockLogAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('сохраняет HTTP 200, но возвращает partial/success=false при ошибке отдельной стадии', async () => {
    mockRunEvoOrchestrator.mockResolvedValueOnce({
      ...completedResult,
      errors: ['GrowthScan: timeout'],
    });
    mockLogAgentRun.mockResolvedValueOnce(true);

    const { GET } = await import('@/app/api/cron/evo/route');
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: false,
      status: 'partial',
      errors: ['GrowthScan: timeout'],
    });
    expect(mockLogAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial' }),
    );
  });

  it('возвращает failed/success=false и HTTP 500, когда результата нет', async () => {
    mockRunEvoOrchestrator.mockRejectedValueOnce(new Error('orchestrator crashed'));
    mockLogAgentRun.mockResolvedValueOnce(false);

    const { GET } = await import('@/app/api/cron/evo/route');
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    // run_logged: false — терминальная запись не удалась, и контракт этого
    // не скрывает (P0 27.08: терминальный итог — часть контракта).
    expect(body).toEqual({
      success: false,
      status: 'failed',
      run_logged: false,
      kernel_task_id: null,
      trace_id: null,
      error: 'orchestrator crashed',
    });
    expect(mockLogAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errors_count: 1 }),
    );
  });

  it('lock не захвачен: НЕ зовёт оркестратор, НЕ заводит kernel-задачу и НЕ пишет agent_run_history', async () => {
    // Concurrency-guard (ревью 28.08): pg_try_advisory_lock атомарно на уровне
    // Postgres — другой прогон evo.run уже держит лок. orchestrator звать
    // нельзя, Evolution Loop пишет фиксы в БД и открывает PR, гонка там
    // опаснее задержки будильника.
    mockClient.query.mockImplementationOnce(async () => ({ rows: [{ locked: false }] }));

    const { GET } = await import('@/app/api/cron/evo/route');
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      status: 'skipped_already_running',
      run_logged: false,
      kernel_task_id: null,
      trace_id: null,
    });
    expect(mockStartEvoRunTask).not.toHaveBeenCalled();
    expect(mockRunEvoOrchestrator).not.toHaveBeenCalled();
    expect(mockLogAgentRun).not.toHaveBeenCalled();
    // Проигравший клиент не остаётся висеть в пуле.
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('lock захвачен и освобождён ровно один раз — независимо от исхода прогона', async () => {
    mockRunEvoOrchestrator.mockRejectedValueOnce(new Error('boom'));
    mockLogAgentRun.mockResolvedValueOnce(true);

    const { GET } = await import('@/app/api/cron/evo/route');
    await GET(request());

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      expect.any(Array),
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.any(Array),
    );
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('cron-evo.yml: partial не выглядит зелёным', () => {
  const workflow = readFileSync(
    join(process.cwd(), '.github/workflows/cron-evo.yml'),
    'utf8',
  );

  it('проверяет JSON-контракт после успешного HTTP-ответа', () => {
    expect(workflow).toContain(
      "jq -e '.success == true and .status == \"completed\"' /tmp/evo_resp.json",
    );
    expect(workflow).toContain('Evo Scan incomplete: status=$STATUS errors=$ERRORS');
  });
});
