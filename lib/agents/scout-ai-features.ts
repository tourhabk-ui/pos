/**
 * lib/agents/scout-ai-features.ts — линза «ИИ-фичи для Ведара».
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Владелец 03.09: «меня интересуют от разведчика именно ИИ-фичи для
 * проекта». До этого дня разведка кормила две вещи: выпуск в канал (новости)
 * и мост «дайджест → находки эволюции» (lib/agents/evo/intel-bridge), который
 * просит «возможности для платформы» вообще. Его последние находки —
 * «календарь событий» и «гостевой опыт в бронировании» — владелец закрыл как
 * not_planned: это не ИИ и не то, что он ждал.
 *
 * Здесь — узкая линза: из ИИ-материалов дня (теперь с первоисточниками
 * OpenAI/Google/DeepMind и текстом статей через реле) достать КОНКРЕТНУЮ
 * ИИ-возможность и привязать её к поверхности Ведара — Кузьмичу, safety,
 * планеру, офлайн-карте, операторам, контенту, разведке.
 *
 * ── Честность (§4.0) ───────────────────────────────────────────────────────
 *
 *   - улика обязательна и ДЕТЕРМИНИРОВАННО проверяется: цитата из ответа
 *     модели должна дословно найтись в тексте той статьи, на которую она
 *     ссылается. Модель пересказывает — цитата не нашлась — предложение
 *     выбрасывается с названной причиной. Судья-модель здесь не нужен;
 *   - у прогона есть исход «не смог»: решатель промолчал, статьи не
 *     прочитались, кандидатов нет — всё это разные коды, не «идей нет»;
 *   - предложения уходят владельцу в Telegram напрямую, а не только в
 *     трекер: находки категории intel — «догадки модели» для тормоза точности
 *     (lib/agents/evo/precision.ts), и при просевшей точности они ждут
 *     неделями. Тормоз защищает трекер от шума код-догадок; заметка человеку
 *     с проверенной цитатой — другой класс, и она его не обходит, а идёт
 *     мимо. В трекер запись тоже кладётся — той же дорогой, что у моста,
 *     с тем же дедупом по теме.
 */

import { pool } from '@/lib/db-pool';
import { salvageTruncatedArray } from '@/lib/ai/json-salvage';
import { callAIDecision, callAIDecisionDetailed } from '@/lib/ai/providers';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { intelSignature } from '@/lib/agents/evo/claim-signature';
import { scrubInjectionLines } from '@/lib/agents/evo/memory-guard';
import type { ChatMessage } from '@/lib/ai/prompts';
import { repairTelegramHtml, TELEGRAM_TEXT_LIMIT } from '@/lib/notifications/telegram-html';

/** Поверхности Ведара, к которым привязывается ИИ-возможность. */
export const AI_FEATURE_SURFACES = [
  'kuzmich',     // чат-помощник: инструменты, память, голос, каналы
  'safety',      // SOS-детектор, тревоги, сейсмо, погода
  'planner',     // планер поездки, подбор маршрутов/туров
  'offline_map', // офлайн-карта, PWA, навигация в поле
  'operators',   // кабинет оператора, брони, платежи, документы
  'content',     // описания мест/туров, канал, фото, SEO
  'intel',       // сама разведка и эволюция: сканеры, судьи, агенты
] as const;
export type AiFeatureSurface = typeof AI_FEATURE_SURFACES[number];

const SURFACE_LABEL: Record<AiFeatureSurface, string> = {
  kuzmich: 'Кузьмич',
  safety: 'Безопасность',
  planner: 'Планер',
  offline_map: 'Офлайн-карта',
  operators: 'Операторы',
  content: 'Контент',
  intel: 'Разведка и эволюция',
};

/** Материал дня: заголовок, адрес, источник и добытый текст статьи. */
export interface AiFeatureCandidate {
  title: string;
  url: string;
  source: string;
  /** Текст статьи; пустая строка — текст не добыт (только заголовок). */
  text: string;
}

export interface AiFeatureProposal {
  title: string;
  surface: AiFeatureSurface;
  /** Что именно появилось во внешнем мире — по тексту статьи. */
  capability: string;
  why_now: string;
  /** Первый шаг на платформе: файл/эндпоинт/эксперимент. */
  first_step: string;
  /** Что изменится для туриста или оператора — одной фразой, по делу. */
  user_value: string;
  /** Дословная цитата из статьи — улика, проверяется подстрокой. */
  evidence_quote: string;
  source_url: string;
}

export interface AiFeaturesResult {
  /** Сколько материалов ушло модели и у скольких был текст статьи. */
  candidates: number;
  with_text: number;
  /** Сколько вернула модель до проверки улик. */
  proposed: number;
  /** Прошли проверку улики. */
  grounded: number;
  /** Не прошли: цитата не нашлась, адрес не из списка, поверхность чужая. */
  dropped: Array<{ title: string; reason: string }>;
  /** Отсеяны как повтор темы (трекер) или адреса (память линзы). */
  dedup_skipped: number;
  /**
   * Отклонены критиком (03.09, после первой заметки: «там мусор был»).
   * Проверка улик ловит выдуманную цитату, но не ловит бесполезное
   * предложение с настоящей цитатой. Критик судит пользу и конкретность и
   * закрыт по умолчанию: не ответил — ничего не уходит.
   */
  critic_rejected: Array<{ title: string; reason: string }>;
  /** Записано в evo_growth_issues. */
  stored: number;
  /** Ушло владельцу в Telegram. */
  sent: boolean;
  /**
   * Почему прогон не дал предложений — только когда grounded === 0.
   *
   * Про ответ модели исходов ТРИ, а не один (04.09, run 5): model_declined —
   * модель вернула пустой массив, то есть честно сказала «предлагать нечего»;
   * model_unreadable — ответ пришёл, а мы его не прочитали (не JSON, битый
   * JSON, не массив); model_incomplete — элементы есть, но ни один не несёт
   * обязательных полей. Первое лечить нечем, второе и третье чинятся
   * промптом. Прежний общий `model_empty` склеивал их и на вопрос «что
   * случилось» отвечал «что-то».
   */
  skip_reason?: 'no_candidates' | 'no_text' | 'model_declined' | 'model_unreadable' | 'model_incomplete'
    | 'decision_null' | 'all_ungrounded' | 'all_duplicates'
    | 'critic_rejected_all' | 'critic_unavailable' | 'error';
  /** Какая модель ответила решателем; null — не ответил никто. */
  decision_model?: string | null;
  /**
   * Сколько запретов и сколько знаков ушло модели в промпт.
   *
   * 04.09, run 6: DeepSeek прочитал 10 статей и ОСОЗНАННО вернул пустой
   * список (model_declined). У такого отказа два правдоподобных объяснения, и
   * различать их догадками нельзя: либо в материалах правда нет фичи для нас,
   * либо список «эти темы уже были, не предлагай их ни в какой формулировке»
   * разросся до размера, при котором осторожная модель отказывает по любому
   * поводу. Первое лечить не надо, второе — надо. Числа отвечают на это без
   * спора.
   */
  known_topics?: number;
  prompt_chars?: number;
  /** Чем плох ответ модели — при model_unreadable / model_incomplete. */
  parse_detail?: string;
  /**
   * Почему решатель промолчал — по ступеням (timeweb/flagship/anthropic/
   * deepseek…), только при decision_null. Run 4 (04.09) записал одно слово
   * «decision_null», и что именно легло — гео-блок, баланс, пустое тело —
   * пришлось добывать отдельным прогоном ai-debug.
   */
  decision_detail?: string;
  duration_ms: number;
}

/**
 * Материалов за прогон. Было 6 — по одному от первых шести источников после
 * чередования, и WeatherNext 3 от DeepMind (лучший кандидат 03.09) стоял
 * восьмым и до модели не дошёл. Теперь окно шире, а в промпт идут только
 * материалы с добытым текстом: без текста улику не проверить, и модель по
 * такому материалу всё равно предлагать не должна.
 */
export const AI_FEATURE_CANDIDATES_LIMIT = 12;
/** Планка критика: ниже — не отправляется. Молчание дешевле мусора. */
export const AI_FEATURE_CRITIC_MIN_SCORE = 8;
/** Предложений за прогон. */
export const AI_FEATURE_PROPOSALS_LIMIT = 3;
/** Текста статьи на материал в промпте. */
const TEXT_PER_CANDIDATE = 3000;
/** Короткая цитата ничего не доказывает: "AI" найдётся в любой статье. */
const EVIDENCE_MIN_CHARS = 25;
const SEEN_TTL_DAYS = 45;

const SYSTEM_PROMPT = `Ты — техлид туристической платформы Ведар (Камчатка). Главная цель платформы — безопасность туриста в дикой природе; работает офлайн (карта, SOS, маршруты). Поверхности, куда можно применить ИИ:
- kuzmich — чат-помощник Кузьмич (Telegram/MAX/web): инструменты, память, голос, ответы про безопасность из БД;
- safety — SOS-детектор, тревоги (сейсмика, вулканы, погода, дороги), уведомления;
- planner — планер поездки, подбор маршрутов и туров, погода и занятость;
- offline_map — офлайн-карта и навигация в поле (PWA, треки, рельеф);
- operators — кабинет оператора: брони, документы, описания, платежи;
- content — описания мест и туров, канал, фото, SEO;
- intel — сама разведка и эволюция кода: сканеры, судьи, агенты.

Тебе дают материалы дня из ИИ-источников с текстом статей. Найди в них КОНКРЕТНЫЕ ИИ-возможности (новая модель, API, техника, инструмент, приём), которые Ведар может применить на одной из поверхностей. Строго:
- capability — что именно появилось, ПО ТЕКСТУ статьи, без переноса цифр из других материалов;
- evidence_quote — ДОСЛОВНАЯ цитата из текста этой статьи (25-200 символов), которая подтверждает capability. Цитата проверяется машиной подстрокой: перефраз или перевод не пройдёт;
- source_url — адрес материала из списка, ровно как дан;
- first_step — первый шаг на платформе: что попробовать, где (эндпоинт, модуль, эксперимент), за один-два дня;
- user_value — что изменится для туриста в поле или оператора, одной фразой и по делу («турист видит окно погоды по своей точке трека на ближайший час», а не «повысит качество сервиса»);
- не предлагай общие вещи («внедрить ИИ-чат», «улучшить рекомендации», «использовать энкодер для поиска») и не предлагай то, что уже есть (Кузьмич есть, планер есть, SOS есть, RAG по местам есть) — только новую возможность, которая меняет что-то для человека на Камчатке;
- лучше ноль предложений, чем натянутое: если материал про модель или API, а связи с турами, безопасностью, маршрутами или полевой работой нет — не предлагай;
- если в материалах нет ничего применимого — верни пустой массив. Пустой ответ лучше выдуманного.

Верни СТРОГО JSON-массив без markdown, максимум ${AI_FEATURE_PROPOSALS_LIMIT} элемента:
[{"title":"ИИ-фича ≤8 слов","surface":"kuzmich|safety|planner|offline_map|operators|content|intel","capability":"...","why_now":"...","first_step":"...","user_value":"...","evidence_quote":"...","source_url":"..."}]`;

/**
 * Критик — вторая пара глаз с планкой. В отличие от критика Scout-Innovator
 * (fail-open: гейт не обнуляет выдачу) этот закрыт по умолчанию: не ответил
 * или ответил не тем — предложение не уходит. Заметка владельцу — не поток
 * задач, её цена в доверии, и первая же заметка 03.09 была мусором.
 */
const CRITIC_PROMPT = `Ты — владелец туристической платформы Ведар (Камчатка): безопасность туриста в дикой природе, офлайн-карта, SOS, маршруты, Кузьмич-помощник, кабинет оператора. Тебе принесли предложение ИИ-фичи, извлечённое из статьи. Оцени его СТРОГО, как человек, которому это делать своими руками и на свои деньги.

Ставь оценку 0-10 по совокупности:
- это конкретная ИИ-возможность (модель, API, техника, инструмент), а не общее место вроде «внедрить ИИ» или «улучшить поиск»;
- её ещё нет в Ведаре (Кузьмич, планер, SOS, тревоги, офлайн-карта, RAG по местам — уже есть);
- она меняет что-то для туриста в поле или оператора, и это названо конкретно;
- первый шаг реален за день-два и не требует железа, которого нет (4 ГБ RAM на всё приложение, локальные модели 7B+ не запускаются);
- ты бы взялся за это в ближайший месяц.

Общие места, пересказ новости без применения, «можно использовать для документов/поиска/рекомендаций» без привязки к Камчатке — 0-4. Верни ТОЛЬКО JSON: {"score": 0-10, "reason": "одна фраза почему"}`;

export interface CriticVerdict {
  approved: boolean;
  score: number | null;
  reason: string;
}

export function buildCriticPrompt(p: AiFeatureProposal): ChatMessage[] {
  return [
    { role: 'system', content: CRITIC_PROMPT },
    {
      role: 'user',
      content: `Предложение:\nЗаголовок: ${p.title}\nПоверхность: ${p.surface}\nЧто появилось: ${p.capability}\nПочему сейчас: ${p.why_now}\nПервый шаг: ${p.first_step}\nДля кого и что меняет: ${p.user_value}\nЦитата-улика: «${p.evidence_quote}»\nИсточник: ${p.source_url}`,
    },
  ];
}

/**
 * Разбор вердикта. Закрыто по умолчанию: нет JSON, нет числа, число ниже
 * планки — не одобрено. Одобрение только явное и только с оценкой.
 */
export function parseCriticVerdict(raw: string | null, minScore = AI_FEATURE_CRITIC_MIN_SCORE): CriticVerdict {
  if (!raw) return { approved: false, score: null, reason: 'критик не ответил' };
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return { approved: false, score: null, reason: 'критик ответил не JSON' };
  try {
    const o = JSON.parse(m[0]) as { score?: unknown; reason?: unknown };
    const score = typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : null;
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (score === null) return { approved: false, score: null, reason: reason || 'критик не поставил оценку' };
    return { approved: score >= minScore, score, reason };
  } catch {
    return { approved: false, score: null, reason: 'критик ответил неразбираемым JSON' };
  }
}

/** Сообщения решателю. Чистая — под тестом. */
export function buildAiFeaturePrompt(candidates: AiFeatureCandidate[], knownTopics: string[]): ChatMessage[] {
  const materials = candidates.map((c, i) => {
    const text = c.text
      ? scrubInjectionLines(c.text).slice(0, TEXT_PER_CANDIDATE)
      : '(текст статьи не добыт — только заголовок; без цитаты из текста предлагать по нему нельзя)';
    return `[${i + 1}] ${c.source}: ${c.title}\nURL: ${c.url}\nТЕКСТ:\n${text}`;
  }).join('\n\n---\n\n');
  const known = knownTopics.length > 0
    ? `Темы, по которым уже есть находка или вердикт владельца — не предлагай их снова ни в какой формулировке: ${knownTopics.join(', ')}.\n\n`
    : '';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${known}Материалы дня:\n\n${materials}` },
  ];
}

/**
 * Исход разбора ответа модели. Четыре, а не два.
 *
 * Повод — прогон 04.09 (run 5): линза записала `model_empty` при 10 материалах
 * с текстом, и по этому слову НЕЛЬЗЯ сказать, что произошло. «Модель честно
 * ответила: сегодня предлагать нечего» и «ответ пришёл, а мы его не прочитали»
 * — разные беды с разным лечением: первую лечить нечем и не надо, вторая
 * чинится промптом или разбором. Прежний комментарий к полю сам признавался,
 * что склеивает их: «модель вернула пустой массив ИЛИ неразбираемый ответ».
 * Это §4.0 на своём же коде: место, где нельзя сказать «не знаю».
 */
export type ProposalParseVerdict = 'proposals' | 'declined' | 'unreadable' | 'incomplete';

export interface ProposalParseResult {
  proposals: AiFeatureProposal[];
  verdict: ProposalParseVerdict;
  /** Чем именно плох ответ; для 'proposals' — пусто. */
  detail: string;
}

/** Поля, без которых предложение не предложение. */
const REQUIRED_FIELDS: Array<keyof AiFeatureProposal> = [
  'capability', 'first_step', 'user_value', 'evidence_quote', 'source_url',
];

/** Первые знаки ответа — чтобы «не прочитали» можно было проверить глазами. */
function answerPreview(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Разбор ответа модели с вердиктом. Терпим к json-обёртке; поля обязательны. */
export function parseAiFeatureProposalsDetailed(raw: string | null): ProposalParseResult {
  const nothing = (verdict: ProposalParseVerdict, detail: string): ProposalParseResult =>
    ({ proposals: [], verdict, detail });
  if (!raw || !raw.trim()) return nothing('unreadable', 'ответ пуст');

  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');

  /**
   * Оборванный ответ — не «массива нет».
   *
   * Прогон 06.09: Opus 5 ответила `[{"title":"Торговый агент оператора…`, и
   * ответ обрезало на потолке токенов посреди слова. Закрывающей скобки нет,
   * и код записал «массива JSON в ответе нет» — притом что массив был, и
   * целые предложения в нём тоже. Правило спасения в репозитории уже жило
   * (изобретатель, 05.09), но у линзы к нему доступа не было.
   *
   * Спасённые предложения — не полноценный ответ: вердикт `incomplete`
   * говорит, что модель не договорила, а не что ей нечего сказать.
   */
  const salvage = (why: string): ProposalParseResult | null => {
    if (start === -1) return null;
    const whole = salvageTruncatedArray(cleaned.slice(start));
    if (whole.length === 0) return null;
    return { ...buildProposals(whole), verdict: 'incomplete', detail: `ответ оборван (${why}), спасено целых: ${whole.length}` };
  };

  if (start === -1 || end === -1 || end <= start) {
    return salvage('нет закрывающей скобки')
      ?? nothing('unreadable', `массива JSON в ответе нет: «${answerPreview(cleaned)}»`);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    const why = (e as Error).message.slice(0, 60);
    const saved = salvage(why);
    if (saved) return saved;
    return nothing('unreadable', `JSON не разобрался (${why}): «${answerPreview(cleaned)}»`);
  }
  if (!Array.isArray(arr)) return nothing('unreadable', `на месте массива ${typeof arr}`);
  if (arr.length === 0) return nothing('declined', 'модель вернула пустой массив: предлагать нечего');

  return buildProposals(arr);
}

/**
 * Элементы массива → предложения. Общая для обычного разбора и для спасения
 * оборванного ответа: требования к полноте предложения не должны зависеть от
 * того, договорила модель или нет.
 */
function buildProposals(arr: unknown[]): ProposalParseResult {
  const nothing = (verdict: ProposalParseVerdict, detail: string): ProposalParseResult =>
    ({ proposals: [], verdict, detail });
  const out: AiFeatureProposal[] = [];
  const gaps: string[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') { gaps.push('элемент не объект'); continue; }
    const o = item as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const p: AiFeatureProposal = {
      title: str('title'),
      surface: str('surface') as AiFeatureSurface,
      capability: str('capability'),
      why_now: str('why_now'),
      first_step: str('first_step'),
      user_value: str('user_value'),
      evidence_quote: str('evidence_quote'),
      source_url: str('source_url'),
    };
    if (p.title.length < 4 || p.title.length > 180) { gaps.push('название пустое или длиннее 180'); continue; }
    const missing = REQUIRED_FIELDS.filter((f) => !p[f]);
    if (missing.length > 0) { gaps.push(`нет полей: ${missing.join(', ')}`); continue; }
    out.push(p);
  }
  if (out.length === 0) {
    return nothing('incomplete', `элементов ${arr.length}, ни одного полного: ${[...new Set(gaps)].join('; ').slice(0, 200)}`);
  }
  return { proposals: out.slice(0, AI_FEATURE_PROPOSALS_LIMIT), verdict: 'proposals', detail: '' };
}

/** Разбор без вердикта: удобно там, где важен только список. */
export function parseAiFeatureProposals(raw: string | null): AiFeatureProposal[] {
  return parseAiFeatureProposalsDetailed(raw).proposals;
}

/** Нормализация для сравнения цитаты с текстом: пробелы, кавычки, регистр. */
function normalizeForMatch(s: string): string {
  return s
    .replace(/[«»"“”„]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Детерминированная проверка улик. Три условия, каждое — своя причина:
 * адрес из списка материалов; поверхность из реестра; цитата дословно есть в
 * тексте ЭТОЙ статьи. Материал без текста улики дать не может.
 */
export function groundProposals(
  proposals: AiFeatureProposal[],
  candidates: AiFeatureCandidate[],
): { accepted: AiFeatureProposal[]; dropped: Array<{ title: string; reason: string }> } {
  const byUrl = new Map(candidates.map((c) => [c.url, c]));
  const accepted: AiFeatureProposal[] = [];
  const dropped: Array<{ title: string; reason: string }> = [];
  for (const p of proposals) {
    const cand = byUrl.get(p.source_url);
    if (!cand) { dropped.push({ title: p.title, reason: 'адрес не из материалов дня' }); continue; }
    if (!(AI_FEATURE_SURFACES as readonly string[]).includes(p.surface)) {
      dropped.push({ title: p.title, reason: `поверхность не из реестра: ${p.surface}` }); continue;
    }
    if (!cand.text) { dropped.push({ title: p.title, reason: 'у материала нет текста — улику не проверить' }); continue; }
    const quote = normalizeForMatch(p.evidence_quote);
    if (quote.length < EVIDENCE_MIN_CHARS) { dropped.push({ title: p.title, reason: 'цитата короче 25 символов' }); continue; }
    if (!normalizeForMatch(cand.text).includes(quote)) {
      dropped.push({ title: p.title, reason: 'цитата не найдена в тексте статьи' }); continue;
    }
    accepted.push(p);
  }
  return { accepted, dropped };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Сообщение владельцу. Чистая — под тестом. */
export function formatAiFeaturesMessage(proposals: AiFeatureProposal[], dateKey: string): string {
  const lines = [`<b>ИИ-фичи для Ведара · ${esc(dateKey)}</b>`, ''];
  proposals.forEach((p, i) => {
    lines.push(`${i + 1}. <b>${esc(p.title)}</b> — ${esc(SURFACE_LABEL[p.surface])}`);
    lines.push(`Что появилось: ${esc(p.capability)}`);
    lines.push(`Почему сейчас: ${esc(p.why_now)}`);
    lines.push(`Для кого: ${esc(p.user_value)}`);
    lines.push(`Первый шаг: ${esc(p.first_step)}`);
    lines.push(`<i>«${esc(p.evidence_quote)}»</i>`);
    lines.push(`<a href="${esc(p.source_url)}">Источник</a>`);
    lines.push('');
  });
  lines.push('<i>Цитаты проверены по тексту статей машиной; применимость — ваше решение.</i>');
  return lines.join('\n');
}

/** Заголовок и тело для трекера — той же формы, что у моста разведки. */
export function toTrackerRow(p: AiFeatureProposal): { title: string; description: string; suggestion: string } {
  return {
    title: `ИИ-фича · ${SURFACE_LABEL[p.surface]}: ${p.title}`.slice(0, 180),
    description: `[${p.surface}] ${p.capability}\nДля кого: ${p.user_value}\nПочему сейчас: ${p.why_now}\nЦитата: «${p.evidence_quote}»\nИсточник: ${p.source_url}`.slice(0, 2000),
    suggestion: p.first_step.slice(0, 2000),
  };
}

async function sendToOwner(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: repairTelegramHtml(text, TELEGRAM_TEXT_LIMIT),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * Прогон линзы. `fetchText` — добытчик текста статьи (разведчик уже умеет
 * читать статьи, в том числе через реле); сеть — его, не этого модуля.
 */
export async function runAiFeatureLens(
  items: Array<{ title: string; url: string; source: string }>,
  fetchText: (url: string) => Promise<string>,
  opts: { dateKey?: string } = {},
): Promise<AiFeaturesResult> {
  const startedAt = Date.now();
  const base = {
    candidates: 0, with_text: 0, proposed: 0, grounded: 0,
    dropped: [] as Array<{ title: string; reason: string }>,
    dedup_skipped: 0,
    critic_rejected: [] as Array<{ title: string; reason: string }>,
    stored: 0, sent: false,
    // Кто ответил решателем. С 04.09 живой провайдер один (DeepSeek), и по
    // этому полю видно, он ли ответил или ступень выше внезапно ожила.
    decision_model: null as string | null,
    known_topics: 0,
    prompt_chars: 0,
  };
  const done = (extra: Partial<AiFeaturesResult>): AiFeaturesResult => ({ ...base, ...extra, duration_ms: Date.now() - startedAt });

  try {
    // Адреса, по которым линза уже предлагала (память на SEEN_TTL_DAYS):
    // та же статья завтра — та же идея, слот уходит новому.
    const recalled = await agentMemory.recall('scout-digest', 'ai_features_seen', 1).catch(() => []);
    const seen = new Set<string>(((recalled[0]?.value as { urls?: string[] } | undefined)?.urls) ?? []);

    const picked = items.filter((i) => i.url && !seen.has(i.url)).slice(0, AI_FEATURE_CANDIDATES_LIMIT);
    if (picked.length === 0) return done({ skip_reason: 'no_candidates' });

    const fetched: AiFeatureCandidate[] = await Promise.all(
      picked.map(async (i) => ({ title: i.title, url: i.url, source: i.source, text: await fetchText(i.url).catch(() => '') })),
    );
    base.candidates = fetched.length;
    // В промпт — только материалы с текстом: без текста улику не проверить,
    // а место в промпте не бесплатное.
    const candidates = fetched.filter((c) => c.text);
    base.with_text = candidates.length;
    if (candidates.length === 0) return done({ skip_reason: 'no_text' });

    const { rows: prior } = await pool.query<{ title: string; description: string | null; suggestion: string | null }>(
      `SELECT title, description, suggestion FROM evo_growth_issues WHERE category = 'intel'`,
    ).catch(() => ({ rows: [] as Array<{ title: string; description: string | null; suggestion: string | null }> }));
    const known = new Set(prior.map((r) => intelSignature(r)));
    const knownTopics = [...new Set(
      prior.map((r) => intelSignature(r)).filter((s) => !s.startsWith('intel::other:')).map((s) => s.replace('intel::', '')),
    )];

    // Считаем то, что РЕАЛЬНО ушло модели: тот же объект, а не его копия.
    const prompt = buildAiFeaturePrompt(candidates, knownTopics);
    base.known_topics = knownTopics.length;
    base.prompt_chars = prompt.reduce((n, m) => n + m.content.length, 0);

    const decision = await callAIDecisionDetailed(prompt)
      .catch((e: unknown) => ({ text: null, model: null, error: e instanceof Error ? e.message : String(e) }));
    const raw = decision.text;
    if (raw === null) return done({ skip_reason: 'decision_null', decision_detail: decision.error ?? 'причина не записана' });

    base.decision_model = decision.model ?? null;
    const parsed = parseAiFeatureProposalsDetailed(raw);
    base.proposed = parsed.proposals.length;
    const { accepted, dropped } = groundProposals(parsed.proposals, candidates);
    base.dropped = dropped;
    if (accepted.length === 0) {
      if (parsed.verdict === 'proposals') return done({ skip_reason: 'all_ungrounded' });
      const byVerdict = {
        declined:   'model_declined',
        unreadable: 'model_unreadable',
        incomplete: 'model_incomplete',
      } as const;
      return done({ skip_reason: byVerdict[parsed.verdict], parse_detail: parsed.detail });
    }

    const fresh: AiFeatureProposal[] = [];
    for (const p of accepted) {
      const sig = intelSignature(toTrackerRow(p));
      if (known.has(sig)) { base.dedup_skipped++; continue; }
      known.add(sig);
      fresh.push(p);
    }
    base.grounded = fresh.length;
    if (fresh.length === 0) return done({ skip_reason: 'all_duplicates' });

    // Критик — закрыт по умолчанию. Одно предложение — один вердикт; ответа
    // нет — предложение не уходит, и это отдельный код, а не «отклонено».
    const approved: AiFeatureProposal[] = [];
    let criticSilent = 0;
    for (const p of fresh) {
      const verdictRaw = await callAIDecision(buildCriticPrompt(p)).catch(() => null);
      const verdict = parseCriticVerdict(verdictRaw);
      if (verdict.approved) { approved.push(p); continue; }
      if (verdict.score === null) criticSilent++;
      base.critic_rejected.push({
        title: p.title,
        reason: verdict.score === null ? verdict.reason : `${verdict.score}/10: ${verdict.reason}`,
      });
    }
    if (approved.length === 0) {
      return done({ skip_reason: criticSilent === fresh.length ? 'critic_unavailable' : 'critic_rejected_all' });
    }

    for (const p of approved) {
      const row = toTrackerRow(p);
      const ok = await pool.query(
        `INSERT INTO evo_growth_issues (category, severity, title, description, suggestion, status)
         VALUES ('intel', 'medium', $1, $2, $3, 'suggested')`,
        [row.title, row.description, row.suggestion],
      ).then(() => true).catch(() => false);
      if (ok) base.stored++;
    }

    const dateKey = opts.dateKey ?? new Date().toISOString().slice(0, 10);
    const sent = await sendToOwner(formatAiFeaturesMessage(approved, dateKey));

    const urls = [...seen, ...fetched.map((c) => c.url)].slice(-300);
    await agentMemory.remember({
      agent_id: 'scout-digest',
      memory_type: 'ai_features_seen',
      key: 'urls',
      value: { urls },
      source: 'scout_ai_features',
      expires_at: new Date(Date.now() + SEEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    }).catch(() => { /* память некритична */ });

    return done({ sent });
  } catch {
    return done({ skip_reason: 'error' });
  }
}
