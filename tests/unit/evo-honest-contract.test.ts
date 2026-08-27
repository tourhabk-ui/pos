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
    process.env.CRON_SECRET = 'test-cron-secret';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  it('возвращает completed/success=true, когда все стадии завершились без ошибок', async () => {
    mockRunEvoOrchestrator.mockResolvedValueOnce(completedResult);
    mockLogAgentRun.mockResolvedValueOnce(undefined);

    const { GET } = await import('@/app/api/cron/evo/route');
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: 'completed', errors: [] });
    expect(mockLogAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('сохраняет HTTP 200, но возвращает partial/success=false при ошибке отдельной стадии', async () => {
    mockRunEvoOrchestrator.mockResolvedValueOnce({
      ...completedResult,
      errors: ['GrowthScan: timeout'],
    });
    mockLogAgentRun.mockResolvedValueOnce(undefined);

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
    mockLogAgentRun.mockResolvedValueOnce(undefined);

    const { GET } = await import('@/app/api/cron/evo/route');
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      status: 'failed',
      error: 'orchestrator crashed',
    });
    expect(mockLogAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errors_count: 1 }),
    );
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
