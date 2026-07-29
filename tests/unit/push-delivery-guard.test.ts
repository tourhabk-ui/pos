/**
 * Сторож недоставленных safety-пушей + диагностика FIRMS.
 *
 * Найдено на живом проде 28.07 (ответ крона safety-ingest):
 *   "errors":["VAPID keys not configured — push skipped"]
 * Цунами-предупреждения, пожары и дорожные ограничения НЕ доставлялись
 * туристам, и об этом не знал никто: dispatchPushAlerts кладёт причину в
 * тело ответа крона, а тело читает только тот, кто откроет лог прогона.
 *
 * Молчаливая деградация safety-функции — ровно тот класс, который платформа
 * лечит детерминированным сторожем, а не надеждой посмотреть логи.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const WATCHDOG = read('lib/agents/watchdog.ts');
const CRON = read('app/api/cron/safety-ingest/route.ts');

describe('watchdog сторожит доставку safety-пушей', () => {
  it('проверка существует и включена в прогон', () => {
    expect(WATCHDOG).toContain('checkUndeliveredSafetyPush');
    expect(WATCHDOG).toContain("'push_undelivered'");
    const runBlock = WATCHDOG.slice(WATCHDOG.indexOf('export async function runWatchdog'));
    expect(runBlock).toContain('checkUndeliveredSafetyPush()');
    expect(runBlock).toContain('pushUndelivered');
  });

  it('ловит факт недоставки, а не конкретную причину (VAPID/подписки/отказ)', () => {
    const fn = WATCHDOG.slice(
      WATCHDOG.indexOf('async function checkUndeliveredSafetyPush'),
      WATCHDOG.indexOf('async function checkPendingTransferBookings'),
    );
    expect(fn).toContain('push_sent_at IS NULL');
    expect(fn).toContain("INTERVAL '30 minutes'");
    // Те же типы, что подлежат рассылке в кроне — иначе сторож и отправитель
    // разойдутся, и «недоставленным» будет считаться то, что и не слалось.
    expect(fn).toContain("severity >= 2 OR alert_type IN ('tsunami_warning', 'road_closure')");
    // Окно 7 дней: древние алерты не держат алерт вечно.
    expect(fn).toContain("INTERVAL '7 days'");
  });

  it('это КРИТ, а не «внимание»: турист не получил предупреждение', () => {
    expect(WATCHDOG).toContain("a.type === 'push_undelivered' ? 'КРИТ:'");
  });

  it('критерий сторожа совпадает с критерием отправки в кроне', () => {
    expect(CRON).toContain("severity >= 2 OR alert_type IN ('tsunami_warning', 'road_closure')");
  });
});

describe('диагностика FIRMS в ответе крона', () => {
  it('configured отличает «нет ключа» от «нет термоточек»', () => {
    expect(CRON).toContain("configured: Boolean(process.env.FIRMS_MAP_KEY)");
    expect(CRON).toContain('hotspots: ingestResult.firms.rawItems ?? 0');
  });
});
