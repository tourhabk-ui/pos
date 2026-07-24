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
import { callOpenRouterModel } from '@/lib/ai/providers';
import { getOpenRouterKey } from '@/lib/ai/provider-config';
import { requireAdmin } from '@/lib/auth/middleware';
import type { ChatMessage } from '@/lib/ai/prompts';

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

  // Реальный флагман-вызов через OpenRouter (то, ради чего релей и нужен).
  const model = request.nextUrl.searchParams.get('model') || 'anthropic/claude-3.5-haiku';
  let flagship: { ok: boolean; model: string | null; preview: string | null; note: string } = {
    ok: false,
    model: null,
    preview: null,
    note: '',
  };
  if (!orKey) {
    flagship.note = 'OPENROUTER_API_KEY не задан — флагман-вызов пропущен';
  } else {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Ответь одним словом: работает', timestamp: Date.now() }];
    const out = await callOpenRouterModel(msgs, model, { timeoutMs: 20_000, maxTokens: 8, temperature: 0 });
    if (out) {
      flagship = { ok: true, model: out.model_used, preview: out.text.slice(0, 80), note: 'флагман достижим через OpenRouter' };
    } else {
      flagship.note = orIsRelay
        ? 'вызов не прошёл: проверь, что релей задеплоен и base_url верный, ключ активен'
        : 'вызов не прошёл: OPENROUTER_BASE_URL не задан → идём напрямую, а РФ-IP заблокирован. Настрой релей.';
    }
  }

  // Простой вердикт: что происходит и что делать.
  let verdict: string;
  if (flagship.ok) {
    verdict = orIsRelay ? 'OK: релей включён, флагманы достижимы' : 'OK: флагманы достижимы напрямую (гео-блока нет)';
  } else if (!orKey) {
    verdict = 'НЕ ГОТОВО: нет OPENROUTER_API_KEY';
  } else if (!orIsRelay && !orProbe.reachable) {
    verdict = 'НУЖЕН РЕЛЕЙ: openrouter.ai недостижим напрямую (гео-блок РФ). Задеплой воркер и задай OPENROUTER_BASE_URL';
  } else if (orIsRelay && !orProbe.reachable) {
    verdict = 'РЕЛЕЙ НЕ ОТВЕЧАЕТ: OPENROUTER_BASE_URL задан, но апстрим через него недостижим. Проверь деплой воркера/URL';
  } else {
    verdict = 'ПОЧТИ: апстрим достижим, но флагман-вызов не прошёл — проверь ключ/модель';
  }

  return NextResponse.json({
    verdict,
    relay: {
      openrouter: { configured: orIsRelay, base_url: orBase, reachable_from_server: orProbe },
      anthropic: { configured: anthropicIsRelay, base_url: anthropicBase, reachable_from_server: anthropicProbe },
    },
    keys: { openrouter: !!orKey, anthropic: !!anthropicKey },
    flagship_call: flagship,
    hint: 'Инструкция по деплою релея — infra/ai-relay/README.md',
  });
}
