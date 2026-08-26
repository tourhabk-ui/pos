import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const mockPoolQuery = vi.fn();
const mockAuditWrite = vi.fn();
const mockTelegramSend = vi.fn();

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

vi.mock('@/lib/agents/safeguards/audit-log', () => ({
  auditLog: {
    write: (...args: unknown[]) => mockAuditWrite(...args),
  },
}));

vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: {
    sendMessage: (...args: unknown[]) => mockTelegramSend(...args),
  },
}));

describe('ApprovalRequired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-approves safe action and persists approval id', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'safe-id-1' }] });

    const { ApprovalRequired } = await import('@/lib/agents/safeguards/approval-required');
    const service = new ApprovalRequired();

    const result = await service.request({
      type: 'schedule_suggest',
      description: 'Создать черновик тура',
      context: { partnerId: 'p1' },
      requested_by: 'operator:1',
    });

    expect(result).toEqual({ needs_approval: false, id: 'safe-id-1' });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);

    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO agent_approvals');
    expect(sql).toContain("'approved'");

    expect(mockAuditWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'approval_granted',
        actor: 'operator:1',
      }),
    );
    expect(mockTelegramSend).not.toHaveBeenCalled();
  });

  it('неизвестный тип идёт в review по умолчанию — fail-closed, не safe', async () => {
    // Находка 26.08: реестр когда-то объявлял 20+ типов из удалённого
    // совета директоров, часть из них — 'safe' с исполнителем, которого
    // больше нет. Дефолт для НЕИЗВЕСТНОГО типа обязан требовать одобрения,
    // а не исполняться сам.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'review-id-1' }] });

    const { ApprovalRequired } = await import('@/lib/agents/safeguards/approval-required');
    const service = new ApprovalRequired();

    const result = await service.request({
      type: 'price_change', // больше не в ACTION_CATEGORIES — проверяем именно дефолт
      description: 'Change price by 5%',
      context: { source: 'board' },
      requested_by: 'agent_x',
      expires_hours: 12,
    });

    expect(result).toEqual({ needs_approval: true, id: 'review-id-1' });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);

    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO agent_approvals');
    expect(sql).toContain('expires_at');
  });

  it('неизвестный тип получает исполнителя unassigned, а не выдуманного агента', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'review-id-2' }] });

    const { ApprovalRequired } = await import('@/lib/agents/safeguards/approval-required');
    const service = new ApprovalRequired();

    await service.request({
      type: 'archive_sos', // тип удалён из реестра (был 'safe' с исполнителем 'rescue')
      description: 'Архивировать SOS-инцидент',
      context: {},
      requested_by: 'agent_x',
    });

    const sql = String(mockPoolQuery.mock.calls[0][0]);
    const params = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain('executor_agent_id');
    expect(params).toContain('unassigned');
  });
});

describe('EXECUTOR_MAP: исполнители — реальные агентства, не имена из удалённого совета', () => {
  // 26.08: было 10 executor'ов (admin/eco/quality/content/hacker/vibe_coder/
  // security/finance/evo/rescue), из них восемь ссылались на agency-файлы,
  // удалённые в апреле 2026 (AGENTS.md, «неэффективный театр», 10 318
  // строк) — и ни разу не вызывались живым кодом (approvalRequired.request()
  // зовётся ровно один раз во всём репозитории). Сторож не даёт реестру
  // снова разойтись с файловой системой молча.
  const AGENCIES_DIR = join(process.cwd(), 'lib/agents/agencies');

  it('каждый executor из approval-required.ts указывает на существующий *-agency.ts', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(join(process.cwd(), 'lib/agents/safeguards/approval-required.ts'), 'utf-8'),
    );
    const block = src.slice(src.indexOf('const EXECUTOR_MAP'), src.indexOf('function getExecutor'));
    const ids = [...block.matchAll(/agent_id:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    const missing = ids.filter((id) => !existsSync(join(AGENCIES_DIR, `${id}-agency.ts`)));
    expect(missing, `исполнитель без файла агентства: ${missing.join(', ')}`).toEqual([]);
  });
});
