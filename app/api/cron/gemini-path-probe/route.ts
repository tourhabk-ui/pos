/**
 * GET /api/cron/gemini-path-probe?account=<hex32>&gateway=vedar-ai
 * Authorization: Bearer <CRON_SECRET>
 *
 * Отвечает на ОДИН вопрос: по какому пути ПРОД (Timeweb, РФ) достаёт Gemini.
 * Зовёт её gemini-path-probe.yml с раннера.
 *
 * ЗАЧЕМ (20.11). Владелец обновил GEMINI_API_KEY в Timeweb. Прямой путь с
 * прода закрыт: Google отвечает 400 «User location is not supported»
 * (ai-debug 04.09, 05.11, 06.11). Шлюз Cloudflare `vedar-ai` с прода довёл
 * запрос до Anthropic (anthropic-path-probe, прогон 8); пропустит ли Google
 * запрос шлюза — рассуждением не решить, только замером (§4.0).
 *
 * ЧТО МЕРЯЕТ. По каждому пути — список моделей тем же адресом и заголовком,
 * что у живого кода (`lib/ai/gemini-endpoint.ts`). Если хоть один путь
 * открыт — одна генерация в один токен моделью живого кода (pickProbeModel),
 * а если она не ответила — ещё до двух запасных flash-моделей списка: на
 * Gemini держатся зрение, расшифровка голоса и разбор PDF. Пять исходов на путь:
 * open, open_key_refused (дошли до Google, ключ отвергнут), blocked
 * (гео-отказ), http (чужой ответ), unreachable («не смог», а не «закрыто»).
 *
 * В ответе нет адресов: путь назван словом (gateway / current / direct), а
 * id аккаунта Cloudflare в ответ не попадает. Чем адрес из GEMINI_BASE_URL
 * отличается от шлюза пробы, сказано словами (`current_vs_gateway`: аккаунт
 * и имя шлюза — тот же / другой). Ключ назван отпечатком — по нему видно,
 * дошёл ли новый ключ до контейнера (`lib/ai/key-identity.ts`). Откуда взята
 * модель генерации — из GEMINI_MODEL или из списка — сказано в
 * `generate.model_source`.
 *
 * SSRF. Адрес шлюза собирается из проверенных частей (`geminiGatewayBase`):
 * хост — литерал, id аккаунта пересобирается через число, имя шлюза — из
 * таблицы. Строка запроса адресом не становится.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { keyIdentity } from '@/lib/ai/key-identity';
import { classifyModels } from '@/lib/ai/model-resolver';
import {
  gatewayBaseDiff,
  geminiEndpoint,
  geminiGatewayBase,
  geminiHeaders,
  geminiModelIds,
  geminiUrl,
  pickGeminiModel,
  GEMINI_DIRECT_BASE,
  UNSTABLE_GEMINI_ID,
  type GeminiEndpoint,
} from '@/lib/ai/gemini-endpoint';

export const dynamic = 'force-dynamic';
// До трёх проб списка по 10 с, генерация основной моделью до 40 с и две
// запасные по 20 с — 110 с в худшем случае; запас до 120, раннер ждёт 150 с.
export const maxDuration = 120;

export type GeminiPathOutcome =
  | 'open'              // 2xx: дошли и ответили
  | 'open_key_refused'  // ответ формы Google с ошибкой ключа: дошли, ключ не принят
  | 'blocked'           // гео-отказ Google или 403 не от Google
  | 'http'              // иной код или чужой ответ
  | 'unreachable';      // сетевой отказ — «не смог», а не «закрыто»

export type GeminiPathName = 'gateway' | 'current' | 'direct';

/** Гео-отказ Google: замер 04.09 — 400 FAILED_PRECONDITION «User location is not supported». */
const GEO_REFUSAL = /user location is not supported|not (?:available|supported) in your (?:country|region)/i;

/** Ответ САМОГО Google узнаётся по форме: `{"error":{…,"status":"INVALID_ARGUMENT"}}`. */
export function isGoogleErrorBody(body: string): boolean {
  return /"error"\s*:\s*\{[\s\S]*"status"\s*:\s*"[A-Z_]+"/.test(body);
}

export function classifyGemini(status: number, body: string): GeminiPathOutcome {
  if (status >= 200 && status < 300) return 'open';
  if (GEO_REFUSAL.test(body)) return 'blocked';
  if (status >= 400 && status < 500 && isGoogleErrorBody(body)) return 'open_key_refused';
  if (status === 403) return 'blocked';
  return 'http';
}

export const OPEN_OUTCOMES: ReadonlySet<GeminiPathOutcome> = new Set(['open', 'open_key_refused']);

export interface GeminiPathProbe {
  path: GeminiPathName;
  outcome: GeminiPathOutcome;
  status: number | null;
  latency_ms: number | null;
  detail: string | null;
  /** Модели с generateContent из ответа списка (только при open). */
  models: number | null;
}

interface ProbeTarget {
  path: GeminiPathName;
  endpoint: GeminiEndpoint;
}

/**
 * Модель для пробы генерации — та, которой пойдёт живой код
 * (resolveGeminiModel): ручная GEMINI_MODEL, иначе pickGeminiModel. Проба 20.11
 * брала первую flash-модель списка, gemini-2.5-flash, и получила 404 «no longer
 * available to new users» — про модель, которой живой код не ходит.
 */
export function pickProbeModel(ids: readonly string[]): string | null {
  return process.env.GEMINI_MODEL?.trim() || pickGeminiModel(ids);
}

async function probeList(target: ProbeTarget, apiKey: string): Promise<{ probe: GeminiPathProbe; ids: string[] }> {
  const started = Date.now();
  try {
    const res = await fetch(geminiUrl('models', target.endpoint), {
      headers: geminiHeaders(apiKey, target.endpoint, false),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text().catch(() => '');
    let ids: string[] = [];
    if (res.ok) {
      try {
        ids = geminiModelIds(JSON.parse(body));
      } catch (e) {
        console.error('[gemini-path-probe] список моделей не разобран:', e instanceof Error ? e.message : String(e));
      }
    }
    return {
      ids,
      probe: {
        path: target.path,
        outcome: classifyGemini(res.status, body),
        status: res.status,
        latency_ms: Date.now() - started,
        detail: res.ok ? null : body.slice(0, 200),
        models: res.ok ? ids.length : null,
      },
    };
  } catch (err) {
    return {
      ids: [],
      probe: {
        path: target.path,
        outcome: 'unreachable',
        status: null,
        latency_ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
        models: null,
      },
    };
  }
}

/**
 * Срок пробы генерации. 20 с — столько же ждёт живой код (`callGemini`), и
 * проба 2 (20.11) кончилась на нём: «не ответила за 20 с» не отличает
 * медленный ответ от зависшего (слово владельца «карт-бланш» 21.11: замерить
 * с запасом). 40 с — вдвое больше срока живого кода; вместе с пробами
 * списка (до трёх по 10 с) и запасными моделями — под `maxDuration`.
 * Время ответа идёт в `latency_ms`, срок — в `timeout_ms`.
 */
export const GENERATE_PROBE_TIMEOUT_MS = 40_000;

/**
 * Запасные модели генерации (замер 5, 21.11): тогдашняя основная модель
 * живого кода (gemini-flash-latest) за четыре замера не ответила ни разу —
 * 20 с и 40 с без ответа, дважды 503 «перегружена». Отвечает ли через шлюз
 * хоть одна модель, одной моделью не узнать. Если основная не ответила, проба
 * пробует ещё до двух flash-моделей списка — закреплённых версий, без
 * скользящих алиасов и предварительных версий (`UNSTABLE_GEMINI_ID`),
 * сильнейших первыми. По замеру 6 (ответила закреплённая gemini-3.8-flash)
 * живой код сам берёт закреплённую модель (`pickGeminiModel`).
 */
export const GENERATE_ALT_MAX = 2;
export const GENERATE_ALT_TIMEOUT_MS = 20_000;

export function pickProbeAlternates(ids: readonly string[], primary: string): string[] {
  const flash = ids.filter((id) => /flash/i.test(id) && id !== primary && !UNSTABLE_GEMINI_ID.test(id));
  return classifyModels(flash).filter((m) => m.eligible).slice(0, GENERATE_ALT_MAX).map((m) => m.id);
}

async function probeGenerate(target: ProbeTarget, apiKey: string, model: string, timeoutMs = GENERATE_PROBE_TIMEOUT_MS) {
  const started = Date.now();
  try {
    const res = await fetch(geminiUrl(`models/${model}:generateContent`, target.endpoint), {
      method: 'POST',
      headers: geminiHeaders(apiKey, target.endpoint),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => '');
    return {
      path: target.path,
      model,
      timeout_ms: timeoutMs,
      outcome: classifyGemini(res.status, body),
      status: res.status,
      latency_ms: Date.now() - started,
      detail: res.ok ? null : body.slice(0, 200),
    };
  } catch (err) {
    return {
      path: target.path,
      model,
      timeout_ms: timeoutMs,
      outcome: 'unreachable' as const,
      status: null,
      latency_ms: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const key = keyIdentity(process.env.GEMINI_API_KEY);
  const current = geminiEndpoint();
  const gatewayBase = geminiGatewayBase(
    request.nextUrl.searchParams.get('account'),
    request.nextUrl.searchParams.get('gateway'),
  );

  const targets: ProbeTarget[] = [];
  if (gatewayBase) targets.push({ path: 'gateway', endpoint: geminiEndpoint(gatewayBase) });
  // Настройка прода — в замере, если она не совпадает с уже названными путями.
  if (current.via === 'gateway' && current.base !== gatewayBase) targets.push({ path: 'current', endpoint: current });
  targets.push({ path: 'direct', endpoint: geminiEndpoint(GEMINI_DIRECT_BASE) });
  // Какая часть адреса из настройки не та, что у шлюза пробы, — без значений.
  const currentVsGateway = current.via === 'gateway' ? gatewayBaseDiff(current.base, gatewayBase) : null;

  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
  if (!apiKey) {
    // Без ключа «дошли» от «не пустили» у Google не отличить: отказ ключа и
    // гео-отказ приходят одной формой. Мерить нечего — так и говорим.
    return NextResponse.json({
      ok: true,
      place: 'prod',
      key: { present: false, format: null, fingerprint: null },
      current_via: current.via,
      current_rejected: current.rejected,
      current_vs_gateway: currentVsGateway,
      gateway_probed: false,
      path_exists: null,
      open_paths: [],
      results: [],
      generate: null,
      note: 'GEMINI_API_KEY на проде не задан — путь не мерялся',
    });
  }

  const results: GeminiPathProbe[] = [];
  let firstOpen: { target: ProbeTarget; ids: string[] } | null = null;
  for (const target of targets) {
    // Последовательно: пробы делят один исходящий адрес.
    const { probe, ids } = await probeList(target, apiKey);
    results.push(probe);
    if (!firstOpen && probe.outcome === 'open') firstOpen = { target, ids };
  }

  const model = firstOpen ? pickProbeModel(firstOpen.ids) : null;
  const modelSource = process.env.GEMINI_MODEL?.trim() ? 'env' : 'list';
  const generate = firstOpen && model
    ? { ...(await probeGenerate(firstOpen.target, apiKey, model)), model_source: modelSource }
    : null;
  // Основная не ответила — запасные по очереди, до первой ответившей.
  const generateAlternates: Array<Awaited<ReturnType<typeof probeGenerate>>> = [];
  if (firstOpen && model && generate && generate.outcome !== 'open') {
    for (const alt of pickProbeAlternates(firstOpen.ids, model)) {
      const attempt = await probeGenerate(firstOpen.target, apiKey, alt, GENERATE_ALT_TIMEOUT_MS);
      generateAlternates.push(attempt);
      if (attempt.outcome === 'open') break;
    }
  }

  const open = results.filter((r) => OPEN_OUTCOMES.has(r.outcome));
  return NextResponse.json({
    ok: true,
    place: 'prod',
    key: { present: key.present, format: key.format, fingerprint: key.fingerprint },
    current_via: current.via,
    current_rejected: current.rejected,
    current_vs_gateway: currentVsGateway,
    gateway_probed: gatewayBase !== null,
    // Есть ли хоть один путь до Google. `null` — все пробы «не смог»: ответ «не знаю», а не «нет».
    path_exists: open.length > 0 ? true : results.every((r) => r.outcome === 'unreachable') ? null : false,
    open_paths: open.map((r) => r.path),
    results,
    generate,
    generate_alternates: generateAlternates,
  });
}
