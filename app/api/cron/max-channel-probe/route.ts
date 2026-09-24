/**
 * GET /api/cron/max-channel-probe — что лежит на публичной странице канала
 * КБГС в MAX (`https://max.ru/kbgsras`) и что классификатор СДЕЛАЛ БЫ из неё.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни UPDATE, ни INSERT — ни при каком аргументе. Сухой прогон
 * классификатора ничего не пишет: он возвращает, какая тревога родилась бы из
 * каждого текста, чтобы ложную тревогу цунами можно было увидеть до того, как
 * она уйдёт туристам.
 *
 * ── Зачем (24.09) ─────────────────────────────────────────────────────────
 *
 * Владелец: «бери цунами из MAX kbgsras». Писать приём вслепую нельзя:
 *
 *  1. Вид страницы неизвестен. Из контейнера разработки max.ru закрыт.
 *     Возможно, это витрина «откройте в приложении» без единого поста.
 *  2. Канал МЧС в MAX мы читаем так: строки длиннее 40 символов, дата —
 *     «сейчас». Для КБГС это значит: старый пост «Угроза цунами» с витрины
 *     стал бы СВЕЖЕЙ тревогой цунами для всех туристов.
 *
 * Правило приёма, которое будет написано по итогу этой пробы: угрозу
 * принимаем только из поста со СВОЕЙ датой и только свежего. Проба отвечает,
 * возможно ли это вообще: `dated_posts_total` — сколько постов с датой нашлось.
 *
 * Авторизация: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { censusMaxPage, MAX_KBGSRAS_URL } from '@/lib/services/safety/max-channel';
import { classifyMessage, tsunamiStatus } from '@/lib/services/safety/seismic-parser';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Маркер версии: по нему видно, та ли сборка отвечает (см. wait-for-deploy). */
const PROBE = 'max_channel_probe_v1';

/** Что родилось бы из текста. Только описание — ничего не записывается. */
function dryRun(text: string, at: string) {
  const e = classifyMessage('max.ru/kbgsras/probe', text, at);
  return {
    tsunami_status: tsunamiStatus(text),
    would_be: e ? { type: e.alert_type, severity: e.severity, title: e.title } : null,
  };
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetch(MAX_KBGSRAS_URL, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KamchatourBot/1.0)',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });
  } catch (e) {
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error('[max-channel-probe] запрос не дошёл:', why);
    // Не дошли — это НЕ «в канале тихо». Отказ отвечает отказом, чтобы прогон
    // покраснел, а не напечатал пустой список (урок сверки с OSM 20.09).
    return NextResponse.json({ success: false, probe: PROBE, url: MAX_KBGSRAS_URL, reachable: false, error: why.slice(0, 300) }, { status: 502 });
  }

  const body = await res.text();
  if (!res.ok || body.trim().length === 0) {
    return NextResponse.json({
      success: false,
      probe: PROBE,
      url: MAX_KBGSRAS_URL,
      reachable: true,
      http_status: res.status,
      final_url: res.url,
      bytes: body.length,
      error: !res.ok ? `HTTP ${res.status}` : 'HTTP 200 с пустым телом',
      body_head: body.slice(0, 1000),
    }, { status: 502 });
  }

  const census = censusMaxPage(body);
  const now = new Date().toISOString();

  return NextResponse.json({
    success: true,
    probe: PROBE,
    url: MAX_KBGSRAS_URL,
    reachable: true,
    http_status: res.status,
    // Куда увели редиректы: витрина приложения и канал — разные страницы.
    final_url: res.url,
    content_type: res.headers.get('content-type'),
    bytes: body.length,
    title: census.title,
    signals: census.signals,
    // Главное число пробы. Ноль — принимать угрозы из этой страницы нельзя:
    // датировать посты нечем, и старое стало бы свежим.
    dated_posts_total: census.datedPosts.length,
    dated_posts: census.datedPosts.slice(0, 20).map((p) => ({
      id: p.id,
      time: p.time,
      text: p.text.slice(0, 400),
      ...dryRun(p.text, p.time),
    })),
    // То, что видит раннер МЧС, — строки без дат. Сухой прогон с датой
    // «сейчас» показывает ровно ту тревогу, которую выпустил бы приём по
    // образцу МЧС. Если здесь есть tsunami_warning — это и есть ложная
    // тревога, от которой проба защищает.
    lines_total: census.lines.length,
    lines_dry_run_as_now: census.lines.map((line) => ({ text: line.slice(0, 300), ...dryRun(line, now) })),
    text_head: census.textHead,
  });
}
