/**
 * GET /api/cron/trip-reminders — обстановка на день выезда, за двое суток (#2969).
 *
 * Запускает `cron-trip-reminders.yml` ежедневно в 05:00 UTC (17:00 по
 * Камчатке), до напоминания за сутки (06:00 UTC), которое читает ту же
 * записанную обстановку.
 *
 * До 03.11 этот крон слал туристу «послезавтра твой тур» с ТЕКУЩЕЙ погодой
 * Петропавловска (wttr.in) под словом «Прогноз», выбирал туристов по почте
 * брони вместо аккаунта, считал «послезавтра» по UTC и глушил отказ доставки
 * пустым catch. Теперь:
 *  1. на завтра и послезавтра (по Камчатке) для каждого тура с бронями или
 *     заявками считается обстановка (`lib/trips/situation`) — погода по
 *     координатам тура, официальные предупреждения по зоне, опасность зоны —
 *     и записывается в `trip_situations`: её видит оператор в «Сегодня»;
 *  2. туристу на послезавтра — ТОЛЬКО при риске (решение по #2969):
 *     «спокойно» и «не смог проверить» туристу не шлются; повтор — только
 *     при изменении обстановки;
 *  3. оператору — при риске, по выезду, без ПД; решение за ним;
 *  4. всё, что ушло или не ушло, — в `trip_situation_notices` с причиной.
 * Ведар ничего не отменяет и не переносит.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';
import { tgSend } from '@/lib/notifications/tg-send';
import { maxSendDm } from '@/lib/notifications/max-channel';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { reachForPartner } from '@/lib/partners/reach';
import { escapeHtml } from '@/lib/text/escape-html';
import {
  operatorSituationText, situationFingerprint, touristSituationText, type Situation,
} from '@/lib/trips/situation';
import {
  lastSentFingerprint, liveSources, loadDepartingTours, loadTouristRecipients, logNotice,
  saveSituation, situationFor, type DepartingTour, type SituationSources, type TouristRecipient,
} from '@/lib/trips/situation-store';

export const dynamic = 'force-dynamic';

const AGENT_ID = 'trip-reminders';
const sqlState = (err: unknown) => (err as { code?: string })?.code ?? 'нет SQLSTATE';

async function sendTourist(r: TouristRecipient, text: string): Promise<{ ok: boolean; channel: string; reason?: string }> {
  if (!r.chatId || !r.channel) return { ok: false, channel: 'none', reason: 'нет канала' };
  if (r.channel === 'max') {
    const res = await maxSendDm(r.chatId, escapeHtml(text));
    return res.ok ? { ok: true, channel: 'max' } : { ok: false, channel: 'max', reason: res.error ?? 'MAX не принял' };
  }
  const res = await tgSend('trip-situation', escapeHtml(text), { chatId: r.chatId });
  return res.ok ? { ok: true, channel: 'telegram' } : { ok: false, channel: 'telegram', reason: res.reason };
}

async function sendOperator(operatorId: string, text: string): Promise<{ ok: boolean; channel: string; reason?: string }> {
  const reach = await reachForPartner(operatorId);
  if (reach === null) return { ok: false, channel: 'none', reason: 'адрес оператора не прочитался' };
  if (!reach.reachable) return { ok: false, channel: 'none', reason: 'нет канала' };
  const html = escapeHtml(text);
  // ПД в строке нет — текст для MAX и Telegram один; адресат строгий, без
  // отката на рабочий чат платформы.
  const res = await sendPdAlert({ text: html, stub: html, to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId } });
  if (res.channel === 'max' && res.delivered) return { ok: true, channel: 'max' };
  if (res.channel === 'telegram-stub') return { ok: true, channel: 'telegram' };
  return { ok: false, channel: res.channel, reason: res.reason };
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const t0 = Date.now();
  const today = kamchatkaDate(new Date());
  const tomorrow = shiftDate(today, 1);
  const target = shiftDate(today, 2);

  let tours: DepartingTour[];
  try {
    tours = await loadDepartingTours([tomorrow, target]);
  } catch (err) {
    console.error('[trip-situation] выезды не прочитались, SQLSTATE', sqlState(err));
    recordCronRun(AGENT_ID, t0, 'failed', { error: `выезды: ${sqlState(err)}` });
    return NextResponse.json({ success: false, error: 'Выезды на завтра и послезавтра не прочитались' }, { status: 500 });
  }

  const src: SituationSources = liveSources();
  const situations = new Map<string, Situation>();
  const saveFailed: string[] = [];
  for (const tour of tours) {
    const s = await situationFor(tour, src);
    situations.set(`${tour.tourId}|${tour.date}`, s);
    try {
      await saveSituation(tour.tourId, tour.date, s);
    } catch (err) {
      console.error('[trip-situation] обстановка не записалась, тур', tour.tourId, tour.date, sqlState(err));
      saveFailed.push(`${tour.tourId}/${tour.date}`);
    }
  }

  const counts = { tourists_sent: 0, tourists_failed: 0, no_channel: 0, not_risk: 0, unchanged: 0, operators_sent: 0, operators_failed: 0 };
  let recipients: TouristRecipient[] = [];
  let recipientsFailed = false;
  try {
    recipients = await loadTouristRecipients(target);
  } catch (err) {
    recipientsFailed = true;
    console.error('[trip-situation] туристы на послезавтра не прочитались, SQLSTATE', sqlState(err));
  }

  const byTour = new Map(tours.filter((t) => t.date === target).map((t) => [t.tourId, t]));
  const informed = new Map<number, number>();
  for (const r of recipients) {
    const tour = byTour.get(r.tourId);
    const s = situations.get(`${r.tourId}|${target}`);
    if (!tour || !s) continue;
    const fp = situationFingerprint(s);
    try {
      if (s.kind !== 'risk') {
        counts.not_risk++;
        await logNotice({ kind: r.kind, ref: r.ref, tourId: r.tourId, date: target, fingerprint: fp, outcome: 'not_risk' });
        continue;
      }
      if (!r.channel) {
        counts.no_channel++;
        await logNotice({ kind: r.kind, ref: r.ref, tourId: r.tourId, date: target, fingerprint: fp, outcome: 'no_channel', reason: 'нет канала туриста' });
        continue;
      }
      if (await lastSentFingerprint(r.kind, r.ref, target) === fp) {
        counts.unchanged++;
        await logNotice({ kind: r.kind, ref: r.ref, tourId: r.tourId, date: target, fingerprint: fp, outcome: 'unchanged', channel: r.channel });
        continue;
      }
      const sent = await sendTourist(r, touristSituationText({ tourTitle: tour.title, date: target, situation: s }));
      if (sent.ok) { counts.tourists_sent++; informed.set(r.tourId, (informed.get(r.tourId) ?? 0) + 1); } else counts.tourists_failed++;
      if (!sent.ok) console.error('[trip-situation] туристу не доставлено:', r.kind, r.ref, sent.reason);
      await logNotice({ kind: r.kind, ref: r.ref, tourId: r.tourId, date: target, fingerprint: fp, outcome: sent.ok ? 'sent' : 'failed', channel: sent.channel, reason: sent.reason });
    } catch (err) {
      counts.tourists_failed++;
      console.error('[trip-situation] отправка туристу упала:', r.kind, r.ref, err instanceof Error ? err.message : err);
    }
  }

  for (const tour of byTour.values()) {
    const s = situations.get(`${tour.tourId}|${target}`);
    if (!s || s.kind !== 'risk') continue;
    const fp = situationFingerprint(s);
    const ref = `${tour.operatorId}:${tour.tourId}`;
    try {
      if (await lastSentFingerprint('operator', ref, target) === fp) {
        await logNotice({ kind: 'operator', ref, tourId: tour.tourId, date: target, fingerprint: fp, outcome: 'unchanged' });
        continue;
      }
      const sent = await sendOperator(tour.operatorId, operatorSituationText({
        tourTitle: tour.title, date: target, situation: s, travellers: tour.travellers, touristsInformed: informed.get(tour.tourId) ?? 0,
      }));
      if (sent.ok) counts.operators_sent++; else counts.operators_failed++;
      if (!sent.ok) console.error('[trip-situation] оператору не доставлено:', tour.operatorId, tour.tourId, sent.reason);
      await logNotice({
        kind: 'operator', ref, tourId: tour.tourId, date: target, fingerprint: fp,
        outcome: sent.ok ? 'sent' : sent.reason === 'нет канала' ? 'no_channel' : 'failed', channel: sent.channel, reason: sent.reason,
      });
    } catch (err) {
      counts.operators_failed++;
      console.error('[trip-situation] отправка оператору упала:', tour.tourId, err instanceof Error ? err.message : err);
    }
  }

  const kinds = { calm: 0, risk: 0, unknown: 0 };
  for (const s of situations.values()) kinds[s.kind]++;
  const problems = [
    saveFailed.length ? `не записано обстановок: ${saveFailed.length}` : null,
    recipientsFailed ? 'туристы не прочитались' : null,
    counts.tourists_failed ? `туристам не доставлено: ${counts.tourists_failed}` : null,
    counts.operators_failed ? `операторам не доставлено: ${counts.operators_failed}` : null,
  ].filter((x): x is string => x !== null);
  // Выезды были, а ни одной обстановки не записалось — отказ, а не успех (§4.0).
  const status = tours.length > 0 && saveFailed.length === tours.length ? 'failed' : problems.length ? 'partial' : 'success';
  recordCronRun(AGENT_ID, t0, status, { items: tours.length, error: problems.join('; ') || undefined, metadata: { kinds, ...counts } });

  return NextResponse.json({
    success: status !== 'failed',
    dates: { tomorrow, target },
    tours: tours.length,
    situations: kinds,
    ...counts,
    problems,
  }, { status: status === 'failed' ? 500 : 200 });
}
