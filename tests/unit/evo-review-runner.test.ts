/**
 * §8 — AI-вызов решателя эволюции переезжает на раннер GitHub (evo-review.yml),
 * тем же приёмом, что evo-judge.yml уже год использует для разбора находок:
 * прод в РФ упирается в гео-блок Cloudflare на пути к флагману, раннер — нет.
 *
 * Разделение: прод выбирает файлы (leдger живёт в БД, недостижим с раннера) и
 * принимает готовые находки; раннер читает тела файлов из своего checkout и
 * зовёт модель. Фильтр находок — ОДНА функция на оба пути (прод-фоллбэк и
 * раннер), чтобы страж не расходился в зависимости от того, кто позвал модель.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  parseAiReviewJson,
  filterAndMapReviewFindings,
  buildReviewUserMessage,
  clampForReview,
  MAX_FILE_CHARS,
  type RawReviewFinding,
} from '@/lib/agents/evo/growth-agent';
import { buildReviewResult } from '@/scripts/evo-review';

describe('parseAiReviewJson: снимает markdown-ограждение', () => {
  it('чистый JSON парсится как есть', () => {
    const parsed = parseAiReviewJson('[{"file":"a.ts","title":"t","description":"d","severity":"high","suggestion":"s"}]');
    expect(parsed).toEqual([{ file: 'a.ts', title: 't', description: 'd', severity: 'high', suggestion: 's' }]);
  });

  it('markdown-ограждение снимается', () => {
    const parsed = parseAiReviewJson('```json\n[{"file":"a.ts","title":"t","description":"d","severity":"high","suggestion":"s"}]\n```');
    expect(parsed).toHaveLength(1);
  });

  it('битый JSON бросает — вызывающий обязан назвать причину, не проглотить', () => {
    expect(() => parseAiReviewJson('это не json')).toThrow();
  });
});

describe('filterAndMapReviewFindings: страж одинаков для прод-фоллбэка и раннера', () => {
  const fileContents = new Map([
    ['app/api/x/route.ts', 'export async function GET(id) { try { await pool.query("SELECT * FROM t WHERE id = " + id); } catch (e) { console.error(e); } }'],
  ]);

  const base: RawReviewFinding = {
    file: 'app/api/x/route.ts', title: 'SQL-инъекция', description: 'конкатенация строк вместо $1',
    severity: 'critical', suggestion: 'использовать $1',
  };

  it('находка по файлу, тело которого модель видела, — принята', () => {
    const mapped = filterAndMapReviewFindings([base], fileContents, 'anthropic/claude-opus-5');
    expect(mapped).toHaveLength(1);
    expect(mapped[0].model).toBe('anthropic/claude-opus-5');
    expect(mapped[0].category).toBe('bug');
  });

  it('находка по файлу, которого модель не видела, — отброшена', () => {
    const mapped = filterAndMapReviewFindings(
      [{ ...base, file: 'lib/unseen.ts' }], fileContents, 'anthropic/claude-opus-5',
    );
    expect(mapped).toEqual([]);
  });

  it('ложное «нет try/catch», когда try/catch в теле ЕСТЬ, — отброшено верификацией', () => {
    const mapped = filterAndMapReviewFindings(
      [{ ...base, title: 'Нет try/catch', description: 'внешний вызов без try/catch' }],
      fileContents, 'deepseek-chat',
    );
    expect(mapped).toEqual([]);
  });

  it('без атрибуции модели (null) — находка всё равно проходит, поле просто не проставлено', () => {
    const mapped = filterAndMapReviewFindings([base], fileContents, null);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].model).toBeUndefined();
  });
});

describe('clampForReview: тот же клэмп у прод-фоллбэка и у раннера', () => {
  it('короткий текст не трогается', () => {
    expect(clampForReview('короткий текст')).toBe('короткий текст');
  });

  it('длинный текст обрезается по MAX_FILE_CHARS с пометкой', () => {
    const long = 'x'.repeat(MAX_FILE_CHARS + 100);
    const clamped = clampForReview(long);
    expect(clamped.length).toBeLessThan(long.length);
    expect(clamped).toContain('обрезано для ревью');
  });
});

describe('buildReviewUserMessage: одна функция строит промпт для обоих путей', () => {
  it('блоки файлов и урок попадают в сообщение', () => {
    const msg = buildReviewUserMessage(['━━━ a.ts ━━━\ncode'], '\nВЫУЧЕНО: не повторяй X');
    expect(msg).toContain('a.ts');
    expect(msg).toContain('ВЫУЧЕНО: не повторяй X');
  });
});

describe('buildReviewResult (scripts/evo-review.ts): чистая сборка результата раннера', () => {
  const fileContents = new Map([['a.ts', 'const x = 1;']]);

  it('решатель не ответил (null) — issues пусты, причина названа, а не проглочена', () => {
    const result = buildReviewResult(null, 'deepseek(deepseek-chat): HTTP 402', null, ['flagship: нет ключа'], fileContents, ['a.ts']);
    expect(result.issues).toEqual([]);
    expect(result.decision_error).toBe('deepseek(deepseek-chat): HTTP 402');
    expect(result.model).toBeNull();
  });

  it('ответ не парсится — атрибуция модели не теряется (тот же баг, что чинили на проде)', () => {
    const result = buildReviewResult('это не json', null, 'anthropic/claude-opus-5', [], fileContents, ['a.ts']);
    expect(result.issues).toEqual([]);
    expect(result.model).toBe('anthropic/claude-opus-5');
    expect(result.decision_error).toMatch(/не распарсился/);
  });

  it('здоровый ответ — находки отфильтрованы и промаркированы моделью', () => {
    const raw = JSON.stringify([{ file: 'a.ts', title: 'Проблема', description: 'описание', severity: 'medium', suggestion: 'исправить' }]);
    const result = buildReviewResult(raw, null, 'anthropic/claude-opus-5', [], fileContents, ['a.ts']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].model).toBe('anthropic/claude-opus-5');
    expect(result.decision_error).toBeNull();
  });
});

// ── Роуты: авторизация и запись ─────────────────────────────────────────────

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));

function req(url: string, opts: { method: string; body?: unknown; auth?: string }): NextRequest {
  return new Request(url, {
    method: opts.method,
    headers: { 'Content-Type': 'application/json', ...(opts.auth ? { Authorization: `Bearer ${opts.auth}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }) as unknown as NextRequest;
}

describe('POST /api/cron/evo-findings', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('без секрета — 401, ни одного запроса к БД', async () => {
    const { POST } = await import('@/app/api/cron/evo-findings/route');
    const res = await POST(req('http://l/api/cron/evo-findings', { method: 'POST', body: { issues: [], review_files: [] } }));
    expect(res.status).toBe(401);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('невалидное тело — 400', async () => {
    const { POST } = await import('@/app/api/cron/evo-findings/route');
    const res = await POST(req('http://l/api/cron/evo-findings', {
      method: 'POST', auth: 'test-secret', body: { issues: [{ category: 'not-a-category' }], review_files: [] },
    }));
    expect(res.status).toBe(400);
  });

  it('валидные находки — записаны через persistGrowthIssues, дубли не переспрашиваются', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`FROM evo_growth_issues\n        WHERE status = 'rejected'`) || sql.includes("WHERE status = 'rejected'")) {
        return { rows: [] }; // loadRejectedSignatures: ничего не отвергнуто
      }
      if (sql.includes('INSERT INTO evo_growth_scans')) {
        return { rows: [{ id: 'scan-1' }] };
      }
      if (sql.includes('SELECT id FROM evo_growth_issues')) {
        return { rows: [] }; // не существует — вставляем
      }
      if (sql.includes('SELECT COUNT(*)::int AS n')) {
        return { rows: [{ n: 0 }] };
      }
      return { rows: [] };
    });

    const { POST } = await import('@/app/api/cron/evo-findings/route');
    const res = await POST(req('http://l/api/cron/evo-findings', {
      method: 'POST',
      auth: 'test-secret',
      body: {
        issues: [{ category: 'bug', severity: 'high', file_path: 'a.ts', title: 'T', description: 'D', suggestion: 'S', model: 'anthropic/claude-opus-5' }],
        review_files: ['a.ts'],
        model: 'anthropic/claude-opus-5',
        decision_error: null,
        provenance: [],
      },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.new_issues).toBe(1);
    expect(poolQueryMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO evo_growth_issues'))).toBe(true);
  });

  it('решатель молчал (issues пусты) — запись всё равно проходит, причина сохранена в ответе', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO evo_growth_scans')) return { rows: [{ id: 'scan-2' }] };
      return { rows: [] };
    });
    const { POST } = await import('@/app/api/cron/evo-findings/route');
    const res = await POST(req('http://l/api/cron/evo-findings', {
      method: 'POST', auth: 'test-secret',
      body: { issues: [], review_files: ['a.ts'], model: null, decision_error: 'нет ни одного ключа', provenance: null },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.decision_error).toBe('нет ни одного ключа');
    expect(json.new_issues).toBe(0);
  });
});

describe('GET /api/cron/evo-review-job', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('без секрета — 401', async () => {
    const { GET } = await import('@/app/api/cron/evo-review-job/route');
    const res = await GET(req('http://l/api/cron/evo-review-job', { method: 'GET' }));
    expect(res.status).toBe(401);
  });
});
