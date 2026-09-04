/**
 * Линза «ИИ-фичи для Ведара» — честная по построению.
 *
 * Владелец 03.09: «меня интересуют от разведчика именно ИИ-фичи для проекта».
 * Сторож держит контракт линзы (lib/agents/scout-ai-features):
 *
 *   - улика проверяется МАШИНОЙ: цитата дословно найдена в тексте той статьи,
 *     на которую предложение ссылается; иначе — отброшено с причиной;
 *   - адрес только из материалов дня, поверхность только из реестра;
 *   - материал без текста улики дать не может;
 *   - у прогона есть исход «не смог», отдельный от «идей нет»;
 *   - линза идёт в прогоне разведчика до ворот выпуска и её итог — в каждом
 *     возврате.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AI_FEATURE_SURFACES, AI_FEATURE_PROPOSALS_LIMIT, AI_FEATURE_CANDIDATES_LIMIT, AI_FEATURE_CRITIC_MIN_SCORE,
  buildAiFeaturePrompt, parseAiFeatureProposals, parseAiFeatureProposalsDetailed, groundProposals,
  formatAiFeaturesMessage, toTrackerRow, buildCriticPrompt, parseCriticVerdict,
  type AiFeatureCandidate, type AiFeatureProposal,
} from '@/lib/agents/scout-ai-features';

const DIGEST = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
const LENS = readFileSync(join(process.cwd(), 'lib/agents/scout-ai-features.ts'), 'utf-8');

const ARTICLE = 'OpenAI today introduced the Realtime API with speech-to-speech streaming, allowing developers to build low-latency voice agents. Pricing starts at $5 per million input tokens.';
const CANDS: AiFeatureCandidate[] = [
  { title: 'Realtime API', url: 'https://openai.com/index/realtime', source: 'OpenAI', text: ARTICLE },
  { title: 'Без текста', url: 'https://deepmind.google/blog/x', source: 'DeepMind', text: '' },
];

const proposal = (over: Partial<AiFeatureProposal> = {}): AiFeatureProposal => ({
  title: 'Голосовой Кузьмич в поле',
  surface: 'kuzmich',
  capability: 'speech-to-speech streaming, низкая задержка',
  why_now: 'в поле руки заняты',
  first_step: 'проба в lib/kuzmich: голосовой вход через Realtime API',
  user_value: 'турист в поле спрашивает Кузьмича голосом, не снимая перчаток',
  evidence_quote: 'speech-to-speech streaming, allowing developers to build low-latency voice agents',
  source_url: 'https://openai.com/index/realtime',
  ...over,
});

describe('проверка улик — детерминированная', () => {
  it('цитата дословно в тексте статьи — принято', () => {
    const { accepted, dropped } = groundProposals([proposal()], CANDS);
    expect(accepted).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it('пробелы, кавычки и регистр не мешают, перефраз — мешает', () => {
    const ok = groundProposals([proposal({ evidence_quote: 'Speech-To-Speech   streaming, allowing developers to build low-latency voice agents' })], CANDS);
    expect(ok.accepted).toHaveLength(1);
    const bad = groundProposals([proposal({ evidence_quote: 'потоковая речь в речь с низкой задержкой для голосовых агентов' })], CANDS);
    expect(bad.accepted).toHaveLength(0);
    expect(bad.dropped[0].reason).toMatch(/не найдена/);
  });

  it('короткая цитата ничего не доказывает', () => {
    const r = groundProposals([proposal({ evidence_quote: 'Realtime API' })], CANDS);
    expect(r.dropped[0].reason).toMatch(/короче 25/);
  });

  it('адрес не из материалов, чужая поверхность, материал без текста — свои причины', () => {
    const r = groundProposals([
      proposal({ source_url: 'https://example.com/other' }),
      proposal({ surface: 'marketing' as AiFeatureProposal['surface'] }),
      proposal({ source_url: 'https://deepmind.google/blog/x' }),
    ], CANDS);
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped.map((d) => d.reason)).toEqual([
      'адрес не из материалов дня',
      'поверхность не из реестра: marketing',
      'у материала нет текста — улику не проверить',
    ]);
  });
});

describe('разбор ответа модели', () => {
  it('json в заборе разбирается, неполные элементы выбрасываются, лимит держится', () => {
    const raw = '```json\n' + JSON.stringify([
      proposal(), proposal({ title: 'Вторая фича' }), proposal({ title: 'Третья фича' }), proposal({ title: 'Четвёртая фича' }),
      { title: 'без полей' },
    ]) + '\n```';
    const out = parseAiFeatureProposals(raw);
    expect(out).toHaveLength(AI_FEATURE_PROPOSALS_LIMIT);
    expect(out.every((p) => p.evidence_quote && p.source_url)).toBe(true);
  });

  it('пустой массив и мусор — пусто, без исключений', () => {
    expect(parseAiFeatureProposals('[]')).toEqual([]);
    expect(parseAiFeatureProposals('Ничего применимого')).toEqual([]);
    expect(parseAiFeatureProposals(null)).toEqual([]);
  });

  /**
   * 04.09, run 5: линза записала «model_empty» при десяти материалах с
   * текстом, и по этому слову нельзя было сказать, отказалась модель или мы
   * не прочитали её ответ. Лечение у этих бед разное, значит и слова разные.
   */
  it('пустой список — не то же, что непрочитанный ответ: четыре вердикта', () => {
    expect(parseAiFeatureProposalsDetailed('[]')).toMatchObject({ verdict: 'declined' });
    expect(parseAiFeatureProposalsDetailed('[]').detail).toMatch(/предлагать нечего/);

    const noArray = parseAiFeatureProposalsDetailed('Сегодня ничего применимого не нашёл.');
    expect(noArray.verdict).toBe('unreadable');
    expect(noArray.detail).toMatch(/массива JSON в ответе нет/);
    expect(noArray.detail).toMatch(/Сегодня ничего применимого/);

    const broken = parseAiFeatureProposalsDetailed('[{"title": "Обрыв"');
    expect(broken.verdict).toBe('unreadable');
    expect(parseAiFeatureProposalsDetailed(null).verdict).toBe('unreadable');

    const { user_value: _v, ...noValue } = proposal();
    void _v;
    const partial = parseAiFeatureProposalsDetailed(JSON.stringify([noValue]));
    expect(partial.verdict).toBe('incomplete');
    expect(partial.detail).toMatch(/элементов 1, ни одного полного/);
    expect(partial.detail).toMatch(/нет полей: user_value/);

    expect(parseAiFeatureProposalsDetailed(JSON.stringify([proposal()])))
      .toMatchObject({ verdict: 'proposals', detail: '' });
  });

  it('без user_value предложение не проходит: «для кого» обязательно', () => {
    const { user_value: _dropped, ...noValue } = proposal();
    void _dropped;
    expect(parseAiFeatureProposals(JSON.stringify([noValue]))).toEqual([]);
  });
});

/**
 * Критик появился после первой заметки 03.09 («там мусор был»): проверка
 * улик ловит выдуманную цитату, но не бесполезное предложение с настоящей.
 * Критик закрыт по умолчанию — в отличие от критика Scout-Innovator, который
 * fail-open и никогда не обнуляет выдачу. Заметка владельцу — не поток задач.
 */
describe('критик — закрыт по умолчанию', () => {
  it('одобрение только явное, с оценкой не ниже планки', () => {
    expect(parseCriticVerdict(`{"score": ${AI_FEATURE_CRITIC_MIN_SCORE}, "reason": "конкретно и ново"}`).approved).toBe(true);
    expect(parseCriticVerdict(`{"score": ${AI_FEATURE_CRITIC_MIN_SCORE - 1}, "reason": "общее место"}`).approved).toBe(false);
    expect(parseCriticVerdict('{"score": 3, "reason": "пересказ новости"}')).toEqual({ approved: false, score: 3, reason: 'пересказ новости' });
  });

  it('молчание, не-JSON и JSON без оценки — не одобрено, с названной причиной', () => {
    expect(parseCriticVerdict(null)).toMatchObject({ approved: false, score: null });
    expect(parseCriticVerdict('Отличная идея, одобряю')).toMatchObject({ approved: false, score: null });
    expect(parseCriticVerdict('{"approved": true}')).toMatchObject({ approved: false, score: null });
    expect(parseCriticVerdict('{"score": "9"}')).toMatchObject({ approved: false, score: null });
  });

  it('критику показывают всё предложение целиком и правило «уже есть»', () => {
    const [sys, user] = buildCriticPrompt(proposal());
    expect(sys.content).toMatch(/уже есть/);
    expect(sys.content).toMatch(/4 ГБ RAM/);
    expect(user.content).toMatch(/Для кого и что меняет: турист в поле/);
    expect(user.content).toMatch(/Цитата-улика/);
  });

  it('прогон называет исход ответа модели тремя словами и модель-ответчика', () => {
    // Один код на «отказалась» и «не прочитали» — это §4.0 на своём же коде.
    expect(LENS).not.toMatch(/'model_empty'/);
    expect(LENS).toMatch(/declined: {3}'model_declined'/);
    expect(LENS).toMatch(/unreadable: 'model_unreadable'/);
    expect(LENS).toMatch(/incomplete: 'model_incomplete'/);
    expect(LENS).toMatch(/parse_detail: parsed\.detail/);
    // Кто ответил — тоже факт прогона: с 04.09 живой провайдер один.
    expect(LENS).toMatch(/base\.decision_model = decision\.model \?\? null/);
  });

  it('в прогоне: без одобрения ничего не уходит, молчание критика — свой код', () => {
    expect(LENS).toMatch(/const verdict = parseCriticVerdict\(verdictRaw\)/);
    expect(LENS).toMatch(/'critic_unavailable' : 'critic_rejected_all'/);
    expect(LENS).toMatch(/formatAiFeaturesMessage\(approved, dateKey\)/);
    // Окно шире шести: WeatherNext 3 стоял восьмым и до модели не дошёл.
    expect(AI_FEATURE_CANDIDATES_LIMIT).toBeGreaterThanOrEqual(12);
    // В промпт — только материалы с текстом.
    expect(LENS).toMatch(/const candidates = fetched\.filter\(\(c\) => c\.text\)/);
  });
});

describe('промпт', () => {
  it('материал без текста помечен так, чтобы модель по нему не предлагала', () => {
    const [sys, user] = buildAiFeaturePrompt(CANDS, ['local_llm']);
    expect(sys.content).toMatch(/evidence_quote/);
    expect(sys.content).toMatch(/пустой массив/i);
    expect(user.content).toMatch(/текст статьи не добыт/);
    expect(user.content).toMatch(/local_llm/);
    for (const s of AI_FEATURE_SURFACES) expect(sys.content).toContain(s);
  });
});

describe('выход', () => {
  it('сообщение владельцу называет поверхность, шаг, цитату и источник', () => {
    const msg = formatAiFeaturesMessage([proposal()], '2026-09-03');
    expect(msg).toMatch(/ИИ-фичи для Ведара · 2026-09-03/);
    expect(msg).toMatch(/Кузьмич/);
    expect(msg).toMatch(/Первый шаг:/);
    expect(msg).toMatch(/Для кого: турист в поле/);
    expect(msg).toMatch(/speech-to-speech streaming/);
    expect(msg).toMatch(/href="https:\/\/openai\.com\/index\/realtime"/);
    // Честная подпись: проверена цитата, а не применимость.
    expect(msg).toMatch(/применимость — ваше решение/);
  });

  it('строка трекера несёт поверхность, цитату и адрес', () => {
    const row = toTrackerRow(proposal());
    expect(row.title).toMatch(/^ИИ-фича · Кузьмич: /);
    expect(row.description).toMatch(/\[kuzmich\]/);
    expect(row.description).toMatch(/Источник: https:\/\/openai\.com/);
    expect(row.suggestion).toMatch(/Realtime API/);
  });
});

describe('подключение к разведчику', () => {
  it('линза идёт до ворот выпуска и её итог — в каждом возврате (через health)', () => {
    expect(DIGEST).toMatch(/ai_features: await runAiFeatureLens\(/);
    expect(DIGEST).toMatch(/interleaveBySource\(allItems\.filter\(i => AI_LABELS\.has\(i\.source\)\)\)/);
    // health уезжает в каждый возврат прогона, значит и ai_features тоже.
    expect(DIGEST).toMatch(/ai_features\?: AiFeaturesResult;/);
  });
});
