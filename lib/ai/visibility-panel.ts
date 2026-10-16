/**
 * Панель видимости Ведара в ИИ-ассистентах — счёт (замер владельца 16.10).
 *
 * Критерии записаны до первого прогона: docs/agents/AI_VISIBILITY.md. Здесь —
 * чистые функции, которыми их считают: что входит в набор вопросов, что в
 * ответе считается «ответом с vedarai.ru», доля с интервалом Уилсона по
 * ассистенту и вердикт «выросли / не выросли / не смог проверить».
 *
 * Вызовов моделей здесь нет: один и тот же счёт обязан работать и на базовом
 * замере, и на повторе через 8 недель, и на сохранённом сырье — иначе повтор
 * мерил бы другим правилом.
 */
import { createHash } from 'node:crypto';
import { wilsonInterval, type WilsonInterval } from '@/lib/agents/learning/experiment-tracker';

export const PANEL_INTENTS = ['planning', 'safety', 'tours_dates', 'prices'] as const;
export type PanelIntent = (typeof PANEL_INTENTS)[number];

/** Откуда вопрос. Вопрос без источника в набор не входит — его выдумал бы я. */
export const PANEL_SOURCES = ['wordstat', 'webmaster', 'gsc'] as const;
export type PanelSource = (typeof PANEL_SOURCES)[number];

export const PANEL_LANGS = ['ru', 'en', 'zh'] as const;
export type PanelLang = (typeof PANEL_LANGS)[number];

export interface PanelQuestion {
  id: string;
  text: string;
  lang: PanelLang;
  intent: PanelIntent;
  source: PanelSource;
}

export interface QuestionSet {
  questions: PanelQuestion[];
  rejected: Array<{ index: number; reason: string }>;
  /** Хэш принятого набора: повтор через 8 недель обязан идти по тому же. */
  sha256: string;
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** Разбор файла вопросов. Ничего не дополняет: негодный вопрос — в rejected с причиной. */
export function parseQuestions(raw: unknown): QuestionSet {
  const items = Array.isArray(raw) ? raw : [];
  const questions: PanelQuestion[] = [];
  const rejected: QuestionSet['rejected'] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const q = (item ?? {}) as Record<string, unknown>;
    const id = typeof q.id === 'string' ? q.id.trim() : '';
    const text = typeof q.text === 'string' ? q.text.trim() : '';
    if (!id) return rejected.push({ index, reason: 'нет id' });
    if (seen.has(id)) return rejected.push({ index, reason: `повтор id ${id}` });
    if (!text) return rejected.push({ index, reason: 'нет текста вопроса' });
    if (!isOneOf(PANEL_SOURCES, q.source)) return rejected.push({ index, reason: `источник не из ${PANEL_SOURCES.join('/')}` });
    if (!isOneOf(PANEL_INTENTS, q.intent)) return rejected.push({ index, reason: `намерение не из ${PANEL_INTENTS.join('/')}` });
    if (!isOneOf(PANEL_LANGS, q.lang)) return rejected.push({ index, reason: `язык не из ${PANEL_LANGS.join('/')}` });
    seen.add(id);
    questions.push({ id, text, lang: q.lang, intent: q.intent, source: q.source });
  });
  if (!Array.isArray(raw)) rejected.push({ index: -1, reason: 'файл вопросов — не массив' });
  const canonical = [...questions].sort((a, b) => a.id.localeCompare(b.id))
    .map((q) => [q.id, q.text, q.lang, q.intent, q.source]);
  const sha256 = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { questions, rejected, sha256 };
}

// ── Разметка ответа ─────────────────────────────────────────────────────

export const OUR_DOMAIN = 'vedarai.ru';

/** Домен по адресу или голому имени; null — не разобрать. */
export function hostOf(urlOrHost: string): string | null {
  const s = urlOrHost.trim().toLowerCase();
  if (!s) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname;
    return host.replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/** Домен d — это base или его поддомен. */
export const isDomainOf = (d: string, base: string): boolean => d === base || d.endsWith(`.${base}`);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Упоминание домена в тексте: «vedarai.ru», «https://vedarai.ru/…», «www.vedarai.ru», но не «notvedarai.ru». */
export function textMentionsDomain(text: string, domain: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}.-])(?:[a-z0-9-]+\\.)*${escapeRe(domain)}(?![\\p{L}\\p{N}-])`, 'iu');
  return re.test(text);
}

/** Имя без домена: «Ведар» во всех падежах, «Vedar», «维达尔». */
const BRAND = /(?<![\p{L}\p{N}])(?:ведар\p{L}{0,3}|vedar)(?![\p{L}\p{N}])|维达尔/iu;

export interface AnswerMarks {
  /** Засчитывается: домен в тексте или среди источников. */
  ours: boolean;
  ours_in_text: boolean;
  ours_in_sources: boolean;
  /** Имя есть, домена нет — сигнал, не засчитывается. */
  brand_only: boolean;
  /** Домены источников ответа, без повторов, в порядке появления. */
  cited: string[];
  /** Источники, адрес которых не разобрать, — считаются, а не выбрасываются молча. */
  unparsed_sources: number;
}

export function markAnswer(text: string, sourceUrls: readonly string[]): AnswerMarks {
  const cited: string[] = [];
  let unparsed = 0;
  for (const u of sourceUrls) {
    const h = hostOf(u);
    if (!h) { unparsed++; continue; }
    if (!cited.includes(h)) cited.push(h);
  }
  const inText = textMentionsDomain(text, OUR_DOMAIN);
  const inSources = cited.some((d) => isDomainOf(d, OUR_DOMAIN));
  const ours = inText || inSources;
  return {
    ours,
    ours_in_text: inText,
    ours_in_sources: inSources,
    brand_only: !ours && BRAND.test(text),
    cited,
    unparsed_sources: unparsed,
  };
}

/** Есть ли в ответе домен (конкурента): в тексте или в источниках. */
export function answerHasDomain(text: string, marks: Pick<AnswerMarks, 'cited'>, domain: string): boolean {
  return marks.cited.some((d) => isDomainOf(d, domain)) || textMentionsDomain(text, domain);
}

// ── Доли ────────────────────────────────────────────────────────────────

/**
 * Один ответ панели. `answered` — ассистент ответил; `could_not_ask` — вызов
 * не состоялся; `not_measured` — состоялся бы, но не тем способом (например,
 * поиск не вендора): такие в долю не входят ни числителем, ни знаменателем.
 */
export interface PanelAnswer {
  assistant: string;
  question_id: string;
  day: string;
  repeat: number;
  outcome: 'answered' | 'could_not_ask' | 'not_measured';
  text: string;
  marks: AnswerMarks | null;
}

export interface Share {
  assistant: string;
  /** Ответов в знаменателе. */
  answered: number;
  hits: number;
  share: number | null;
  ci: WilsonInterval | null;
  /** Тот же счёт по вопросам: вопрос «попал», если попал хотя бы один его ответ. */
  questions: number;
  questions_hit: number;
  questions_ci: WilsonInterval | null;
  could_not_ask: number;
  not_measured: number;
}

export type HitRule = (a: PanelAnswer & { marks: AnswerMarks }) => boolean;

export const oursRule: HitRule = (a) => a.marks.ours;
export const domainRule = (domain: string): HitRule => (a) => answerHasDomain(a.text, a.marks, domain);

export function shareByAssistant(answers: readonly PanelAnswer[], rule: HitRule): Share[] {
  const by = new Map<string, PanelAnswer[]>();
  for (const a of answers) {
    const list = by.get(a.assistant) ?? [];
    list.push(a);
    by.set(a.assistant, list);
  }
  return [...by.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([assistant, list]) => {
    const ok = list.filter((a): a is PanelAnswer & { marks: AnswerMarks } => a.outcome === 'answered' && a.marks !== null);
    const hits = ok.filter(rule).length;
    const perQuestion = new Map<string, boolean>();
    for (const a of ok) perQuestion.set(a.question_id, (perQuestion.get(a.question_id) ?? false) || rule(a));
    const qHit = [...perQuestion.values()].filter(Boolean).length;
    return {
      assistant,
      answered: ok.length,
      hits,
      share: ok.length ? hits / ok.length : null,
      ci: ok.length ? wilsonInterval(hits, ok.length) : null,
      questions: perQuestion.size,
      questions_hit: qHit,
      questions_ci: perQuestion.size ? wilsonInterval(qHit, perQuestion.size) : null,
      could_not_ask: list.filter((a) => a.outcome === 'could_not_ask').length,
      not_measured: list.filter((a) => a.outcome === 'not_measured').length,
    };
  });
}

// ── Вердикт ─────────────────────────────────────────────────────────────

export type Growth = 'grew' | 'not_grew' | 'unknown';

/**
 * К1 для одного ассистента: нижняя граница 95% Уилсона на повторе больше
 * точечной доли базы. Нет ответов в одном из замеров — «не смог проверить».
 */
export function growth(baseline: Share | undefined, followup: Share | undefined): Growth {
  if (!baseline || !followup || baseline.share === null || !followup.ci) return 'unknown';
  return followup.ci.low > baseline.share ? 'grew' : 'not_grew';
}

export interface Verdict {
  /** Ассистенты, где мы выросли, а ни один конкурент — нет. */
  counted: string[];
  /** Где выросли и мы, и конкурент: вырос весь поиск, а не мы. */
  struck: Array<{ assistant: string; competitors: string[] }>;
  unknown: string[];
  /** К1+К2: засчитано два ассистента или больше. */
  outcome: 'met' | 'not_met' | 'unknown';
}

export function verdict(
  ours: { baseline: Share[]; followup: Share[] },
  competitors: Record<string, { baseline: Share[]; followup: Share[] }>,
): Verdict {
  const assistants = [...new Set([...ours.baseline, ...ours.followup].map((s) => s.assistant))].sort();
  const find = (list: Share[], a: string) => list.find((s) => s.assistant === a);
  const counted: string[] = [];
  const struck: Verdict['struck'] = [];
  const unknown: string[] = [];
  for (const a of assistants) {
    const g = growth(find(ours.baseline, a), find(ours.followup, a));
    if (g === 'unknown') { unknown.push(a); continue; }
    if (g === 'not_grew') continue;
    const grewToo = Object.entries(competitors)
      .filter(([, c]) => growth(find(c.baseline, a), find(c.followup, a)) === 'grew')
      .map(([d]) => d);
    if (grewToo.length) struck.push({ assistant: a, competitors: grewToo });
    else counted.push(a);
  }
  const outcome = counted.length >= 2 ? 'met'
    : counted.length + unknown.length >= 2 ? 'unknown'
      : 'not_met';
  return { counted, struck, unknown, outcome };
}

// ── Карта источников ────────────────────────────────────────────────────

/**
 * Какие домены ассистенты цитируют: число ОТВЕТОВ, где домен есть среди
 * источников, по всем ассистентам вместе (правило выбора конкурентов в
 * docs/agents/AI_VISIBILITY.md). Наш домен в ранг не входит.
 */
export function rankCitedDomains(
  answers: ReadonlyArray<Pick<PanelAnswer, 'outcome' | 'marks'> & { intent?: string }>,
  intents?: readonly string[],
): Array<{ domain: string; answers: number }> {
  const counts = new Map<string, number>();
  for (const a of answers) {
    if (a.outcome !== 'answered' || !a.marks) continue;
    if (intents && (!a.intent || !intents.includes(a.intent))) continue;
    for (const d of new Set(a.marks.cited)) {
      if (isDomainOf(d, OUR_DOMAIN)) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([domain, n]) => ({ domain, answers: n }))
    .sort((x, y) => y.answers - x.answers || x.domain.localeCompare(y.domain));
}

// ── Отчёт ───────────────────────────────────────────────────────────────

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const ci = (c: WilsonInterval | null) => (c ? `${pct(c.low)}–${pct(c.high)}` : '—');
const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

/**
 * Таблица долей по ассистентам. Рядом с долей — попадания числом и тот же
 * счёт по вопросам: одно попадание должно быть видно как одно (свойство К1).
 * Неизмеренный ассистент называется строкой с причиной, а не пропадает.
 */
export function renderShareTable(
  shares: readonly Share[],
  notMeasured: ReadonlyArray<{ assistant: string; reason: string }> = [],
): string {
  const rows = shares.map((s) =>
    `| ${cell(s.assistant)} | ${s.hits} из ${s.answered} | ${pct(s.share)} | ${ci(s.ci)} | ${s.questions_hit} из ${s.questions} | ${s.could_not_ask} | ${s.not_measured} |`);
  const skipped = notMeasured
    .filter((n) => !shares.some((s) => s.assistant === n.assistant))
    .map((n) => `| ${cell(n.assistant)} | не измерено: ${cell(n.reason)} | | | | | |`);
  return [
    '| Ассистент | Попаданий | Доля | 95% Уилсон | Вопросов с попаданием | Не смог | Не измерено |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    ...skipped,
  ].join('\n');
}
