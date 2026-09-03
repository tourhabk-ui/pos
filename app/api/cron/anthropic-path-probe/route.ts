/**
 * GET /api/cron/anthropic-path-probe?account=<hex32>&gateway=vedar-ai
 * Authorization: Bearer <CRON_SECRET>
 *
 * Отвечает на ОДИН вопрос: по какому сетевому пути ПРОД (Timeweb, РФ)
 * достаёт api.anthropic.com. Зовёт его anthropic-path-probe.yml с раннера.
 *
 * ЗАЧЕМ. Гео-блок Anthropic закрывает прямой путь из РФ, и с 23.08 записано
 * (infra/ai-relay/worker.js), что Cloudflare Worker его не обходит: у
 * апстрима за Cloudflare виден исходный клиент. Но это замер ОДНОГО пути.
 * Cloudflare AI Gateway — другой продукт: запрос к Anthropic делает сама
 * инфраструктура Cloudflare как первая сторона, не субзапрос воркера.
 * Работает ли это с прода — рассуждением не решить, только замером (§4.0).
 *
 * ПОЧЕМУ ПРОБА, А НЕ ПЕРЕМЕННАЯ. `ANTHROPIC_BASE_URL` живёт в панели Timeweb
 * и меняется руками владельца; переставлять её наугад, а потом смотреть на
 * здоровье — это сутки на один вариант. Проба отвечает за один вызов.
 *
 * ТРИ ИСХОДА НА ПУТЬ, НЕ ДВА. 200 — путь открыт и ключ прода жив. 401 —
 * путь ОТКРЫТ (до Anthropic дошли), ключа на проде нет или он не тот; это
 * ответ про путь, а не провал. 403 — блокировка. Сетевой отказ — «не смог»,
 * не «заблокирован». Без ключа проба всё равно идёт: 401 и 403 различимы,
 * и различие в них — вся суть замера.
 *
 * SSRF. Адрес кандидата НЕ берётся из запроса строкой. Хост шлюза — литерал;
 * из запроса приходят только id аккаунта (32 hex, пересобирается через
 * BigInt — строка снаружи в адрес не попадает) и имя шлюза (ключ фиксированной
 * таблицы). Иначе проба с секретом прода стала бы прокси на что угодно.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const GATEWAY_HOST = 'https://gateway.ai.cloudflare.com';
const DIRECT = 'https://api.anthropic.com';

/** Шлюзы, которые проба знает по имени. Значение — литерал, не ввод. */
const GATEWAYS: Readonly<Record<string, string>> = {
  'vedar-ai': 'vedar-ai',
};

export type PathOutcome =
  | 'open'          // 200: дошли и ответили
  | 'open_no_key'   // 401: дошли до Anthropic, ключ прода отсутствует или не тот
  | 'blocked'       // 403: отказ по политике (гео-блок и подобное)
  | 'http'          // иной HTTP-код
  | 'unreachable';  // сетевой отказ — «не смог», а не «заблокирован»

export interface PathProbe {
  base: string;
  outcome: PathOutcome;
  status: number | null;
  latency_ms: number | null;
  detail: string | null;
}

/**
 * Адрес шлюза из проверенных частей. `null` — части не прошли проверку;
 * это отказ собрать адрес, а не «шлюза нет».
 */
export function gatewayBase(accountRaw: string | null, gatewayRaw: string | null): string | null {
  if (!accountRaw || !gatewayRaw) return null;
  if (!/^[0-9a-f]{32}$/.test(accountRaw)) return null;
  // Пересборка через число: в адрес уходит не строка запроса, а её значение.
  const account = BigInt(`0x${accountRaw}`).toString(16).padStart(32, '0');
  const gateway = Object.prototype.hasOwnProperty.call(GATEWAYS, gatewayRaw) ? GATEWAYS[gatewayRaw] : null;
  if (!gateway) return null;
  return new URL(`/v1/${account}/${gateway}/anthropic`, GATEWAY_HOST).toString().replace(/\/+$/, '');
}

export function classify(status: number): PathOutcome {
  if (status >= 200 && status < 300) return 'open';
  if (status === 401) return 'open_no_key';
  if (status === 403) return 'blocked';
  return 'http';
}

async function probeOne(base: string, apiKey: string | null): Promise<PathProbe> {
  const url = `${base}/v1/messages`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Без ключа шлём заведомо пустой: 401 «дошли» против 403 «не пустили»
        // различимы и так, а именно это различие проба и меряет.
        'x-api-key': apiKey ?? 'absent',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text().catch(() => '');
    return {
      base,
      outcome: classify(res.status),
      status: res.status,
      latency_ms: Date.now() - started,
      detail: res.ok ? null : body.slice(0, 160),
    };
  } catch (err) {
    return {
      base,
      outcome: 'unreachable',
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

  const gw = gatewayBase(request.nextUrl.searchParams.get('account'), request.nextUrl.searchParams.get('gateway'));
  const current = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, '') ?? null;
  const bases = Array.from(new Set([
    ...(gw ? [gw] : []),
    // Текущая настройка прода — всегда в замере, чтобы было с чем сравнить.
    ...(current ? [current] : []),
    DIRECT,
  ]));

  const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
  const results: PathProbe[] = [];
  for (const base of bases) {
    // Последовательно, не параллельно: пробы делят один исходящий адрес,
    // и одновременные отказы одного апстрима замазали бы картину.
    results.push(await probeOne(base, apiKey));
  }

  const open = results.filter((r) => r.outcome === 'open' || r.outcome === 'open_no_key');
  return NextResponse.json({
    ok: true,
    place: 'prod',
    key_present: apiKey !== null,
    current_base: current,
    gateway_probed: gw !== null,
    // Есть ли ХОТЬ ОДИН путь, по которому прод достаёт Anthropic. `null` —
    // если ни одна проба не дала ни открытого, ни закрытого ответа (все
    // «не смог»): тогда ответ на вопрос — «не знаю», а не «нет».
    path_exists: open.length > 0 ? true : results.every((r) => r.outcome === 'unreachable') ? null : false,
    open_bases: open.map((r) => r.base),
    results,
  });
}
