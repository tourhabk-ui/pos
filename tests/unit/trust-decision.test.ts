/**
 * Решение A: три улики вместо двух точек — и ни одной уликой меньше.
 *
 * Черта требовала ≥2 путевых точек, иначе «линию не с чем сверить». Для 264
 * записей это приговор без вины: у линии просто нет разметки. Но у линии
 * появились три независимые улики, и вместе они сильнее двух точек на ней:
 * запись прибора, совпадение с оригиналом, подтверждённый донор.
 *
 * План требует пять проверенных случаев. Они здесь, и каждый закрывает свою
 * дыру — любое одиночное снятие условия возвращает старую ошибку.
 */
import { describe, it, expect } from 'vitest';
import { routeTrustDecision, toSourceMatch } from '@/lib/routes/trust-decision';
import { CHECK_FRESH_DAYS } from '@/lib/routes/track-reconcile';

const now = new Date('2026-08-19T00:00:00Z');
const line: Array<[number, number]> = Array.from({ length: 120 }, (_, i) => [
  53.2 + i * 0.0008,
  158.4 + (i % 7) * 0.0004,
]);

/** Полный набор улик: запись прибора, свежая сверка, свой донор. */
const proven = {
  grade: 'unknown' as const,
  track: line,
  waypoints: [],
  evidence: 'recorded' as const,
  mode: 'foot' as const,
  sourceCheck: { verdict: 'same', checkedAt: '2026-08-15T00:00:00Z', geometryHash: 'abc' },
  geometryHash: 'abc',
  donorBinding: 'confirmed' as const,
  continuity: 'continuous' as const,
  now,
};

describe('право вести по трём уликам', () => {
  it('все три улики на месте — линия ведёт без путевых точек', () => {
    const d = routeTrustDecision(proven);
    expect(d.state).toBe('navigable');
    expect(d.canLead).toBe(true);
    expect(d.ledByEvidence, 'рост пригодных без разметки обязан быть видимым').toBe(true);
    expect(d.evidence.lineKind).toBe('recorded_track');
    expect(d.evidence.sourceMatch).toBe('verified');
    expect(d.freshness).toBe('current');
  });

  it('нет донора — права нет: улики о линии, а не о её принадлежности', () => {
    // Ровно тот случай, что дал «Восхождение на Вилючинский» с чужим треком:
    // линия настоящая, но чья — неизвестно.
    const d = routeTrustDecision({ ...proven, donorBinding: 'proximity_only' });
    expect(d.canLead).toBe(false);
    expect(d.reasons.join(' ')).toContain('путевых точек меньше двух');
  });

  it('копия расходится с оригиналом — права нет', () => {
    const d = routeTrustDecision({ ...proven, sourceCheck: { ...proven.sourceCheck, verdict: 'ours_truncated' } });
    expect(d.canLead).toBe(false);
    expect(d.evidence.sourceMatch).toBe('truncated');
  });

  it('линию сверяли, но ДРУГУЮ — улика отсутствует, а не устарела', () => {
    // Геометрию переимпортировали после сверки.
    const d = routeTrustDecision({ ...proven, geometryHash: 'xyz' });
    expect(d.freshness).toBe('unknown');
    expect(d.canLead).toBe(false);
  });

  it('набросок не повышается уликой ни при каких доказательствах копии', () => {
    // Записанное «построена прямыми между точками» — знание обратного, а не
    // незнание. Иначе синтетика, которой кто-то дописал высоты, вернулась бы
    // в снятые треки.
    const d = routeTrustDecision({ ...proven, grade: 'sketch' });
    expect(d.evidence.lineKind).toBe('sketch');
    expect(d.canLead).toBe(false);
    expect(d.ledByEvidence).toBe(false);
  });

  it('облёт не становится пригодным от полного набора улик', () => {
    // Три улики говорят о линии, а не о том, что по ней идут пешком.
    const d = routeTrustDecision({ ...proven, mode: 'air' });
    expect(d.state).toBe('not_on_foot');
    expect(d.evidence.activityFit).toBe('non_foot');
  });

  it('протухшая сверка ничем не лучше отсутствующей', () => {
    const d = routeTrustDecision({
      ...proven,
      // Старше срока годности на сутки — срок берётся из правила, не из головы:
      // 13.11.2026 он стал годом, и зашитая дата «восемь месяцев назад» перестала быть протухшей.
      sourceCheck: { ...proven.sourceCheck, checkedAt: new Date(now.getTime() - (CHECK_FRESH_DAYS + 1) * 86_400_000).toISOString() },
    });
    expect(d.freshness).toBe('review_due');
    expect(d.canLead).toBe(false);
    // А на сутки моложе срока — ещё годна.
    const fresh = routeTrustDecision({
      ...proven,
      sourceCheck: { ...proven.sourceCheck, checkedAt: new Date(now.getTime() - (CHECK_FRESH_DAYS - 1) * 86_400_000).toISOString() },
    });
    expect(fresh.freshness).toBe('current');
    expect(fresh.canLead).toBe(true);
  });
});

describe('вердикт сверки → факт о копии', () => {
  it('незнакомое и отсутствующее честно становится «не сверяли»', () => {
    expect(toSourceMatch('same')).toBe('verified');
    expect(toSourceMatch('ours_truncated')).toBe('truncated');
    expect(toSourceMatch('line_moved')).toBe('different');
    expect(toSourceMatch('unreachable')).toBe('not_checked');
    expect(toSourceMatch(null)).toBe('not_checked');
  });
});
