/**
 * Сторож общего сита эволюции: улика находки обязана найтись в файле.
 *
 * Существующие проверки finding-guard перечисляют ИЗВЕСТНЫЕ врания и растут по
 * одному случаю за инцидент. Это сито не спрашивает, о чём находка, — оно
 * спрашивает, есть ли процитированное в файле вообще, и потому закрывает весь
 * класс разом, включая враньё, которого мы ещё не видели.
 *
 * Проверяется настоящим случаем #768/#770/#772/#774 (25.07): модель
 * процитировала конкатенацию SQL в файле, где весь запрос параметризован.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  evidenceFragments,
  evidenceIsQuoted,
  verifyEvidence,
  type CandidateFinding,
} from '../../lib/agents/evo/finding-guard';

const finding = (over: Partial<CandidateFinding>): CandidateFinding => ({
  title: 'т', description: 'о', suggestion: 'п', ...over,
});

const SOURCE = `
export async function getBooking(id: string) {
  const { rows } = await pool.query(
    'SELECT id, status FROM operator_bookings WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}
`;

describe('улика, которой в файле нет', () => {
  it('выдуманная конкатенация SQL — случай #768', () => {
    const f = finding({
      title: 'SQL-инъекция в getBooking',
      evidence: "`'SELECT * FROM bookings WHERE id = ' + bookingId`",
    });
    expect(verifyEvidence(f, SOURCE)).toBe('evidence_not_in_source');
  });

  it('шаблонная строка, которой в файле нет', () => {
    const f = finding({ evidence: '`WHERE id = ${tourId}`' });
    expect(verifyEvidence(f, SOURCE)).toBe('evidence_not_in_source');
  });
});

describe('улика, которая в файле есть', () => {
  it('дословная строка проходит', () => {
    const f = finding({
      evidence: "`'SELECT id, status FROM operator_bookings WHERE id = $1'`",
    });
    expect(verifyEvidence(f, SOURCE)).toBeNull();
  });

  it('перенос строки и отступы улику не убивают', () => {
    const f = finding({ evidence: '`const { rows } = await pool.query(`' });
    expect(verifyEvidence(f, SOURCE)).toBeNull();
  });

  it('без кавычек, длинной строкой — тоже проходит', () => {
    const f = finding({ evidence: 'SELECT id, status FROM operator_bookings WHERE id = $1' });
    expect(verifyEvidence(f, SOURCE)).toBeNull();
  });
});

describe('третий исход: проверить нечем', () => {
  it('улики не дали — «не смог», отдельным кодом', () => {
    expect(verifyEvidence(finding({}), SOURCE)).toBe('evidence_missing');
  });

  it('пустая улика считается отсутствующей', () => {
    expect(verifyEvidence(finding({ evidence: '   ' }), SOURCE)).toBe('evidence_missing');
  });

  it('тела файла нет — сито молчит, решает вызывающий', () => {
    expect(verifyEvidence(finding({ evidence: 'что угодно' }), null)).toBeNull();
  });
});

describe('короткий обрывок доказательством не считается', () => {
  it('«id» нашлось бы в любом файле — в куски не берём', () => {
    expect(evidenceFragments('`id`')).toEqual([]);
    expect(evidenceIsQuoted('`id`', SOURCE)).toBe(false);
  });
});

describe('сито включено в живой путь ревью', () => {
  const SRC = readFileSync('lib/agents/evo/growth-agent.ts', 'utf8');

  it('промпт требует дословную улику из файла', () => {
    expect(SRC).toContain('"evidence"');
    expect(SRC).toContain('символ в символ');
  });

  it('фильтр находок зовёт сито', () => {
    expect(SRC).toContain('verifyEvidence(');
  });

  it('улика доезжает от ответа модели до сита', () => {
    expect(SRC).toMatch(/evidence:\s*p\.evidence/);
  });
});
