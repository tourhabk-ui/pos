/**
 * Тревога считается отправленной только если Telegram ответил.
 *
 * Правило вывел Watchdog 30.08: до того у него стоял `catch { // Silent
 * fail }`, ответ не читался, и тревога могла собраться и не уйти при зелёном
 * прогоне. Сторож без исправного рупора неотличим от сторожа, которому не о
 * чем доложить.
 *
 * Находка аудита 08.09: правило осталось жить в ОДНОМ файле. Евалы Кузьмича
 * писали `alerts_sent: alertText !== null` — то есть «мы решили тревожить»
 * выдавалось за «доставлено», — а сканер противоречий о безопасности слал
 * `.catch(() => {})` без проверки `res.ok`.
 *
 * Реализация вынесена в lib/notifications/tg-send.ts. Список ниже —
 * ЗАМОРОЖЕННЫЙ ДОЛГ: файлы, которые ещё шлют своим кодом. Он может только
 * СОКРАЩАТЬСЯ; новый такой файл краснит сборку. Тот же приём, что у
 * waterfall-sentinel-debt и schema-coverage: долг, который видно, лечится.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/**
 * Замороженный долг на 08.09, измеренный, а не угаданный. Только сокращать.
 *
 * Двадцать восемь файлов шлют в Telegram своим кодом. Часть читает ответ,
 * часть — нет; разбирать их одним махом значило бы менять поведение двух
 * десятков поверхностей за раз, не проверив ни одной. Находка называла три
 * места — они и переведены на общий отправитель; остальное записано сюда,
 * чтобы долг был виден и мог только сокращаться.
 *
 * Watchdog в списке остаётся: его ГЛАВНЫЙ алерт идёт общим отправителем, но
 * рядом живут ещё четыре отправки (оператору, гиду), и они пока свои.
 */
const OWN_SENDERS: readonly string[] = [
  'app/api/admin/execute-all/route.ts',
  'app/api/admin/operators/[id]/route.ts',
  'app/api/auth/register-operator/route.ts',
  'app/api/cron/booking-stall-alert/route.ts',
  'app/api/cron/checkin-watchdog/route.ts',
  'app/api/cron/digest/route.ts',
  'app/api/cron/evo/route.ts',
  'app/api/cron/health/route.ts',
  'app/api/cron/safety-ingest/route.ts',
  'app/api/cron/smart-notify/route.ts',
  'app/api/cron/ssr-sentinel/route.ts',
  'app/api/cron/tour-reminder/route.ts',
  'app/api/cron/tour-review-request/route.ts',
  'app/api/payments/tochka/webhook/route.ts',
  'app/api/safety/reports/route.ts',
  'app/api/safety/wishes/route.ts',
  'lib/agents/editor.ts',
  'lib/agents/evo/rescue-agent.ts',
  'lib/agents/safeguards/approval-required.ts',
  'lib/agents/scout-ai-features.ts',
  'lib/agents/scout-digest.ts',
  'lib/agents/scout-innovator.ts',
  'lib/agents/tools/board-executor-tools.ts',
  'lib/agents/volcano/merge-gate.ts',
  'lib/agents/watchdog.ts',
  'lib/leads/proposal-delivery.ts',
  'lib/services/ingest/osm-traces-scout.ts',
  'lib/services/intelligence-monitor.service.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Кто шлёт в Telegram своим fetch вместо общего отправителя. */
function ownSenders(): string[] {
  const found: string[] = [];
  for (const dir of ['lib', 'app']) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (rel === 'lib/notifications/tg-send.ts') continue;
      // Служба уведомлений и вебхуки бота — не тревоги агентов.
      if (rel.startsWith('lib/notifications/') || rel.includes('/telegram/')) continue;
      const code = readFileSync(file, 'utf-8');
      if (!/bot\$\{token\}\/sendMessage/.test(code)) continue;
      found.push(rel);
    }
  }
  return found.sort();
}

describe('доставка тревог: одна реализация, долг только сокращается', () => {
  it('общий отправитель возвращает исход, а не void', () => {
    const SRC = readFileSync('lib/notifications/tg-send.ts', 'utf-8');
    expect(SRC).toMatch(/export type TgSendOutcome = \{ ok: true \} \| \{ ok: false; reason: string \}/);
    expect(SRC).toMatch(/if \(!res\.ok\)/);
    // Ненастроенный канал — тоже недоставка, а не тишина.
    expect(SRC).toContain('тревога никуда не ушла');
  });

  it('новых самодельных отправителей нет', () => {
    const current = ownSenders();
    const unexpected = current.filter((f) => !OWN_SENDERS.includes(f));
    expect(unexpected, `новые самодельные отправители: ${unexpected.join(', ')}`).toEqual([]);
  });

  it('починенное вычёркивается тем же коммитом, а не копится в списке', () => {
    const current = new Set(ownSenders());
    const stale = OWN_SENDERS.filter((f) => !current.has(f));
    expect(stale, `уже не шлют своим кодом, вычеркни из списка: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('евалы и сканер безопасности отчитываются по доставке', () => {
  it('faithfulness: alerts_sent — это факт доставки', () => {
    const SRC = readFileSync('lib/agents/eval/kuzmich-faithfulness.ts', 'utf-8');
    expect(SRC).toMatch(/alerts_sent: delivery\?\.ok === true/);
    expect(SRC).not.toMatch(/alerts_sent: alertText !== null/);
    expect(SRC).toContain("tgSend('kuzmich-eval'");
  });

  it('red-team: то же самое', () => {
    const SRC = readFileSync('lib/agents/eval/kuzmich-redteam.ts', 'utf-8');
    expect(SRC).toMatch(/alerts_sent: delivery\?\.ok === true/);
    expect(SRC).not.toMatch(/alerts_sent: alertText !== null/);
  });

  it('сканер противоречий о безопасности не шлёт вслепую', () => {
    const SRC = readFileSync('lib/agents/memory-contradiction.ts', 'utf-8');
    expect(SRC).toContain("tgSend('memory-contradiction'");
    expect(SRC).not.toMatch(/\.catch\(\(\) => \{\}\);/);
  });

  it('главный алерт Watchdog идёт общей реализацией', () => {
    const SRC = readFileSync('lib/agents/watchdog.ts', 'utf-8');
    expect(SRC).toContain("tgSendShared('watchdog'");
    // Своей копии проверки ответа у него больше нет — она вынесена.
    expect(SRC).not.toContain('HTTP 200 — единственное доказательство доставки');
  });
});
