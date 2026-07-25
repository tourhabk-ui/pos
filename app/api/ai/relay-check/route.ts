/**
 * GET /api/ai/relay-check?secret=CRON_SECRET
 *
 * Проверка обхода гео-блокировки РФ для флагманов (Claude/GPT). Прод крутится
 * на Timeweb в РФ, поэтому этот запрос уходит в апстримы С РФ-IP — ровно тот
 * путь, что и у боевых вызовов. Отвечает на один вопрос: «работает ли релей?».
 *
 * Что показывает:
 *  - включён ли релей (заданы ли OPENROUTER_BASE_URL / ANTHROPIC_BASE_URL) и куда;
 *  - достижимы ли openrouter.ai и api.anthropic.com С ЭТОГО СЕРВЕРА (из РФ);
 *  - проходит ли реальный флагман-вызов (Claude через OpenRouter).
 *
 * Важно: гео-блок проявляется как сетевой таймаут/сброс, а НЕ как HTTP-статус.
 * Значит «получили любой HTTP-ответ (даже 401/404)» = апстрим достижим.
 *
 * Гейт — CRON_SECRET в query (как у debug-waterfall), cookie-аутентификация не
 * нужна. Ключи не логируются и в ответ не попадают.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getOpenRouterKey } from '@/lib/ai/provider-config';
import { requireAdmin } from '@/lib/auth/middleware';
import { githubFetch } from '@/lib/agents/evo/github-fetch';

export const dynamic = 'force-dynamic';

const OPENROUTER_DEFAULT = 'https://openrouter.ai/api/v1';
const ANTHROPIC_DEFAULT = 'https://api.anthropic.com';

interface ProbeResult {
  reachable: boolean;
  http_status: number | null;
  latency_ms: number;
  error: string | null;
}

/** Пингует URL. Любой HTTP-ответ = достижим; таймаут/сброс = блок/недоступен. */
async function probe(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    return { reachable: true, http_status: res.status, latency_ms: Date.now() - started, error: null };
  } catch (e) {
    // Не отдаём стек — только класс ошибки (таймаут / сетевой сброс = вероятный гео-блок).
    const name = e instanceof Error ? e.name : 'Error';
    const aborted = name === 'AbortError';
    return {
      reachable: false,
      http_status: null,
      latency_ms: Date.now() - started,
      error: aborted ? 'timeout (вероятный гео-блок или релей недоступен)' : 'network error (сброс соединения / DNS / гео-блок)',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  // Доступ: либо ?secret=CRON_SECRET (для крона/скриптов), либо сессия админа
  // (чтобы владелец мог открыть в браузере, залогинившись в админку, без секрета).
  const secret = request.nextUrl.searchParams.get('secret');
  const cronSecret = process.env.CRON_SECRET;
  const cronOk = !!cronSecret && secret === cronSecret;
  if (!cronOk) {
    const auth = await requireAdmin(request);
    if (auth instanceof NextResponse) {
      return NextResponse.json(
        { error: 'Forbidden. Открой залогинившись администратором, либо передай ?secret=CRON_SECRET' },
        { status: 403 },
      );
    }
  }

  const orBase = (process.env.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT).replace(/\/+$/, '');
  const anthropicBase = (process.env.ANTHROPIC_BASE_URL || ANTHROPIC_DEFAULT).replace(/\/+$/, '');
  const orIsRelay = orBase !== OPENROUTER_DEFAULT;
  const anthropicIsRelay = anthropicBase !== ANTHROPIC_DEFAULT;

  const orKey = getOpenRouterKey() || '';
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

  // Достижимость апстримов с этого (РФ) сервера. /models на OpenRouter публичен;
  // Anthropic отвечает 401 без ключа — это тоже «достижим».
  const [orProbe, anthropicProbe] = await Promise.all([
    probe(`${orBase}/models`, orKey ? { Authorization: `Bearer ${orKey}` } : {}),
    probe(`${anthropicBase}/v1/models`, {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    }),
  ]);

  // Чтение репозитория эволюцией: на проде (standalone) исходников нет, скан
  // тянет перечень и тела файлов из GitHub. Тот же гео-блок РФ. Пробуем оба
  // хоста ЧЕРЕЗ githubFetch — тем же путём, что и боевой скан (с релеем, если
  // GITHUB_PROXY_BASE задан). Любой HTTP-ответ = достижим; таймаут = блок.
  const ghProxyBase = process.env.GITHUB_PROXY_BASE?.trim().replace(/\/+$/, '') || null;
  const ghConfigured = !!ghProxyBase;
  async function ghProbe(rawUrl: string): Promise<ProbeResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const started = Date.now();
    try {
      const res = await githubFetch(rawUrl, {
        headers: { 'User-Agent': 'kamchatour-evo', Accept: 'application/vnd.github+json' },
        signal: ctrl.signal,
      });
      return { reachable: true, http_status: res.status, latency_ms: Date.now() - started, error: null };
    } catch (e) {
      const name = e instanceof Error ? e.name : 'Error';
      return {
        reachable: false, http_status: null, latency_ms: Date.now() - started,
        error: name === 'AbortError' ? 'timeout (гео-блок или релей недоступен)' : 'network error (сброс / DNS / гео-блок)',
      };
    } finally {
      clearTimeout(timer);
    }
  }
  const [ghApiProbe, ghRawProbe] = await Promise.all([
    ghProbe('https://api.github.com/repos/tourhabk-ui/pos'),
    ghProbe('https://raw.githubusercontent.com/tourhabk-ui/pos/main/next-env.d.ts'),
  ]);
  const ghReadable = ghApiProbe.reachable && ghRawProbe.reachable;

  // Реальный флагман-вызов через OpenRouter (то, ради чего релей и нужен).
  // Диагностический ПРЯМОЙ fetch (мимо waterfall и его предохранителя): при
  // отказе показываем HTTP-статус и краткий текст ошибки OpenRouter — иначе
  // причина (401 ключ / 402 кредиты / 404 модель) глотается и остаётся гадание.
  // Дефолт пинга = модель, которой реально пользуется решатель эволюции
  // (EVO_FLAGSHIP_MODEL в callAIDecision) — диагностика проверяет боевой путь,
  // а не отдельную (возможно устаревшую в каталоге) модель.
  const model = request.nextUrl.searchParams.get('model')
    || process.env.EVO_DECISION_FLAGSHIP_MODEL
    || 'anthropic/claude-opus-5';
  let flagship: {
    ok: boolean;
    model: string | null;
    preview: string | null;
    http_status: number | null;
    error: string | null;
    note: string;
  } = { ok: false, model: null, preview: null, http_status: null, error: null, note: '' };

  if (!orKey) {
    flagship.note = 'OPENROUTER_API_KEY не задан — флагман-вызов пропущен';
  } else {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const res = await fetch(`${orBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${orKey}`,
          'HTTP-Referer': 'https://vedarai.ru',
          'X-Title': 'Vedarai Kamchatka',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Ответь одним словом: работает' }],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      flagship.http_status = res.status;
      const bodyText = await res.text();
      if (res.ok) {
        const data = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> };
        const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
        flagship.ok = !!text;
        flagship.model = model;
        flagship.preview = text.slice(0, 80) || null;
        flagship.note = text ? 'флагман достижим через OpenRouter' : 'HTTP 200, но пустой ответ модели';
      } else {
        // Текст ошибки OpenRouter (без ключей): 401 — ключ, 402 — кредиты, 404 — модель.
        flagship.error = bodyText.slice(0, 300);
        flagship.note =
          res.status === 401 ? 'ключ не принят (проверь OPENROUTER_API_KEY)' :
          res.status === 402 ? 'нет кредитов на OpenRouter (пополни баланс)' :
          res.status === 404 ? `модель "${model}" не найдена — попробуй ?model=<id из /or/api/v1/models>` :
          `OpenRouter ответил HTTP ${res.status}`;
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : 'Error';
      flagship.error = name === 'AbortError' ? 'timeout' : 'network error';
      flagship.note = 'сетевая ошибка до OpenRouter через релей';
    }
  }

  // Тот же тест НАПРЯМУЮ через Anthropic API (второй путь к Claude, минуя
  // OpenRouter) — решатель эволюции теперь умеет и его (callAIDecision, шаг 0b).
  const anthropicModel = model.replace(/^anthropic\//, '');
  let anthropicCall: typeof flagship = { ok: false, model: null, preview: null, http_status: null, error: null, note: '' };
  if (!anthropicKey) {
    anthropicCall.note = 'ANTHROPIC_API_KEY не задан — вызов пропущен';
  } else {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const res = await fetch(`${anthropicBase}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        // temperature не шлём — новые модели (Opus 4.8+) его депрекейтнули (HTTP 400).
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Ответь одним словом: работает' }],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      anthropicCall.http_status = res.status;
      const bodyText = await res.text();
      if (res.ok) {
        const data = JSON.parse(bodyText) as { content?: Array<{ text?: string }> };
        const text = data?.content?.[0]?.text?.trim() ?? '';
        anthropicCall.ok = !!text;
        anthropicCall.model = anthropicModel;
        anthropicCall.preview = text.slice(0, 80) || null;
        anthropicCall.note = text ? 'Claude достижим напрямую через Anthropic API' : 'HTTP 200, но пустой ответ';
      } else {
        anthropicCall.error = bodyText.slice(0, 300);
        anthropicCall.note =
          res.status === 401 ? 'ключ не принят (проверь ANTHROPIC_API_KEY)' :
          res.status === 404 ? `модель "${anthropicModel}" не найдена` :
          `Anthropic ответил HTTP ${res.status}`;
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : 'Error';
      anthropicCall.error = name === 'AbortError' ? 'timeout' : 'network error';
      anthropicCall.note = 'сетевая ошибка до Anthropic через релей';
    }
  }

  // Простой вердикт: что происходит и что делать. Claude достижим ЛЮБЫМ из
  // двух путей (OpenRouter ИЛИ Anthropic напрямую) → флагманы работают.
  let verdict: string;
  if (flagship.ok && anthropicCall.ok) {
    verdict = 'OK: флагманы достижимы обоими путями (OpenRouter + Anthropic)';
  } else if (anthropicCall.ok) {
    verdict = 'OK: Claude достижим напрямую через Anthropic (OpenRouter-путь не прошёл — см. flagship_call)';
  } else if (flagship.ok) {
    verdict = orIsRelay ? 'OK: релей включён, флагманы достижимы' : 'OK: флагманы достижимы напрямую (гео-блока нет)';
  } else if (!orKey && !anthropicKey) {
    verdict = 'НЕ ГОТОВО: нет ни OPENROUTER_API_KEY, ни ANTHROPIC_API_KEY';
  } else if (!orIsRelay && !orProbe.reachable) {
    verdict = 'НУЖЕН РЕЛЕЙ: openrouter.ai недостижим напрямую (гео-блок РФ). Задеплой воркер и задай OPENROUTER_BASE_URL';
  } else if (orIsRelay && !orProbe.reachable) {
    verdict = 'РЕЛЕЙ НЕ ОТВЕЧАЕТ: OPENROUTER_BASE_URL задан, но апстрим через него недостижим. Проверь деплой воркера/URL';
  } else {
    verdict = 'ПОЧТИ: апстримы достижимы, но оба флагман-вызова не прошли — см. flagship_call.note и anthropic_call.note';
  }

  return NextResponse.json({
    verdict,
    relay: {
      openrouter: { configured: orIsRelay, base_url: orBase, reachable_from_server: orProbe },
      anthropic: { configured: anthropicIsRelay, base_url: anthropicBase, reachable_from_server: anthropicProbe },
    },
    keys: { openrouter: !!orKey, anthropic: !!anthropicKey },
    flagship_call: flagship,
    anthropic_call: anthropicCall,
    github_read: {
      configured: ghConfigured,
      proxy_base: ghProxyBase,
      api_token: !!process.env.GITHUB_API_TOKEN,
      api: ghApiProbe,
      raw: ghRawProbe,
      verdict: ghReadable
        ? (ghConfigured ? 'OK: репо читается через релей — прочёс эволюции не ослепнет'
                        : 'OK: GitHub достижим напрямую (гео-блока для чтения репо нет)')
        : (ghConfigured ? 'РЕЛЕЙ НЕ ОТДАЁТ GITHUB: GITHUB_PROXY_BASE задан, но gh-api/gh-raw недостижимы — обнови воркер (npx wrangler deploy) и проверь URL'
                        : 'НУЖЕН РЕЛЕЙ ДЛЯ РЕПО: GitHub недостижим из РФ — задай GITHUB_PROXY_BASE на воркер (см. infra/ai-relay/README.md)'),
    },
    hint: 'Инструкция по деплою релея — infra/ai-relay/README.md',
  });
}
