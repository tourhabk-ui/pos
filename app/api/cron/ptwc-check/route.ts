/**
 * GET /api/cron/ptwc-check — сверка с PTWC (тихоокеанский центр цунами, NWS):
 * считает ли он волну у берегов края возможной, пока в НАШЕЙ ленте
 * официальной тревоги цунами нет.
 *
 * Правило одно и без исключений: роут НИЧЕГО не пишет в `external_alerts`.
 * Он не ставит `tsunami_warning`, не снимает её и не понижает — официальная
 * тревога для края идёт от МЧС/КФ ЕГС через safety-ingest. PTWC здесь —
 * второй свидетель: расхождение «PTWC видит угрозу точкам края, лента молчит»
 * уходит дежурному в Telegram и в журнал решений (`source_observed`), один раз
 * на бюллетень. Турист PTWC не видит; молчание PTWC ничего не значит
 * (карт-бланш владельца 29.10, lib/services/safety/ptwc).
 *
 * Зовут: супервизор start.js (каждые 30 мин) и cron-safety-heartbeat.yml,
 * оба с Bearer CRON_SECRET; аренда окна 30 мин — tsunami.gov не спрашивают
 * дважды. Три исхода прогона (§4.0): прочитан и сверен; прочитан, бюллетень
 * старый; не прочитан — 502 с причиной, здоровье источника `error`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { recordSourceHealth, SAFETY_SOURCE_EXPECTATIONS } from '@/lib/services/safety/source-health';
import { appendSafetyEvent, hashPayload } from '@/lib/safety/ledger';
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';
import {
  loadPtwcLatest, etaLineRu, utcAndKamchatka, PTWC_BAND_WORDS, type PtwcRead,
} from '@/lib/services/safety/ptwc';

export const dynamic = 'force-dynamic';

const AGENT_ID = 'ptwc-check';
const WINDOW_MIN = 30;
/** Ключ и подпись источника — из ожиданий здоровья, чтобы не разойтись с ними. */
const SOURCE = (() => {
  const exp = SAFETY_SOURCE_EXPECTATIONS.find((e) => e.key === 'ptwc');
  return { key: 'ptwc', label: exp?.label ?? 'PTWC — тихоокеанский центр цунами (tsunami.gov)' } as const;
})();

type OfficialTsunami = 'live' | 'none' | 'unknown';

/**
 * Есть ли в ленте действующая официальная тревога цунами. Бессрочная
 * (`expires_at IS NULL`) — действует, как читают её уборщик и переписи.
 * Отказ базы — `unknown`, не «нет».
 */
async function officialTsunamiAlert(): Promise<OfficialTsunami> {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM external_alerts
        WHERE alert_type = 'tsunami_warning'
          AND (expires_at IS NULL OR expires_at > ${UTC_WALL_NOW_SQL})
        LIMIT 1`,
    );
    return rows.length > 0 ? 'live' : 'none';
  } catch (err) {
    console.error('[ptwc-check] лента тревог не прочитана:', err instanceof Error ? err.message : err);
    return 'unknown';
  }
}

/** Этот бюллетень уже записан в журнал — второй раз дежурного не будим. */
async function alreadyNoted(payloadHash: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM safety_decision_events WHERE payload_hash = $1 AND actor_id = 'ptwc' LIMIT 1`,
      [payloadHash],
    );
    return rows.length > 0;
  } catch (err) {
    // Не смогли проверить — лучше разбудить дважды, чем ни разу.
    console.error('[ptwc-check] журнал не прочитан:', err instanceof Error ? err.message : err);
    return false;
  }
}

function dutyText(read: Extract<PtwcRead, { kind: 'ok' }>, official: OfficialTsunami): string {
  const { index, message } = read;
  const m = message!;
  const when = utcAndKamchatka(m.issuedAt ?? index.issuedAt);
  const band = m.russiaBand ? `Высота у берегов России по PTWC: ${PTWC_BAND_WORDS[m.russiaBand]}.`
    : m.russiaPreliminary ? 'Предварительно: опасные волны у берегов России возможны, высоты ещё не посчитаны.'
      : 'Россия в полосах высот не названа.';
  const lines = [
    `PTWC (Гонолулу): угроза цунами точкам Камчатки — сообщение №${m.messageNumber ?? '?'} от ${when}.`,
    `Землетрясение M${m.magnitude ?? index.magnitude ?? '?'}, ${m.location ?? index.location ?? 'место не разобрано'}.`,
    band,
    `Расчётный приход волны: ${m.kraiPoints.map(etaLineRu).join('; ')}.`,
    official === 'none'
      ? 'В нашей ленте официальной тревоги цунами НЕТ — проверь МЧС и КФ ЕГС.'
      : 'Нашу ленту прочитать не удалось — есть ли официальная тревога, неизвестно; проверь МЧС и КФ ЕГС.',
    `Это международное сообщение для национальных властей, не замена официальной тревоги. ${index.messageUrl}`,
  ];
  return lines.join('\n');
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const lease = await claimCronWindow(AGENT_ID, WINDOW_MIN, 'external');
  if (!shouldRun(lease)) return NextResponse.json(leaseSkipBody(AGENT_ID, WINDOW_MIN));

  const startedAt = Date.now();
  const read = await loadPtwcLatest();

  if (read.kind === 'failed') {
    await recordSourceHealth(pool, [{ ...SOURCE, status: 'error', rawItems: 0, inserted: 0, aliveBy: 'raw_items', error: read.reason }])
      .catch((err: unknown) => console.error('[ptwc-check] здоровье источника не записано:', err instanceof Error ? err.message : err));
    const message = `PTWC не прочитан: ${read.reason}`;
    recordCronRun(AGENT_ID, startedAt, 'failed', { error: message });
    return NextResponse.json({ success: false, error: message, bulletin: read.index }, { status: 502 });
  }

  await recordSourceHealth(pool, [{ ...SOURCE, status: 'ok', rawItems: 1, inserted: 0, aliveBy: 'raw_items' }])
    .catch((err: unknown) => console.error('[ptwc-check] здоровье источника не записано:', err instanceof Error ? err.message : err));

  const { index, message, verdict } = read;
  let official: OfficialTsunami | null = null;
  let alerted: 'sent' | 'already_noted' | 'official_live' | 'not_sent' | null = null;

  if (verdict === 'threat_to_krai' && message) {
    official = await officialTsunamiAlert();
    if (official === 'live') {
      alerted = 'official_live';
    } else {
      const bulletinKey = { source: 'ptwc', event: index.twcEventId, bulletin: index.bulletinNr };
      const payloadHash = hashPayload(bulletinKey);
      if (await alreadyNoted(payloadHash)) {
        alerted = 'already_noted';
      } else {
        const delivery = await tgSend(AGENT_ID, escapeHtml(dutyText(read, official)));
        alerted = delivery.ok ? 'sent' : 'not_sent';
        if (!delivery.ok) console.error('[ptwc-check] дежурный не разбужен:', delivery.reason);
        // Журнал — только по доставке: недоставленное не считается «уже замечено».
        if (delivery.ok) {
          await appendSafetyEvent({
            entityId: null,
            eventType: 'source_observed',
            actorType: 'source',
            actorId: 'ptwc',
            sourceUrl: index.messageUrl,
            sourcePublishedAt: message.issuedAt ? new Date(message.issuedAt) : null,
            payloadHash,
            decisionReason: official === 'none'
              ? 'PTWC видит угрозу точкам края, официальной тревоги в ленте нет — дежурный разбужен'
              : 'PTWC видит угрозу точкам края, ленту прочитать не удалось — дежурный разбужен',
            details: {
              ...bulletinKey,
              message_number: message.messageNumber,
              magnitude: message.magnitude ?? index.magnitude,
              location: message.location ?? index.location,
              russia_band: message.russiaBand,
              krai_points: message.kraiPoints,
              official_alert: official,
            },
          });
        }
      }
    }
  }

  recordCronRun(AGENT_ID, startedAt, 'success', { items: message?.kraiPoints.length ?? 0 });
  return NextResponse.json({
    success: true,
    verdict,
    bulletin: {
      event: index.twcEventId, nr: index.bulletinNr, issued_at: index.issuedAt,
      magnitude: index.magnitude, location: index.location, url: index.messageUrl,
    },
    message: message ? {
      kind: message.kind, number: message.messageNumber, threat_passed: message.threatPassed,
      russia_band: message.russiaBand, krai_points: message.kraiPoints, etas_total: message.etas.length,
    } : null,
    official_alert: official,
    duty_alert: alerted,
  });
}
