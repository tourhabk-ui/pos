/**
 * Рука эволюции → GitHub Issues: детерминированное построение title/body и
 * отбор находок. Первый оборот петли «заметил → сформулировал → разместил
 * задачу» без человека — значит формат и фильтр обязаны быть предсказуемы.
 */
import { describe, it, expect } from 'vitest';
import {
  buildIssueTitle, buildIssueBody, isReportable, selectReportable, severityRank,
  type GrowthFinding,
} from '@/lib/agents/evo/issue-reporter';

const finding = (over: Partial<GrowthFinding> = {}): GrowthFinding => ({
  id: '11111111-1111-1111-1111-111111111111',
  category: 'performance',
  severity: 'high',
  file_path: 'lib/foo.ts',
  line_number: 42,
  title: 'Медленный запрос без индекса',
  description: 'Запрос сканирует всю таблицу при каждом рендере.',
  suggestion: 'Добавить индекс по колонке created_at.',
  ...over,
});

describe('buildIssueTitle', () => {
  it('стабильный формат [evo/категория] заголовок (severity)', () => {
    expect(buildIssueTitle(finding())).toBe('[evo/performance] Медленный запрос без индекса (high)');
  });
  it('неизвестный severity нормализуется к medium', () => {
    expect(buildIssueTitle(finding({ severity: 'weird' }))).toMatch(/\(medium\)$/);
  });
  it('длинный заголовок обрезается', () => {
    const t = buildIssueTitle(finding({ title: 'о'.repeat(300) }));
    expect(t.length).toBeLessThan(220);
  });
});

describe('buildIssueBody', () => {
  it('содержит категорию, severity, файл:строку, описание, предложение и footer с id', () => {
    const body = buildIssueBody(finding());
    expect(body).toContain('`performance`');
    expect(body).toContain('`high`');
    expect(body).toContain('`lib/foo.ts:42`');
    expect(body).toContain('Запрос сканирует всю таблицу');
    expect(body).toContain('**Предложение:**');
    expect(body).toContain('Добавить индекс');
    expect(body).toContain('11111111-1111-1111-1111-111111111111');
  });
  it('без файла и без предложения — не падает и не печатает пустые секции', () => {
    const body = buildIssueBody(finding({ file_path: null, line_number: null, suggestion: null }));
    expect(body).not.toContain('**Файл:**');
    expect(body).not.toContain('**Предложение:**');
  });
});

describe('isReportable', () => {
  it('suggested без issue_url и не low → да', () => {
    expect(isReportable({ severity: 'high', status: 'suggested', github_issue_url: null })).toBe(true);
  });
  it('уже вынесенное (есть issue_url) → нет', () => {
    expect(isReportable({ severity: 'high', status: 'suggested', github_issue_url: 'https://x/1' })).toBe(false);
  });
  it('low severity → нет (косметику в трекер не выносим)', () => {
    expect(isReportable({ severity: 'low', status: 'suggested' })).toBe(false);
  });
  it('не suggested (open/accepted/rejected) → нет', () => {
    expect(isReportable({ severity: 'critical', status: 'open' })).toBe(false);
    expect(isReportable({ severity: 'critical', status: 'accepted' })).toBe(false);
  });
});

describe('selectReportable', () => {
  it('фильтрует, сортирует critical→low и обрезает по лимиту', () => {
    const items = [
      finding({ id: 'a', severity: 'medium', status: 'suggested' } as Partial<GrowthFinding>),
      finding({ id: 'b', severity: 'critical', status: 'suggested' } as Partial<GrowthFinding>),
      finding({ id: 'c', severity: 'low', status: 'suggested' } as Partial<GrowthFinding>), // отсеется
      finding({ id: 'd', severity: 'high', status: 'suggested' } as Partial<GrowthFinding>),
    ];
    const out = selectReportable(items, 2);
    expect(out.map((f) => f.id)).toEqual(['b', 'd']); // critical, high; medium не влез, low отсеян
  });
  it('severityRank: critical<high<medium<low', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('medium'));
    expect(severityRank('medium')).toBeLessThan(severityRank('low'));
  });
});
