/**
 * Проверка делом: открытый экран /safety перечитывается сам (01.10, #2146).
 *
 * Владелец: «почему сам перестал обновляться?». Сбор на сервере идёт каждые
 * 5 минут, а открытая вкладка его не видела — радар и лента перечитывались
 * только кнопкой. Теперь раз в минуту экран спрашивает себя, не старше ли он
 * пяти минут, и перечитывается целиком. Юнит-сторож держит код; здесь — сам
 * экран на ПРОДЕ, в настоящем Chromium, без единого нажатия:
 *
 *   1. дождаться сборки не старше SINCE (version.json, built_at);
 *   2. открыть /safety и ничего не трогать;
 *   3. до пяти минут экран НЕ перечитывается (иначе он дёргает базу зря);
 *   4. к седьмой минуте перечитался: серверный блок (RSC-запрос /safety) и
 *      лента (/api/safety/seismic?fresh=0); к источникам (POST
 *      /api/safety/refresh) при этом не ходил;
 *   5. вкладка скрыта — за следующие шесть минут ни одного перечитывания.
 *
 * Исходы (§4.0): 0 — всё так; 1 — экран не перечитался, перечитался рано,
 * ходил к источникам или трогал скрытую вкладку; 2 — проверка не состоялась
 * (сборка не дождалась, страница не открылась).
 *
 *   SINCE=2026-10-01T05:03:00Z npx tsx scripts/safety-autorefresh-check.ts
 */
import { chromium, type Request } from '@playwright/test';

const SITE = process.env.SITE_URL ?? 'https://vedarai.ru';
const SINCE = process.env.SINCE ?? '';
const MIN = 60_000;

async function waitFreshBuild(): Promise<boolean> {
  if (!SINCE) return true;
  const deadline = Date.now() + 55 * MIN;
  while (Date.now() < deadline) {
    try {
      const v = await (await fetch(`${SITE}/version.json`, { cache: 'no-store' })).json() as { built_at?: string };
      if (typeof v.built_at === 'string' && v.built_at >= SINCE) {
        console.log(`сборка ${v.built_at} — не старше ${SINCE}`);
        return true;
      }
      console.log(`сборка ${v.built_at ?? '?'} старше ${SINCE} — ждём`);
    } catch (err) {
      console.log(`version.json не ответил: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise(r => setTimeout(r, MIN));
  }
  return false;
}

type Hit = { at: number; kind: 'rsc' | 'seismic' | 'refresh' };

function classify(r: Request): Hit['kind'] | null {
  const u = new URL(r.url());
  if (r.method() === 'POST' && u.pathname === '/api/safety/refresh') return 'refresh';
  if (u.pathname === '/api/safety/seismic') return 'seismic';
  const rsc = r.headers()['rsc'] === '1' || u.searchParams.has('_rsc');
  if (rsc && u.pathname === '/safety') return 'rsc';
  return null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<number> {
  if (!(await waitFreshBuild())) { console.log('ИТОГ: сборка не дождалась — проверка не состоялась'); return 2; }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const hits: Hit[] = [];
    page.on('request', (r) => {
      const kind = classify(r);
      if (kind) hits.push({ at: Date.now(), kind });
    });

    try {
      await page.goto(`${SITE}/safety`, { waitUntil: 'load', timeout: 120_000 });
    } catch (err) {
      console.log(`ИТОГ: /safety не открылась — ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    const t0 = Date.now();
    // Первичная загрузка сама зовёт ленту — она не перечитывание.
    await sleep(30_000);
    const baseline = hits.length;
    console.log(`загрузка: ${baseline} запросов (${hits.map(h => h.kind).join(', ') || 'нет'})`);

    const after = (from: number, to: number, kind: Hit['kind']) =>
      hits.slice(baseline).filter(h => h.kind === kind && h.at >= from && h.at < to).length;

    let failed = false;

    // До пяти минут экран свежий — перечитывать нечего.
    await sleep(4 * MIN - 30_000);
    const early = after(t0, Date.now(), 'rsc') + after(t0, Date.now(), 'seismic');
    console.log(`до 4-й минуты: перечитываний ${early}`);
    if (early > 0) { console.log('ПЛОХО: экран перечитался раньше, чем устарел'); failed = true; }

    // К седьмой минуте — перечитался сам, без нажатий.
    await sleep(3 * MIN);
    const tVisibleEnd = Date.now();
    const rsc = after(t0, tVisibleEnd, 'rsc');
    const seismic = after(t0, tVisibleEnd, 'seismic');
    const refresh = after(t0, tVisibleEnd, 'refresh');
    console.log(`к 7-й минуте: серверный блок ${rsc}, лента ${seismic}, обход источников ${refresh}`);
    if (rsc < 1) { console.log('ПЛОХО: серверный блок (радар, пульсы) не перечитался'); failed = true; }
    if (seismic < 1) { console.log('ПЛОХО: лента не перечиталась'); failed = true; }
    if (refresh > 0) { console.log('ПЛОХО: экран сам пошёл к источникам — это работа кнопки'); failed = true; }

    // Скрытая вкладка — батарея: ни одного перечитывания.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const tHidden = Date.now();
    await sleep(6 * MIN);
    const hidden = after(tHidden, Date.now(), 'rsc') + after(tHidden, Date.now(), 'seismic');
    console.log(`скрытая вкладка, 6 мин: перечитываний ${hidden}`);
    if (hidden > 0) { console.log('ПЛОХО: скрытая вкладка перечитывается'); failed = true; }

    await page.screenshot({ path: '.cache/safety-autorefresh.png', fullPage: false }).catch(() => undefined);
    console.log(failed ? 'ИТОГ: автообновление работает не так, как обещано' : 'ИТОГ: экран перечитывается сам, вовремя и только видимый');
    return failed ? 1 : 0;
  } finally {
    await browser.close();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.log(`ИТОГ: проверка упала — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
