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
