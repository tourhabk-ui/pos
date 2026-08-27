import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRunGrowthScan = vi.fn();
const mockRunEvolutionLoop = vi.fn();
const mockRunRescueScan = vi.fn();
const mockRunEvolverAnalysis = vi.fn();
const mockBridgeScoutIntel = vi.fn();
const mockRunModelWatcher = vi.fn();

vi.mock('@/lib/agents/evo/growth-agent', () => ({
  runGrowthScan: (...args: unknown[]) => mockRunGrowthScan(...args),
}));
vi.mock('@/lib/agents/evo/evolution-loop', () => ({
  runEvolutionLoop: (...args: unknown[]) => mockRunEvolutionLoop(...args),
}));
vi.mock('@/lib/agents/evo/rescue-agent', () => ({
  runRescueScan: (...args: unknown[]) => mockRunRescueScan(...args),
}));
vi.mock('@/lib/agents/evo/evolver-analysis', () => ({
  runEvolverAnalysis: (...args: unknown[]) => mockRunEvolverAnalysis(...args),
}));
vi.mock('@/lib/agents/evo/intel-bridge', () => ({
  bridgeScoutIntel: (...args: unknown[]) => mockBridgeScoutIntel(...args),
}));
vi.mock('@/lib/agents/evo/model-watcher', () => ({
  runModelWatcher: (...args: unknown[]) => mockRunModelWatcher(...args),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin' }),
}));

function evolution(errors = 0) {
  return {
    processed: 2,
    auto_fixes: 0,
    suggestions: 2 - errors,
    errors,
    duration_ms: 5,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunGrowthScan.mockResolvedValue({ issues: [], new_issues: 0 });
  mockRunEvolutionLoop.mockResolvedValue(evolution());
  mockRunRescueScan.mockResolvedValue({ alerts: [], scan_duration_ms: 1 });
  mockRunEvolverAnalysis.mockResolvedValue({});
  mockBridgeScoutIntel.mockResolvedValue({});
  mockRunModelWatcher.mockResolvedValue({});
});

describe('runEvoOrchestrator: внутренние ошибки не становятся зелёными', () => {
  it('поднимает счётчик ошибок Evolution Loop в общий errors[]', async () => {
    mockRunEvolutionLoop.mockResolvedValueOnce(evolution(2));

    const { runEvoOrchestrator } = await import('@/lib/agents/orchestrator');
    const result = await runEvoOrchestrator('full');

    expect(result.evolution).toMatchObject({ errors: 2 });
    expect(result.errors).toContain('EvolutionLoop: 2 issue(s) failed');
  });
});

describe('POST /api/admin/agents/trigger: ручной Evo тоже честный', () => {
  it('возвращает result.status=partial при внутренних ошибках Evolution Loop', async () => {
    mockRunEvolutionLoop.mockResolvedValueOnce(evolution(1));

    const { POST } = await import('@/app/api/admin/agents/trigger/route');
    const response = await POST(new NextRequest(
      'http://localhost/api/admin/agents/trigger',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'evo' }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      agent_id: 'evo',
      result: {
        success: false,
        status: 'partial',
        errors: ['EvolutionLoop: 1 issue(s) failed'],
      },
    });
  });
});
