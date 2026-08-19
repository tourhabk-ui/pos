/**
 * Разведка потенциальных партнёров: сайты и Telegram-каналы (#66, фаза 1).
 *
 * Два пути доставки HTML — по той же причине, что у safety-ingest:
 *   POST { sites: [...], channels_html: [...] } — раннер GitHub Actions
 *         приносит уже скачанное. Обязателен для Telegram: t.me с Timeweb
 *         гео-закрыт, сервер его не откроет.
 *   POST { fetch_sites: ["https://..."] } — сервер тянет сайты сам. Обычные
 *         сайты операторов не заблокированы; если конкретный не открылся,
 *         это видно в ответе, а не проглатывается.
 *
 * Роут ТОЛЬКО разбирает и возвращает. В базу ничего не пишет: пока нет цифр
 * (сколько кандидатов, какого качества разбор), заводить таблицу рано —
 * правило «не усложнять раньше времени». Запись появится, когда владелец
 * посмотрит на первую выдачу.
 *
 * ПД: сюда попадают деловые контакты, опубликованные партнёром для связи.
 * Ответ роута идёт владельцу, а не в LLM. Перед любым обращением к модели
 * (текст письма — фаза 2) контакты обязаны пройти redactPII: D1-сканер это
 * проверяет и валит сборку, если забыть.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import {
  parseOperatorSite, parseTelegramChannel, prospectSize,
  type ProspectProfile, type TgChannelProfile,
} from '@/lib/partners/prospect-parse';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_HTML = 800_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH = 10;

const BodySchema = z.object({
  /** Сайты, скачанные раннером: [{url, html}]. */
  sites: z.array(z.object({
    url: z.string().url(),
    html: z.string().max(MAX_HTML),
  })).max(50).optional(),
  /** Веб-превью каналов, скачанные раннером: [{channel, html}]. */
  channels_html: z.array(z.object({
    channel: z.string().regex(/^[A-Za-z0-9_]{4,32}$/),
    html: z.string().max(MAX_HTML),
  })).max(50).optional(),
  /** Сайты, которые сервер тянет сам (t.me сюда передавать бессмысленно). */
  fetch_sites: z.array(z.string().url()).max(MAX_FETCH).optional(),
});

interface SiteResult {
  url: string;
  ok: boolean;
  error?: string;
  size?: ReturnType<typeof prospectSize>;
  profile?: ProspectProfile;
}

interface ChannelResult {
  channel: string;
  size: ReturnType<typeof prospectSize>;
  profile: TgChannelProfile;
}

const UA = 'Mozilla/5.0 (compatible; VedarProspect/1.0; +https://vedarai.ru/about)';

async function fetchSite(url: string): Promise<SiteResult> {
  // t.me сервером не тянем — гео-блок Timeweb. Честный отказ вместо
  // таймаута, который выглядел бы как «у партнёра нет канала».
  if (/(^|\/\/)(t\.me|telegram\.me)\//i.test(url)) {
    return { url, ok: false, error: 't.me недоступен с хостинга — присылайте html раннером (channels_html)' };
  }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) return { url, ok: false, error: `HTTP ${res.status}` };
    const html = (await res.text()).slice(0, MAX_HTML);
    const profile = parseOperatorSite(html);
    return { url, ok: true, profile, size: prospectSize(profile.activities) };
  } catch (err) {
    return { url, ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try { body = await request.json(); } catch { body = {}; }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Неверные параметры', details: parsed.error.issues[0]?.message },
      { status: 422 },
    );
  }

  const { sites = [], channels_html = [], fetch_sites = [] } = parsed.data;

  // Сайты из тела раннера — разбор без сети.
  const fromRunner: SiteResult[] = sites.map((s) => {
    const profile = parseOperatorSite(s.html);
    return { url: s.url, ok: true, profile, size: prospectSize(profile.activities) };
  });

  // Сайты, которые тянем сами. Последовательно: десяток чужих сайтов не
  // повод бить по ним залпом.
  const fetched: SiteResult[] = [];
  for (const url of fetch_sites) {
    fetched.push(await fetchSite(url));
  }

  const channels: ChannelResult[] = channels_html.map((c) => {
    const profile = parseTelegramChannel(c.html, c.channel);
    return { channel: c.channel, profile, size: prospectSize(profile.activities) };
  });

  const allSites = [...fromRunner, ...fetched];
  const small = [
    ...allSites.filter((s) => s.size === 'small'),
    ...channels.filter((c) => c.size === 'small'),
  ].length;

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    summary: {
      sites_parsed: allSites.filter((s) => s.ok).length,
      sites_failed: allSites.filter((s) => !s.ok).length,
      channels_parsed: channels.length,
      // Профиль владельца: одна-две активности.
      small_operators: small,
    },
    sites: allSites,
    channels,
    note: 'Разбор без записи в БД. Telegram — только публичное веб-превью t.me/s/<channel>, скачанное раннером.',
  });
}
