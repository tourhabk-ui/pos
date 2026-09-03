/**
 * GET /api/cron/scout-relay-check
 * Authorization: Bearer <CRON_SECRET>
 *
 * Отвечает на ОДИН вопрос: работает ли с ПРОДА реле разведчика
 * (SCOUT_RELAY_BASE → воркер Cloudflare infra/safety-relay, маршрут /fetch).
 *
 * ЗАЧЕМ. Владелец 03.09 правит SCOUT_RELAY_BASE в панели Timeweb, и до этой
 * пробы единственный способ узнать, сошлось ли, — дождаться суточного
 * прогона дайджеста (07:00 UTC) и прочитать его отчёт. Дайджест при этом
 * зовёт модель и публикует в Telegram — гонять его ради проверки адреса
 * нельзя. Здесь — только чтение: ни модели, ни публикации, ни записи в БД.
 *
 * ЧТО МЕРЯЕТСЯ. Источники рода telegram из RSS_SOURCES (превью t.me/s/):
 * с прода t.me закрыт, поэтому они живут ТОЛЬКО на реле — если реле
 * читает их, оно работает. По каждому: статус прямого запроса (чтобы было
 * видно, что без реле не обойтись) и исход через реле.
 *
 * ИСХОДЫ РЕЛЕ — НЕ ДВА (§4.0). 401 — воркер не принял секрет: CRON_SECRET
 * на Timeweb и секрет воркера РАЗНЫЕ. 403 с нашим текстом — хост не в
 * RELAY_HOSTS. Ответ без заголовка x-relay-upstream-status — отвечал не наш
 * воркер (адрес ведёт не туда). Заголовок есть — это ответ ИСТОЧНИКА через
 * реле. Сетевой отказ — «не смог», а не «сломано».
 *
 * SSRF. Адреса не берутся из запроса: читаются только источники из
 * RSS_SOURCES, база реле — из окружения.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { RSS_SOURCES, type ScoutSource } from '@/lib/agents/scout-digest';
import { parseTelegramPreview } from '@/lib/agents/scout-telegram';
import {
  relayBase, relayBaseProblem, relayFetchUrl, relayHeaders, relayStatus, type RelayStatus,
} from '@/lib/agents/scout-relay';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export type RelayOutcome =
  | 'ok'                  // источник прочитан через реле, посты разобраны
  | 'empty'               // прочитан, но разбор дал ноль постов (сменилась разметка?)
  | 'relay_unauthorized'  // 401: воркер не принял секрет — CRON_SECRET расходится с секретом воркера
  | 'relay_host_refused'  // 403 от самого воркера: хост не в RELAY_HOSTS
  | 'not_relay'           // ответил не наш воркер: адрес ведёт не туда
  | 'upstream_http'       // воркер дошёл до источника, источник ответил не 2xx
  | 'unreachable';        // сетевой отказ — «не смог», не «сломано»

export interface SourceProbe {
  key: string;
  url: string;
  direct_status: number | null;
  relay: RelayOutcome;
  relay_status: number | null;
  upstream_status: number | null;
  bytes: number | null;
  posts: number | null;
  detail: string | null;
}

/**
 * Исход ответа реле по его форме (чистая). Ответ САМОГО воркера узнаётся
 * по заголовку x-relay-upstream-status: без него отвечал кто-то другой —
 * страница Cloudflare, чужой воркер, или адрес вовсе не workers.dev.
 */
export function classifyRelayResponse(
  status: number,
  upstreamHeader: string | null,
  body: string,
  posts: number,
): RelayOutcome {
  if (status === 401) return 'relay_unauthorized';
  if (status === 403 && /RELAY_HOSTS/.test(body)) return 'relay_host_refused';
  if (upstreamHeader === null) return 'not_relay';
  if (status >= 200 && status < 300) return posts > 0 ? 'ok' : 'empty';
  return 'upstream_http';
}

export type Verdict = 'works' | 'broken' | 'not_configured' | 'unknown';

/**
 * Вердикт по всем источникам (чистая). 'works' — хоть один прочитан;
 * 'broken' — хоть один ответ реле есть и ни один не прочитан; 'unknown' —
 * все «не смог»: сказать нечего, и это не «сломано».
 */
export function verdict(relay: RelayStatus, probes: SourceProbe[]): Verdict {
  if (relay !== 'on') return 'not_configured';
  if (probes.some((p) => p.relay === 'ok')) return 'works';
  if (probes.every((p) => p.relay === 'unreachable')) return 'unknown';
  return 'broken';
}

async function directStatus(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TourHab/1.0 (Scout Relay Check)' },
      signal: AbortSignal.timeout(6_000),
    });
    // Тело не нужно: меряется только «пустили ли с прода».
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

async function probeSource(s: ScoutSource): Promise<SourceProbe> {
  const direct = await directStatus(s.url);
  const base: Omit<SourceProbe, 'relay' | 'relay_status' | 'upstream_status' | 'bytes' | 'posts' | 'detail'> = {
    key: s.key,
    url: s.url,
    direct_status: direct,
  };
  try {
    const res = await fetch(relayFetchUrl(relayBase(), s.url), {
      headers: { ...relayHeaders(), 'User-Agent': 'TourHab/1.0 (Scout Relay Check)' },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => '');
    const upstream = res.headers.get('x-relay-upstream-status');
    const posts = res.ok ? parseTelegramPreview(text, s.label).length : 0;
    const relay = classifyRelayResponse(res.status, upstream, text, posts);
    return {
      ...base,
      relay,
      relay_status: res.status,
      upstream_status: upstream !== null && /^\d+$/.test(upstream) ? Number(upstream) : null,
      bytes: text.length,
      posts: res.ok ? posts : null,
      detail: relay === 'ok' ? null : text.slice(0, 160),
    };
  } catch (err) {
    return {
      ...base,
      relay: 'unreachable',
      relay_status: null,
      upstream_status: null,
      bytes: null,
      posts: null,
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

  const relay = relayStatus();
  const sources = RSS_SOURCES.filter((s) => s.kind === 'telegram');
  const probes: SourceProbe[] = [];
  if (relay === 'on') {
    for (const s of sources) {
      // Последовательно: пробы делят один исходящий адрес и один воркер.
      probes.push(await probeSource(s));
    }
  }

  return NextResponse.json({
    ok: true,
    probe: 'scout_relay_check_v1',
    place: 'prod',
    relay,
    // Чем плох адрес — словами (см. relayBaseProblem); null — адрес в порядке
    // или не задан вовсе.
    relay_detail: relayBaseProblem(),
    relay_base_set: relayBase().length > 0,
    verdict: verdict(relay, probes),
    sources_probed: probes.length,
    probes,
  });
}
