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

/**
 * Инцидент 24.07: ночью рука вынесла 10 issues — все про один booking-роут,
 * все ложные, и они съели весь REPORT_LIMIT, из-за чего разведка (intel,
 * severity medium) не доехала до трекера ни разу. Два инварианта ниже держат
 * оба конца: недостоверное не публикуется, разведка не голодает.
 */
describe('страж достоверности на публикации', () => {
  it('находка с чужим стеком (getServerSession/Prisma) не публикуется', () => {
    const f = finding({
      title: 'Нет проверки авторизации',
      suggestion: 'Использовать getServerSession из next-auth для проверки сессии',
    });
    expect(isReportable(f)).toBe(false);
  });

  it('находка «X вместо X» (несвязная) не публикуется', () => {
    const f = finding({
      title: 'Неверный вызов провайдера',
      description: 'Используется callAIWaterfall вместо callAIWaterfall — нарушение конвенции.',
      suggestion: 'Заменить verifyToken на verifyToken.',
    });
    expect(isReportable(f)).toBe(false);
  });

  it('нормальная находка по-прежнему публикуется', () => {
    expect(isReportable(finding())).toBe(true);
  });

  it('selectReportable выбрасывает недостоверные из выборки', () => {
    const good = finding({ id: 'aaaaaaaa-1111-1111-1111-111111111111' });
    const bad = finding({
      id: 'bbbbbbbb-2222-2222-2222-222222222222',
      severity: 'critical',
      suggestion: 'Добавить getServerSession из next-auth',
    });
    const picked = selectReportable([bad, good], 10);
    expect(picked.map(f => f.id)).toEqual([good.id]);
  });
});

describe('бронь квоты под разведку (петля «глаза наружу → руки внутрь»)', () => {
  const critical = (n: number) =>
    Array.from({ length: n }, (_, i) => finding({
      id: `cccccccc-${String(i).padStart(4, '0')}-1111-1111-111111111111`,
      category: 'bug', severity: 'critical', title: `Критичная находка ${i}`,
    }));
  const intel = (n: number) =>
    Array.from({ length: n }, (_, i) => finding({
      id: `11111111-${String(i).padStart(4, '0')}-2222-2222-222222222222`,
      category: 'intel', severity: 'medium', title: `Возможность из разведки ${i}`,
    }));

  it('поток критикалов больше НЕ вытесняет разведку целиком', () => {
    const picked = selectReportable([...critical(20), ...intel(5)], 10);
    const intelCount = picked.filter(f => f.category === 'intel').length;
    expect(picked).toHaveLength(10);
    expect(intelCount).toBe(3);            // бронь OUTWARD_RESERVE
    expect(picked.filter(f => f.category === 'bug')).toHaveLength(7);
  });

  it('нет разведки — вся квота уходит коду (бронь не простаивает)', () => {
    const picked = selectReportable(critical(20), 10);
    expect(picked).toHaveLength(10);
    expect(picked.every(f => f.category === 'bug')).toBe(true);
  });

  it('разведки меньше брони — берём сколько есть', () => {
    const picked = selectReportable([...critical(20), ...intel(1)], 10);
    expect(picked.filter(f => f.category === 'intel')).toHaveLength(1);
    expect(picked).toHaveLength(10);
  });

  it('находок меньше лимита — берём все', () => {
    const picked = selectReportable([...critical(2), ...intel(1)], 10);
    expect(picked).toHaveLength(3);
  });
});
