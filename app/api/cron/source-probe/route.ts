/**
 * GET /api/cron/source-probe — достижимы ли кандидаты в источники С ПРОДА.
 * Authorization: Bearer <CRON_SECRET>. READ-ONLY, ничего не пишет.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Подбор источников идёт с раннера GitHub, а он стоит ВНЕ РФ. Государственные
 * сайты часть зарубежных адресов не пускают, и на уровне сокета их отказ
 * неотличим от мёртвого хоста: `publication.pravo.gov.ru` — единственный
 * настоящий первоисточник права в подборе — дал с раннера сетевой сбой, и
 * сказать по нему «ленты нет» было бы подменой «не смог» на «плохо» (§4.0).
 *
 * Прод стоит в РФ. Для таких адресов он — вторая точка зрения, и только он
 * может отличить «нас туда не пускают» от «этого адреса не существует».
 *
 * ── Почему список зашит в код ──────────────────────────────────────────────
 *
 * Роут, который ходит по адресу ИЗ ПАРАМЕТРА, — это SSRF: сервер начинает
 * стучаться куда попросят, включая внутреннюю сеть Timeweb и служебные
 * адреса. Поэтому адреса перечислены здесь поимённо, а параметров у роута
 * нет вовсе. Нужен новый кандидат — он вносится правкой кода и проходит
 * ревью, как всякая правка.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Кандидаты, которых раннер проверить не смог. Список короткий намеренно:
 * это не «спросить интернет», а доспросить конкретные адреса из подбора.
 */
const CANDIDATES: ReadonlyArray<{ url: string; why: string }> = [
  { url: 'https://publication.pravo.gov.ru/', why: 'официальный портал правовой информации — корень, жив ли хост' },
  { url: 'https://publication.pravo.gov.ru/rss', why: 'предполагаемая лента портала: единственный первоисточник права в подборе' },
  { url: 'https://www.kscnet.ru/ivs/kvert/van/rss.php', why: 'KVERT — вулканические бюллетени (VONA у нас уже есть, лента была бы вторым путём)' },
];

interface ProbeResult {
  url: string;
  why: string;
  /** Что ответил сервер: код, либо null — не дошли вовсе. */
  status: number | null;
  content_type: string | null;
  bytes: number | null;
  /** Похоже ли тело на ленту: xml/rss/atom в типе или корневой тег. */
  looks_like_feed: boolean | null;
  /** Название беды словами, когда ответа нет. */
  error: string | null;
}

async function probe(c: { url: string; why: string }): Promise<ProbeResult> {
  const base: ProbeResult = {
    url: c.url, why: c.why,
    status: null, content_type: null, bytes: null, looks_like_feed: null, error: null,
  };
  try {
    const res = await fetch(c.url, {
      headers: { 'User-Agent': 'TourHab/1.0 (source probe)' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    const body = await res.text();
    const ct = res.headers.get('content-type');
    const head = body.slice(0, 400).toLowerCase();
    return {
      ...base,
      status: res.status,
      content_type: ct,
      bytes: body.length,
      looks_like_feed:
        (ct ?? '').toLowerCase().includes('xml')
        || head.includes('<rss') || head.includes('<feed') || head.includes('<rdf'),
    };
  } catch (err) {
    // Отказ называется вслух: молчащая проба неотличима от пройденной.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[source-probe] ${c.url}: ${message}`);
    return { ...base, error: message.slice(0, 160) };
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

  const results = await Promise.all(CANDIDATES.map(probe));

  return NextResponse.json({
    ok: true,
    probe: 'source_probe_v1',
    measured_at: new Date().toISOString(),
    vantage: 'prod',
    // Смысл замера — в сравнении с раннером, поэтому он назван прямо в ответе:
    // одно и то же «не ответил» с двух точек значит разное.
    note: 'Прод стоит в РФ. Ответ отсюда при отказе раннеру означает гео-блок, а не отсутствие ленты; отказ с обеих точек — что адреса, скорее всего, нет.',
    results,
  });
}
