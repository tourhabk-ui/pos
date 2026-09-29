/**
 * Чтение постов X через xAI: Responses API + серверный инструмент `x_search`.
 *
 * Решение владельца 29.09: «разведчик должен читать новости про ИИ в X,
 * может добавим Grok». Проверено пробой с раннера (xai-x-search-probe,
 * прогон 2): `POST /v1/responses` с `tools: [{type: 'x_search'}]` отдаёт
 * настоящие посты с адресами и датами; прежний Live Search
 * (`search_parameters` в chat/completions) отвечает 410 «deprecated».
 * Поиск идёт на стороне xAI — с прода нужен только `api.x.ai`, реле и
 * раннер не нужны.
 *
 * Цена (та же проба): одна выборка по шести аккаунтам за сутки на
 * `grok-4.20-…-non-reasoning` — 8 вызовов поиска, 10k токенов, $0,07 за
 * 6 с; reasoning-модель — 41 с; multi-agent — 21 вызов и $0,30. Поэтому
 * модель выбирается НЕ сильнейшая, а без рассуждений: ей и быстрее, и
 * дешевле, и находит она не меньше. Точный расход xAI называет сам
 * (`usage.cost_in_usd_ticks`), и в книги идёт он, а не оценка по каталогу:
 * плата за инструмент в каталоге моделей не значится.
 *
 * Только чтение. В промпте — список аккаунтов и окно часов; персональных
 * данных туристов здесь нет и быть не может (152-ФЗ, D1). Хост `api.x.ai`
 * в реестре D2, файл — в `LLM_EGRESS_FILES`.
 *
 * Исходов у вызова три (§4.0): посты (в том числе ноль — «за окно ничего не
 * писали»), названный отказ (нет ключа, кредиты, сеть, ответ не разобран) —
 * и никакого «пусто» вместо отказа.
 */
import { getXaiKey } from '@/lib/ai/provider-config';
import { pickBestModel } from '@/lib/ai/model-resolver';
import { logProviderPricedUsage } from '@/lib/ai/providers';

const XAI_BASE = 'https://api.x.ai/v1';

/** Override модели для поиска по X; без него — из каталога (см. pickXSearchModel). */
export const X_SEARCH_MODEL_ENV = 'XAI_X_SEARCH_MODEL';

/**
 * Курс «тиков» xAI к доллару.
 *
 * Выведен из пробы 29.09, прогон 2: 733 475 500 тиков за вызов с 9 593
 * входными и 451 выходным токеном плюс 8 вызовов поиска. При 1e-10 это
 * $0,073 — сходится с прайсом ($2/$6 за 1M токенов даёт $0,022, остаток —
 * плата за инструмент); при 1e-9 вышло бы $0,73, что прайсу противоречит.
 * Если xAI сменит масштаб, книги разойдутся с консолью — сверять по ней.
 */
export const XAI_USD_PER_TICK = 1e-10;

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
let catalogCache: { ids: string[]; at: number } | null = null;

/** Не текстовые модели каталога xAI — поиск по X им не поручается. */
const NON_TEXT = /(image|imagegen|video|vision|voice|audio|tts|stt)/i;

/**
 * Модель для поиска: сначала без рассуждений (`non-reasoning`), потом
 * сильнейшая текстовая из семейства grok. Чистая функция — под тестом.
 */
export function pickXSearchModel(ids: readonly string[]): string | null {
  const text = ids.filter((id) => /grok/i.test(id) && !NON_TEXT.test(id));
  const plain = text.filter((id) => /non-reasoning/i.test(id)).sort();
  if (plain.length > 0) return plain[plain.length - 1];
  return pickBestModel(text);
}

async function resolveModel(key: string): Promise<{ model: string } | { error: string }> {
  const override = process.env[X_SEARCH_MODEL_ENV]?.trim();
  if (override) return { model: override };
  if (!catalogCache || Date.now() - catalogCache.at > CATALOG_TTL_MS) {
    const res = await fetch(`${XAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { error: `каталог xAI: HTTP ${res.status}` };
    const j = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const ids = (j?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    if (ids.length === 0) return { error: 'каталог xAI пуст' };
    catalogCache = { ids, at: Date.now() };
  }
  const model = pickXSearchModel(catalogCache.ids);
  return model ? { model } : { error: `в каталоге xAI ${catalogCache.ids.length} моделей, текстовой grok нет` };
}

export interface XPost {
  handle: string;
  url: string;
  /** ISO-дата поста по данным xAI; null — модель дату не назвала. */
  postedAt: string | null;
  /** Суть поста по-русски, до 200 знаков. */
  summary: string;
}

export interface XSearchUsage {
  inputTokens: number;
  outputTokens: number;
  xSearchCalls: number;
  /** Расход, названный самим xAI; null — поле не пришло. */
  costUsd: number | null;
}

export type XSearchResult =
  | { ok: true; model: string; posts: XPost[]; usage: XSearchUsage | null; ms: number }
  | { ok: false; reason: string };

/** Что просим у модели: только данные, без выдумки, и пустой список — законный ответ. */
export function buildXSearchPrompt(handles: readonly string[], hours: number): string {
  return (
    `Найди посты за последние ${hours} часов от аккаунтов ${handles.map((h) => '@' + h).join(', ')} ` +
    'о новостях, релизах и исследованиях в области ИИ и инструментов разработки. ' +
    'Верни ТОЛЬКО JSON-массив объектов вида ' +
    // Адрес поста в примере — без схемы: реестр D2 считает хостом любой
    // `https://…` в тексте файла, а x.com — не LLM-эндпоинт, туда мы не ходим.
    '{"handle":"…","url":"полный адрес поста вида x.com/<аккаунт>/status/<id>","posted_at":"ISO 8601","summary_ru":"суть по-русски, до 200 знаков"}. ' +
    'Один объект на пост, без повторов. Ничего не выдумывай: если постов за окно нет — верни пустой массив [].'
  );
}

const X_URL = /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/;

/**
 * Разбор ответа модели. Берётся первый JSON-массив в тексте; каждая запись
 * проверяется по форме — адрес поста обязан вести на x.com, иначе это не
 * пост, а сочинение. Непригодные записи отбрасываются, а не чинятся.
 */
export function parseXSearchAnswer(text: string): XPost[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: XPost[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    const o = (it ?? {}) as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    const summary = typeof o.summary_ru === 'string' ? o.summary_ru.trim() : '';
    if (!X_URL.test(url) || summary.length === 0 || seen.has(url)) continue;
    seen.add(url);
    const handle = (typeof o.handle === 'string' ? o.handle : url.split('/')[3] ?? '').replace(/^@/, '');
    const posted = typeof o.posted_at === 'string' && !Number.isNaN(Date.parse(o.posted_at)) ? new Date(o.posted_at).toISOString() : null;
    out.push({ handle, url, postedAt: posted, summary: summary.slice(0, 200) });
  }
  return out;
}

/** Текст и usage из ответа Responses API — по форме, без догадок о схеме. */
function digest(j: unknown): { text: string; usage: XSearchUsage | null } {
  const o = (j ?? {}) as { output?: unknown; usage?: Record<string, unknown>; output_text?: unknown };
  let text = typeof o.output_text === 'string' ? o.output_text : '';
  for (const it of Array.isArray(o.output) ? o.output : []) {
    const item = it as { content?: unknown };
    for (const c of Array.isArray(item.content) ? item.content : []) {
      const part = c as { text?: unknown };
      if (typeof part.text === 'string') text += (text ? '\n' : '') + part.text;
    }
  }
  const u = o.usage;
  let usage: XSearchUsage | null = null;
  if (u && typeof u === 'object') {
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const tools = (u.server_side_tool_usage_details ?? {}) as Record<string, unknown>;
    const ticks = u.cost_in_usd_ticks;
    usage = {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      xSearchCalls: num(tools.x_search_calls),
      costUsd: typeof ticks === 'number' && Number.isFinite(ticks) ? ticks * XAI_USD_PER_TICK : null,
    };
  }
  return { text, usage };
}

function nameFailure(status: number, body: string): string {
  const short = body.replace(/\s+/g, ' ').slice(0, 160);
  if (status === 403 && /credits|spending limit/i.test(body)) return 'xAI: кредиты исчерпаны или достигнут лимит трат (403)';
  if (status === 401 || (status === 403 && /api key/i.test(body))) return `xAI: ключ не принят (${status})`;
  if (status === 429) return 'xAI: слишком много запросов (429)';
  return `xAI: HTTP ${status} — ${short}`;
}

/**
 * Один запрос: посты указанных аккаунтов за окно часов.
 *
 * Расход пишется в книги ценой, названной xAI. Отказ возвращается словами и
 * никогда пустым списком.
 */
export async function searchX(
  opts: { handles: readonly string[]; hours: number; timeoutMs?: number; maxOutputTokens?: number },
): Promise<XSearchResult> {
  const key = getXaiKey();
  if (!key) return { ok: false, reason: 'XAI_API_KEY не задан' };
  if (opts.handles.length === 0) return { ok: false, reason: 'список аккаунтов пуст' };

  const picked = await resolveModel(key).catch((e: unknown) => ({ error: `каталог xAI: ${e instanceof Error ? e.message : String(e)}` }));
  if ('error' in picked) return { ok: false, reason: picked.error };

  const to = new Date();
  const from = new Date(to.getTime() - opts.hours * 3_600_000);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${XAI_BASE}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: picked.model,
        input: [{ role: 'user', content: buildXSearchPrompt(opts.handles, opts.hours) }],
        tools: [{
          type: 'x_search',
          allowed_x_handles: [...opts.handles],
          from_date: from.toISOString().slice(0, 10),
          to_date: to.toISOString().slice(0, 10),
        }],
        max_output_tokens: opts.maxOutputTokens ?? 1500,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
  } catch (e) {
    return { ok: false, reason: `xAI: сеть не дошла — ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = await res.text();
  if (!res.ok) return { ok: false, reason: nameFailure(res.status, body) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'xAI: ответ не JSON' };
  }
  const { text, usage } = digest(parsed);
  if (usage) {
    await logProviderPricedUsage(`xai:x_search:${picked.model}`, usage.inputTokens, usage.outputTokens, usage.costUsd);
  }
  if (text.trim() === '') return { ok: false, reason: 'xAI: в ответе нет текста' };
  return { ok: true, model: picked.model, posts: parseXSearchAnswer(text), usage, ms: Date.now() - started };
}
