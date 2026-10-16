/**
 * Счёт панели видимости (замер владельца 16.10; критерии записаны до первого
 * прогона — docs/agents/AI_VISIBILITY.md). Сторож вызывает функции счёта на
 * граничных данных: что входит в набор, что считается «ответом с vedarai.ru»,
 * доли с Уилсоном и вердикт К1/К2 (CLAUDE.md §4: правило в функции — вызовом).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseQuestions, markAnswer, textMentionsDomain, hostOf, answerHasDomain,
  shareByAssistant, oursRule, domainRule, growth, verdict, rankCitedDomains, renderShareTable,
  type PanelAnswer, type Share,
} from '@/lib/ai/visibility-panel';

const q = (over: Record<string, unknown> = {}) => ({
  id: 'q1', text: 'Когда лучше ехать на Камчатку?', lang: 'ru', intent: 'planning', source: 'wordstat', ...over,
});

describe('набор вопросов: только с источником, ничего не дополняется', () => {
  it('годный вопрос принят, хэш стоит на наборе', () => {
    const s = parseQuestions([q()]);
    expect(s.questions).toHaveLength(1);
    expect(s.rejected).toEqual([]);
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('без источника, с чужим источником, намерением или языком — отказ с причиной', () => {
    const s = parseQuestions([
      q({ id: 'a', source: undefined }),
      q({ id: 'b', source: 'memory' }),
      q({ id: 'c', intent: 'shopping' }),
      q({ id: 'd', lang: 'de' }),
      q({ id: 'e', text: '  ' }),
      q({ id: '' }),
    ]);
    expect(s.questions).toEqual([]);
    expect(s.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.rejected[0].reason).toMatch(/источник/);
  });

  it('повтор id — отказ, а не перезапись', () => {
    const s = parseQuestions([q(), q({ text: 'другой' })]);
    expect(s.questions).toHaveLength(1);
    expect(s.rejected[0].reason).toMatch(/повтор/);
  });

  it('не массив — отказ, а не пустой успешный набор', () => {
    expect(parseQuestions({}).rejected[0].reason).toMatch(/не массив/);
  });

  it('хэш не зависит от порядка строк и меняется от правки текста', () => {
    const a = parseQuestions([q({ id: 'x' }), q({ id: 'y' })]).sha256;
    const b = parseQuestions([q({ id: 'y' }), q({ id: 'x' })]).sha256;
    const c = parseQuestions([q({ id: 'x' }), q({ id: 'y', text: 'Сколько стоит тур?' })]).sha256;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('ответ с vedarai.ru', () => {
  it('домен в тексте в любой записи засчитан', () => {
    for (const t of ['см. vedarai.ru', 'https://vedarai.ru/catalog', 'www.vedarai.ru.', '(VEDARAI.RU)', 'zh.vedarai.ru/tours']) {
      expect(textMentionsDomain(t, 'vedarai.ru'), t).toBe(true);
    }
  });

  it('похожий чужой домен не засчитан', () => {
    for (const t of ['notvedarai.ru', 'vedarai.ru-tour.com', 'vedarai.run', 'myvedarai.ru']) {
      expect(textMentionsDomain(t, 'vedarai.ru'), t).toBe(false);
    }
  });

  it('домен среди источников засчитан и без упоминания в тексте', () => {
    const m = markAnswer('Туры на Камчатку продают несколько платформ.', ['https://vedarai.ru/catalog?utm_source=openai']);
    expect(m).toMatchObject({ ours: true, ours_in_text: false, ours_in_sources: true, brand_only: false });
  });

  it('имя без домена — сигнал, не засчитывается', () => {
    for (const t of ['На платформе Ведар есть туры', 'по данным Ведара', 'Vedar lists tours', '维达尔平台']) {
      const m = markAnswer(t, []);
      expect(m.ours, t).toBe(false);
      expect(m.brand_only, t).toBe(true);
    }
    expect(markAnswer('ведро и вёдра', []).brand_only).toBe(false);
  });

  it('зеркало кода на чужом домене — не наш ответ', () => {
    const m = markAnswer('Есть открытый репозиторий', ['https://odel.app/tourhabk-ui/pos']);
    expect(m.ours).toBe(false);
    expect(m.cited).toEqual(['odel.app']);
  });

  it('домены источников без www и повторов; неразобранный адрес посчитан', () => {
    const m = markAnswer('', ['https://www.kamchatkaland.ru/a', 'https://kamchatkaland.ru/b', '::::', '']);
    expect(m.cited).toEqual(['kamchatkaland.ru']);
    expect(m.unparsed_sources).toBe(2);
    expect(hostOf('tokamchatka.ru')).toBe('tokamchatka.ru');
  });

  it('конкурент: по источникам и по тексту', () => {
    const m = markAnswer('Смотрите kamchatkaland.ru', ['https://experience.tripster.ru/x']);
    expect(answerHasDomain('Смотрите kamchatkaland.ru', m, 'kamchatkaland.ru')).toBe(true);
    expect(answerHasDomain('', m, 'tripster.ru')).toBe(true);
    expect(answerHasDomain('', m, 'na-kamchatku.ru')).toBe(false);
  });
});

const ans = (assistant: string, question_id: string, text: string, sources: string[] = [], outcome: PanelAnswer['outcome'] = 'answered'): PanelAnswer => ({
  assistant, question_id, day: 'd1', repeat: 1, outcome, text,
  marks: outcome === 'answered' ? markAnswer(text, sources) : null,
});

describe('доли по ассистентам', () => {
  it('знаменатель — только ответы; «не смог» и «не измерено» считаются отдельно', () => {
    const [s] = shareByAssistant([
      ans('gpt', 'q1', 'vedarai.ru'),
      ans('gpt', 'q1', 'нет'),
      ans('gpt', 'q2', 'нет'),
      ans('gpt', 'q2', '', [], 'could_not_ask'),
      ans('gpt', 'q3', '', [], 'not_measured'),
    ], oursRule);
    expect(s).toMatchObject({ assistant: 'gpt', answered: 3, hits: 1, questions: 2, questions_hit: 1, could_not_ask: 1, not_measured: 1 });
    expect(s.share).toBeCloseTo(1 / 3);
    expect(s.ci!.low).toBeGreaterThan(0);
    expect(s.ci!.high).toBeLessThan(1);
  });

  it('ни одного ответа — доли нет, а не ноль', () => {
    const [s] = shareByAssistant([ans('grok', 'q1', '', [], 'could_not_ask')], oursRule);
    expect(s.share).toBeNull();
    expect(s.ci).toBeNull();
  });

  it('правило конкурента считает тем же счётом', () => {
    const [s] = shareByAssistant([ans('gpt', 'q1', 'kamchatkaland.ru'), ans('gpt', 'q2', 'нет')], domainRule('kamchatkaland.ru'));
    expect(s.hits).toBe(1);
  });
});

const share = (assistant: string, hits: number, answered: number): Share =>
  shareByAssistant(
    Array.from({ length: answered }, (_, i) => ans(assistant, `q${i}`, i < hits ? 'vedarai.ru' : 'нет')),
    oursRule,
  )[0];

describe('вердикт К1/К2', () => {
  it('рост — нижняя граница повтора выше точечной доли базы', () => {
    expect(growth(share('gpt', 0, 100), share('gpt', 10, 100))).toBe('grew');
    expect(growth(share('gpt', 10, 100), share('gpt', 12, 100))).toBe('not_grew');
  });

  it('при нулевой базе одно попадание уже рост — свойство правила, записанное в критериях', () => {
    expect(growth(share('gpt', 0, 900), share('gpt', 1, 900))).toBe('grew');
  });

  it('нет ответов в одном из замеров — «не смог проверить»', () => {
    expect(growth(undefined, share('gpt', 5, 10))).toBe('unknown');
    const empty = shareByAssistant([ans('gpt', 'q1', '', [], 'could_not_ask')], oursRule)[0];
    expect(growth(empty, share('gpt', 5, 10))).toBe('unknown');
  });

  it('два ассистента выросли, конкуренты нет — выполнен', () => {
    const v = verdict(
      { baseline: [share('gpt', 0, 50), share('grok', 0, 50), share('sonar', 0, 50)], followup: [share('gpt', 10, 50), share('grok', 8, 50), share('sonar', 0, 50)] },
      { 'kamchatkaland.ru': { baseline: [share('gpt', 20, 50), share('grok', 20, 50)], followup: [share('gpt', 20, 50), share('grok', 21, 50)] } },
    );
    expect(v).toMatchObject({ counted: ['gpt', 'grok'], struck: [], outcome: 'met' });
  });

  it('вырос и конкурент в том же ассистенте — ассистент вычеркнут', () => {
    const v = verdict(
      { baseline: [share('gpt', 0, 50), share('grok', 0, 50)], followup: [share('gpt', 10, 50), share('grok', 8, 50)] },
      { 'kamchatkaland.ru': { baseline: [share('gpt', 0, 50), share('grok', 20, 50)], followup: [share('gpt', 15, 50), share('grok', 20, 50)] } },
    );
    expect(v.counted).toEqual(['grok']);
    expect(v.struck).toEqual([{ assistant: 'gpt', competitors: ['kamchatkaland.ru'] }]);
    expect(v.outcome).toBe('not_met');
  });

  it('один засчитан, второй не измерен — не «не выполнен», а «не смог проверить»', () => {
    const empty = shareByAssistant([ans('gemini', 'q1', '', [], 'not_measured')], oursRule)[0];
    const v = verdict(
      { baseline: [share('gpt', 0, 50), empty], followup: [share('gpt', 10, 50), empty] },
      {},
    );
    expect(v).toMatchObject({ counted: ['gpt'], unknown: ['gemini'], outcome: 'unknown' });
  });
});

describe('карта источников', () => {
  it('считает ответы, а не ссылки; наш домен в ранг не входит; фильтр по намерению', () => {
    const rec = (intent: string, sources: string[], outcome: PanelAnswer['outcome'] = 'answered') =>
      ({ ...ans('gpt', 'q', '', sources, outcome), intent });
    const ranked = rankCitedDomains([
      rec('prices', ['https://kamchatkaland.ru/a', 'https://kamchatkaland.ru/b', 'https://vedarai.ru/x']),
      rec('prices', ['https://tripster.ru/a', 'https://kamchatkaland.ru/c']),
      rec('safety', ['https://41.mchs.gov.ru/']),
      rec('prices', ['https://ignored.ru/'], 'could_not_ask'),
    ], ['prices', 'tours_dates']);
    expect(ranked).toEqual([{ domain: 'kamchatkaland.ru', answers: 2 }, { domain: 'tripster.ru', answers: 1 }]);
  });
});

describe('таблица долей', () => {
  it('рядом с долей — попадания числом и по вопросам; неизмеренный назван с причиной', () => {
    const shares = shareByAssistant([ans('gpt', 'q1', 'vedarai.ru'), ans('gpt', 'q2', 'нет')], oursRule);
    const md = renderShareTable(shares, [{ assistant: 'yandexgpt', reason: 'нет ключа | и поиска' }]);
    const gpt = md.split('\n').find((l) => l.startsWith('| gpt'))!;
    expect(gpt).toContain('1 из 2');
    expect(gpt).toContain('50.0%');
    expect(md).toContain('| yandexgpt | не измерено: нет ключа \\| и поиска |');
  });

  it('ассистент с ответами не дублируется строкой «не измерено»', () => {
    const shares = shareByAssistant([ans('gpt', 'q1', 'нет')], oursRule);
    expect(renderShareTable(shares, [{ assistant: 'gpt', reason: 'x' }])).not.toContain('не измерено');
  });
});

describe('критерии записаны до замера', () => {
  it('документ критериев есть и называет все пять критериев словами владельца', () => {
    const doc = readFileSync('docs/agents/AI_VISIBILITY.md', 'utf-8');
    for (const k of ['К1', 'К2', 'К3', 'К4', 'К5']) expect(doc).toContain(`| ${k} |`);
    expect(doc).toContain('нижняя граница доли ответов с vedarai.ru выше базовой минимум в двух ассистентах');
    expect(doc).toContain('не смог проверить');
  });
});
