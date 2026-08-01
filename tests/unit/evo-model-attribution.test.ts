/**
 * Кто думал — видно там, где читают.
 *
 * Владелец потребовал, чтобы аудит считала самая мощная модель. В коде она уже
 * стоит первой: callAIDecisionDetailed идёт флагман → OpenRouter-релей →
 * Anthropic напрямую → и только потом DeepSeek/Qwen. Но waterfall съезжает на
 * фоллбэк МОЛЧА, когда нет ключа или релея, и снаружи это неотличимо: скан
 * зелёный, находки есть.
 *
 * Атрибуция модели писалась в БД с EVO-4, но не доходила ни до тела тикета, ни
 * до ответа крона — то есть ровно туда, куда смотрит человек. «Аудит считает
 * флагман» оставалось верой. Тесты держат обратное: понижение видно без
 * похода в базу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildIssueBody, type GrowthFinding } from '@/lib/agents/evo/issue-reporter';
import { buildEvoAlert, isFlagshipDecision } from '@/lib/agents/evo/alert';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const REPORT_ROUTE = read('app/api/cron/evo-report/route.ts');
const GROWTH = read('lib/agents/evo/growth-agent.ts');

const base: GrowthFinding = {
  id: 'f-1',
  category: 'bug',
  severity: 'high',
  file_path: 'lib/x.ts',
  line_number: 10,
  title: 'Заголовок',
  description: 'Описание',
  suggestion: 'Предложение',
};

describe('модель в теле тикета', () => {
  it('флагман назван поимённо', () => {
    const body = buildIssueBody({ ...base, model: 'anthropic/claude-opus-5' });
    expect(body).toContain('anthropic/claude-opus-5');
  });

  it('фоллбэк тоже назван — понижение должно бросаться в глаза', () => {
    const body = buildIssueBody({ ...base, model: 'deepseek-chat' });
    expect(body).toContain('deepseek-chat');
  });

  it('детерминированная находка не выдаётся за работу модели', () => {
    const body = buildIssueBody({ ...base, model: 'deterministic' });
    expect(body).toContain('детерминированной проверкой');
    expect(body).not.toContain('моделью `deterministic`');
  });

  it('старые находки без атрибуции честно помечены, а не приписаны флагману', () => {
    const body = buildIssueBody({ ...base, model: null });
    expect(body).toContain('не записана');
  });
});

describe('модель доезжает до тикета и до ответа крона', () => {
  it('выборка находок тянет model из БД', () => {
    expect(REPORT_ROUTE).toContain('suggestion, status, model');
  });

  it('ответ скана называет модель прогона', () => {
    expect(GROWTH).toContain('decision_model');
    expect(GROWTH).toContain('decisionModel = review.model ?? null');
  });
});

describe('телеграм-отчёт называет модель и кричит про понижение', () => {
  const scan = (decision_model: string | null) => ({
    issues: [], new_issues: 0, duration_ms: 1000,
    coverage: { source: 'github', files_listed: 900, files_reviewed: 20, mock_files_scanned: 20 },
    decision_model,
  });
  const quiet = { evolution: { processed: 0 }, rescue: { alerts: [] }, errors: [] as string[] };

  it('флагман назван в отчёте', () => {
    const text = buildEvoAlert({ scan: scan('anthropic/claude-opus-5'), ...quiet });
    // Тихий прогон на флагмане алерта не требует — шум владельцу не нужен.
    expect(text).toBeNull();
    const withNews = buildEvoAlert({
      scan: { ...scan('anthropic/claude-opus-5'), new_issues: 2 }, ...quiet,
    });
    expect(withNews).toContain('Модель аудита: anthropic/claude-opus-5');
  });

  it('съезд на фоллбэк сам по себе повод для отчёта', () => {
    // Даже когда прогон тихий: иначе понижение узнаётся только случайно.
    const text = buildEvoAlert({ scan: scan('deepseek-chat'), ...quiet });
    expect(text).not.toBeNull();
    expect(text).toContain('ФОЛЛБЭК');
    expect(text).toContain('deepseek-chat');
  });

  it('прямой путь в Anthropic — тоже флагман, а не понижение', () => {
    expect(isFlagshipDecision('anthropic:claude-opus-5')).toBe(true);
    expect(isFlagshipDecision('anthropic/claude-opus-5')).toBe(true);
    expect(isFlagshipDecision('deepseek-chat')).toBe(false);
    expect(isFlagshipDecision('qwen-max')).toBe(false);
    expect(isFlagshipDecision(null)).toBe(false);
  });

  it('решатель молчит — это тревога, а не тишина (контракт сменён 01.08)', () => {
    // Прежний тест утверждал «null = ревью не запускалось» — при
    // files_reviewed: 20 в этой же фикстуре. Это и было слепое пятно:
    // четыре прогона подряд с немым решателем выглядели зелёными.
    // Файлы ушли в ревью, модель не записана → не ответил ни один
    // провайдер, и «0 находок» ничего не значит.
    const text = buildEvoAlert({ scan: scan(null), ...quiet });
    expect(text).not.toBeNull();
    expect(text).toContain('РЕШАТЕЛЬ МОЛЧИТ');
  });

  it('а вот прогон, где ревью НЕ запускалось, тревоги не даёт', () => {
    const noReview = {
      ...scan(null),
      coverage: { source: 'github', files_listed: 900, files_reviewed: 0, mock_files_scanned: 20 },
    };
    expect(buildEvoAlert({ scan: noReview, ...quiet })).toBeNull();
  });
});
