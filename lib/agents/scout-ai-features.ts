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
import { callAIDecision } from '@/lib/ai/providers';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { intelSignature } from '@/lib/agents/evo/claim-signature';
import { scrubInjectionLines } from '@/lib/agents/evo/memory-guard';
import type { ChatMessage } from '@/lib/ai/prompts';

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
  /** Записано в evo_growth_issues. */
  stored: number;
  /** Ушло владельцу в Telegram. */
  sent: boolean;
  /**
   * Почему прогон не дал предложений — только когда grounded === 0.
   * no_candidates — материалов не было; model_empty — материалы были, модель
   * вернула пустой массив или неразбираемый ответ (03.09 run 2: 6 кандидатов,
   * 4 с текстом, ответ пуст — это не «нечего было читать»).
   */
  skip_reason?: 'no_candidates' | 'model_empty' | 'decision_null' | 'all_ungrounded' | 'all_duplicates' | 'error';
  duration_ms: number;
}

/** Материалов модели за прогон: больше — дороже, а суть дня в первых. */
export const AI_FEATURE_CANDIDATES_LIMIT = 6;
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
- не предлагай общие вещи («внедрить ИИ-чат», «улучшить рекомендации») и не предлагай то, что уже есть (Кузьмич есть, планер есть, SOS есть) — только новую возможность для них;
- если в материалах нет ничего применимого — верни пустой массив. Пустой ответ лучше выдуманного.

Верни СТРОГО JSON-массив без markdown, максимум ${AI_FEATURE_PROPOSALS_LIMIT} элемента:
[{"title":"ИИ-фича ≤8 слов","surface":"kuzmich|safety|planner|offline_map|operators|content|intel","capability":"...","why_now":"...","first_step":"...","evidence_quote":"...","source_url":"..."}]`;

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

/** Разбор ответа модели. Терпим к json-обёртке; поля обязательны. */
export function parseAiFeatureProposals(raw: string | null): AiFeatureProposal[] {
  if (!raw) return [];
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: AiFeatureProposal[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const p: AiFeatureProposal = {
      title: str('title'),
      surface: str('surface') as AiFeatureSurface,
      capability: str('capability'),
      why_now: str('why_now'),
      first_step: str('first_step'),
      evidence_quote: str('evidence_quote'),
      source_url: str('source_url'),
    };
    if (p.title.length < 4 || p.title.length > 180) continue;
    if (!p.capability || !p.first_step || !p.evidence_quote || !p.source_url) continue;
    out.push(p);
  }
  return out.slice(0, AI_FEATURE_PROPOSALS_LIMIT);
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
    description: `[${p.surface}] ${p.capability}\nПочему сейчас: ${p.why_now}\nЦитата: «${p.evidence_quote}»\nИсточник: ${p.source_url}`.slice(0, 2000),
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
        text: text.slice(0, 4096),
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
  const base = { candidates: 0, with_text: 0, proposed: 0, grounded: 0, dropped: [] as Array<{ title: string; reason: string }>, dedup_skipped: 0, stored: 0, sent: false };
  const done = (extra: Partial<AiFeaturesResult>): AiFeaturesResult => ({ ...base, ...extra, duration_ms: Date.now() - startedAt });

  try {
    // Адреса, по которым линза уже предлагала (память на SEEN_TTL_DAYS):
    // та же статья завтра — та же идея, слот уходит новому.
    const recalled = await agentMemory.recall('scout-digest', 'ai_features_seen', 1).catch(() => []);
    const seen = new Set<string>(((recalled[0]?.value as { urls?: string[] } | undefined)?.urls) ?? []);

    const picked = items.filter((i) => i.url && !seen.has(i.url)).slice(0, AI_FEATURE_CANDIDATES_LIMIT);
    if (picked.length === 0) return done({ skip_reason: 'no_candidates' });

    const candidates: AiFeatureCandidate[] = await Promise.all(
      picked.map(async (i) => ({ title: i.title, url: i.url, source: i.source, text: await fetchText(i.url).catch(() => '') })),
    );
    base.candidates = candidates.length;
    base.with_text = candidates.filter((c) => c.text).length;

    const { rows: prior } = await pool.query<{ title: string; description: string | null; suggestion: string | null }>(
      `SELECT title, description, suggestion FROM evo_growth_issues WHERE category = 'intel'`,
    ).catch(() => ({ rows: [] as Array<{ title: string; description: string | null; suggestion: string | null }> }));
    const known = new Set(prior.map((r) => intelSignature(r)));
    const knownTopics = [...new Set(
      prior.map((r) => intelSignature(r)).filter((s) => !s.startsWith('intel::other:')).map((s) => s.replace('intel::', '')),
    )];

    const raw = await callAIDecision(buildAiFeaturePrompt(candidates, knownTopics)).catch(() => null);
    if (raw === null) return done({ skip_reason: 'decision_null' });

    const proposed = parseAiFeatureProposals(raw);
    base.proposed = proposed.length;
    const { accepted, dropped } = groundProposals(proposed, candidates);
    base.dropped = dropped;
    if (accepted.length === 0) {
      return done({ skip_reason: proposed.length === 0 ? 'model_empty' : 'all_ungrounded' });
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

    for (const p of fresh) {
      const row = toTrackerRow(p);
      const ok = await pool.query(
        `INSERT INTO evo_growth_issues (category, severity, title, description, suggestion, status)
         VALUES ('intel', 'medium', $1, $2, $3, 'suggested')`,
        [row.title, row.description, row.suggestion],
      ).then(() => true).catch(() => false);
      if (ok) base.stored++;
    }

    const dateKey = opts.dateKey ?? new Date().toISOString().slice(0, 10);
    const sent = await sendToOwner(formatAiFeaturesMessage(fresh, dateKey));

    const urls = [...seen, ...candidates.map((c) => c.url)].slice(-300);
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
