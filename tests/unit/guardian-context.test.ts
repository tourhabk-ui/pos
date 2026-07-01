import { describe, it, expect } from 'vitest';
import { gradeNameMatch } from '@/lib/kuzmich/guardian-context';

describe('gradeNameMatch (CRAG-lite relevance grading, Roitman §16.5.5)', () => {
  it('grades an exact name match as high confidence', () => {
    expect(gradeNameMatch('Толбачик', 'Толбачик')).toBe('high');
  });

  it('grades case/whitespace-insensitive matches as high confidence', () => {
    expect(gradeNameMatch('толбачик', '  Толбачик  ')).toBe('high');
  });

  it('grades a query fully covered by a longer candidate name as high confidence', () => {
    expect(gradeNameMatch('Авачинский', 'Авачинский вулкан')).toBe('high');
  });

  it('grades a candidate name fully covered by the query as high confidence', () => {
    expect(gradeNameMatch('Мутновский вулкан кратер', 'Мутновский вулкан')).toBe('high');
  });

  it('grades an unrelated short-substring collision as low confidence', () => {
    // ILIKE '%Толбачик%' can bind a short unrelated place containing a shared
    // substring — this must NOT be treated as a confident safety-data match.
    expect(gradeNameMatch('Толбачик', 'Толбачинский дол дальний кордон')).toBe('low');
  });

  it('grades no overlap at all as low confidence', () => {
    expect(gradeNameMatch('Курильское озеро', 'Авачинская бухта')).toBe('low');
  });

  it('grades empty query or candidate as low confidence', () => {
    expect(gradeNameMatch('', 'Толбачик')).toBe('low');
    expect(gradeNameMatch('Толбачик', '')).toBe('low');
  });
});
