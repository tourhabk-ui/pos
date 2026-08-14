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

  it('недоставка по ИСПРАВИМОЙ причине — КРИТ, а не «внимание»', () => {
    // Проверка написана 28.07 по случаю «VAPID keys not configured»: ключей
    // нет, цунами-предупреждения не уходят, и об этом никто не знает. Для
    // ТОГО случая она верна и сейчас — он по-прежнему КРИТ.
    //
    // Сузилась она из-за случая, найденного позже (02.08): подписчиков ноль.
    // Тогда «турист не получил предупреждение» тоже правда, но КРИТ висит,
    // пока запись не истечёт — до семи суток, — и погасить его нельзя ничем.
    // Красное, что не гаснет работой, приучает пролистывать; этот же сторож
    // носит SOS и мёртвый сейсмо-приём.
    //
    // Поэтому уровень теперь решает причина, а не тип: гарантия «недоставка
    // по исправимой причине — КРИТ» сохранена, а неисправимый случай выведен
    // в ВНИМАНИЕ. Разбор пустого канала — в watchdog-false-crit.
    expect(WATCHDOG).toMatch(/critical: true[\s\S]{0,300}Туристы не предупреждены/);
    expect(WATCHDOG).toMatch(/VAPID-ключи не заданы/);
  });

  it('критерий сторожа совпадает с критерием отправки в кроне', () => {
    expect(CRON).toContain("severity >= 2 OR alert_type IN ('tsunami_warning', 'road_closure')");
  });
});

/**
 * Тупик двух окон (найдено 31.07 на живых 11 алертах): диспетчер брал только
 * алерты моложе 2 часов, а сторож считал недоставленным всё за 7 суток.
 * Алерт, не доставленный за первые 2 часа (не было VAPID-ключей), выпадал из
 * выборки диспетчера НАВСЕГДА — починка ключей ничего не доставляла, сторож
 * кричал неделю о неисправимом. Плюс при нуле подписок total=0 проскакивал
 * мимо проверки недоставки, и push_sent_at ставился без единой доставки.
 */
describe('окно ретрая = срок действия алерта, не произвольные 2 часа', () => {
  const dispatchFn = () => CRON.slice(
    CRON.indexOf('async function dispatchPushAlerts'),
    CRON.indexOf('interface ParseResultSummary'),
  );

  it('диспетчер ретраит недоставленное, пока алерт действителен', () => {
    expect(dispatchFn(), 'вернулось 2-часовое окно — застрявшие алерты снова не доставятся')
      .toContain('expires_at > NOW()');
    expect(dispatchFn()).not.toContain("INTERVAL '2 hours'");
  });

  it('ноль подписок не помечает алерт доставленным', () => {
    expect(dispatchFn(), 'total=0 снова фиксирует push_sent_at без единой доставки')
      .toContain('if (result.total === 0) continue;');
    // Успешная доставка по-прежнему фиксируется — ретрай не вечный.
    expect(dispatchFn()).toContain('SET push_sent_at = NOW()');
  });

  it('сторож не кричит о неисправимом: истёкшие алерты выходят из счёта', () => {
    const fn = WATCHDOG.slice(
      WATCHDOG.indexOf('async function checkUndeliveredSafetyPush'),
      WATCHDOG.indexOf('async function checkPendingTransferBookings'),
    );
    expect(fn).toContain('expires_at > NOW()');
  });
});

describe('диагностика FIRMS в ответе крона', () => {
  it('configured отличает «нет ключа» от «нет термоточек»', () => {
    expect(CRON).toContain("configured: Boolean(process.env.FIRMS_MAP_KEY)");
    expect(CRON).toContain('hotspots: ingestResult.firms.rawItems ?? 0');
  });
});
