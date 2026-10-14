/**
 * Проверка глазами браузера: открывается ли /map с местами (01.10).
 *
 * Скрин владельца 01.10 19:00: карта открылась рельефом, а мест на ней нет
 * вовсе, счётчик стоит на «Загрузка…». Данные при этом целы (проба 634):
 * список страницы отдаёт 382 места, слой мест в хранилище — 382 точки, у 129
 * признак «с маршрутом». Значит, ломается что-то между данными и экраном, и
 * увидеть это можно только в настоящем браузере. Из контейнера разработки ни
 * прод, ни хранилище не открываются — поэтому прогон идёт с раннера.
 *
 * Что делает: открывает /map в Chromium размером с телефон, пишет ошибки
 * консоли, отказы сети и ответы на файлы слоя мест, через 15 и 45 секунд
 * читает счётчик и чипы фильтра и печатает кадр экрана base64-строками
 * (артефакты из контейнера разработки не скачиваются, лог читается).
 *
 * Только чтение: на проде ничего не пишется.
 *
 * Исходы (§4.0): 0 — страница прочитана (вывод — улики, приговор выносит
 * человек); 2 — страница не открылась.
 *
 *   npx tsx scripts/map-tiles/map-page-check.ts [--path /map] [--shot .cache/map-page.jpg]
 *   --layout-shifts — только сдвиги вёрстки и раскладка блоков за 12 с, без кадров (14.10)
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SHIFT_OBSERVER, describeShift, layoutChanges, totalShift, type LayoutSnap, type ShiftEntry } from './layout-shifts';

const SITE = process.env.SITE_URL ?? 'https://vedarai.ru';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<number> {
  const path = arg('--path', '/map');
  const shot = arg('--shot', '.cache/map-page.jpg');
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    // Контейнер разработки держит свой Chromium другой версии, чем ждёт
    // @playwright/test; на раннере переменной нет — браузер по умолчанию.
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
    colorScheme: 'dark',
    // Часовой пояс телефона (04.10, React #418 на главной): сервер рендерит в
    // UTC, телефон владельца — на Камчатке. По умолчанию — Камчатка.
    timezoneId: arg('--tz', 'Asia/Kamchatka'),
    // Телефонный UA: главная выбирает дерево по User-Agent (lib/home/
    // device-tree), и с UA раннера отдавала десктоп — ленты туров там нет
    // (прогон 10, 04.10: «лента туров не найдена» при правильном коде).
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    // С отрезанным хранилищем service worker отключён: его запросы мимо
    // page.route, и офлайн-кэш сайта отдал бы рельеф, будто связь есть
    // (прогон 7: «отрезанный» вариант нарисовал всё из кэша).
    ...(process.argv.includes('--block') ? { serviceWorkers: 'block' as const } : {}),
    // Запись трека (12.10): телефону нужна геопозиция с разрешением.
    ...(process.argv.includes('--track-reload')
      ? { permissions: ['geolocation'], geolocation: { latitude: 53.0, longitude: 158.65, accuracy: 5 } }
      : {}),
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}с`;

  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${at()}] консоль ${m.type()}: ${m.text().slice(0, 400)}`);
  });
  page.on('pageerror', (e) => console.log(`[${at()}] ошибка страницы: ${e.message.slice(0, 400)}`));
  page.on('requestfailed', (r) => console.log(`[${at()}] запрос не дошёл: ${r.url().slice(0, 200)} — ${r.failure()?.errorText ?? '?'}`));
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400) console.log(`[${at()}] ответ ${r.status()}: ${u.slice(0, 200)}`);
    else if (u.includes('.places.geojson') || u.includes('/api/routes?')) {
      console.log(`[${at()}] ответ ${r.status()}: ${u.slice(0, 200)}`);
    }
  });

  // Телефон владельца — мобильная сеть: на быстрой сети раннера страница
  // успевает всё, и момент «Загрузка…» со скрина не воспроизводится.
  if (process.argv.includes('--slow')) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8,
    });
    console.log('сеть: медленная (1,6 Мбит/с, 150 мс)');
  }

  // Хранилище не отвечает — как на телефоне владельца 03.10 (код 0 на файлы
  // обзора): все запросы к хосту обрываются, и видно, что карта рисует без
  // него (контур края раньше рельефа).
  const blocked = arg('--block', '');
  if (blocked) {
    await page.route((u) => u.hostname === blocked, (r) => r.abort('connectionfailed'));
    console.log(`хост ${blocked}: все запросы обрываются`);
  }

  // Сдвиги вёрстки (14.10): Lighthouse назвал на /map сдвиг 0,171 контейнера
  // карты без причины. Записи layout-shift с узлами и прямоугольниками и
  // раскладка верхних блоков — до первого нажатия, иначе сдвиг от нажатия
  // браузер справедливо не считает (scripts/map-tiles/layout-shifts).
  const layoutShifts = process.argv.includes('--layout-shifts');
  if (layoutShifts) {
    await page.addInitScript(SHIFT_OBSERVER);
  }

  try {
    await page.goto(`${SITE}${path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  } catch (err) {
    console.log(`страница не открылась: ${err instanceof Error ? err.message : String(err)}`);
    await browser.close();
    return 2;
  }

  if (layoutShifts) {
    const snaps: LayoutSnap[] = [];
    for (const until of [300, 700, 1_200, 2_000, 3_000, 4_500, 6_500, 9_000, 12_000]) {
      await page.waitForTimeout(Math.max(0, until - (Date.now() - t0)));
      const blocks = await page.evaluate(() => {
        const w = window as unknown as { __sel: (n: Node) => string };
        // Верхние блоки: дети корневых div страницы — шапка, чипы, карта.
        return Array.from(document.querySelectorAll('body > div > *'))
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.height > 0)
          .slice(0, 12)
          .map(({ el, r }) => ({ node: w.__sel(el), y: Math.round(r.y), h: Math.round(r.height) }));
      });
      snaps.push({ t: Date.now() - t0, blocks });
    }
    const shifts = await page.evaluate(() => (window as unknown as { __shifts: ShiftEntry[] }).__shifts);
    console.log(`СДВИГИ: всего ${totalShift(shifts).toFixed(4)}, записей ${shifts.length}`);
    for (const e of shifts) console.log(describeShift(e));
    for (const line of layoutChanges(snaps)) console.log(line);
    await browser.close();
    return 0;
  }

  // Окно согласия закрывает нижнюю половину экрана — юг, где почти все
  // места «с маршрутом» (прогон 1 принял это за пустую карту).
  await page.waitForTimeout(3_000);
  await page.getByRole('button', { name: 'Только необходимое' }).click({ timeout: 5_000 })
    .then(() => console.log(`[${at()}] окно согласия закрыто`), () => console.log(`[${at()}] окна согласия нет`));
  if (process.argv.includes('--dark')) {
    await page.getByRole('button', { name: 'Переключить тему' }).first().click({ timeout: 5_000 })
      .then(() => console.log(`[${at()}] тема переключена`), () => console.log(`[${at()}] кнопки темы нет`));
  }

  // Чип фильтра по началу подписи (02.10: «Землетрясения» на /map).
  const chip = arg('--chip', '');
  if (chip) {
    await page.waitForTimeout(6_000);
    await page.locator('button', { hasText: chip }).first().click({ timeout: 10_000 })
      .then(() => console.log(`[${at()}] чип «${chip}» нажат`), () => console.log(`[${at()}] чипа «${chip}» нет`));
  }

  // Лента туров на главной плывёт сама (04.10): позиция прокрутки ленты
  // замеряется дважды с паузой — растёт ли она, и не стоит ли под пальцем.
  if (process.argv.includes('--drift')) {
    const sel = '.plates.more-tours';
    const ok = await page.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 15_000 }).then(() => true, () => false);
    if (!ok) {
      console.log(`[${at()}] лента туров не найдена`);
    } else {
      const left = () => page.evaluate((q) => {
        const el = document.querySelector(q) as HTMLElement | null;
        return el ? { left: Math.round(el.scrollLeft), cards: el.children.length, max: el.scrollWidth - el.clientWidth } : null;
      }, sel);
      // Виртуальная мышь Playwright остаётся там, где нажала «согласие»; если
      // под ней лента — это наведение, и лента правильно стоит (прогон 12).
      // Уводим курсор в угол и ждём конца паузы после ухода мыши.
      await page.mouse.move(1, 1);
      await page.waitForTimeout(4_500);
      const a = await left();
      await page.waitForTimeout(8_000);
      const b = await left();
      console.log(`[${at()}] лента: scrollLeft ${a?.left} → ${b?.left} за 8 с (карточек ${b?.cards}, предел ${b?.max})`);
      await page.locator(sel).first().dispatchEvent('pointerdown');
      const c = await left();
      await page.waitForTimeout(2_000);
      const d = await left();
      console.log(`[${at()}] после касания: ${c?.left} → ${d?.left} за 2 с (должна стоять)`);
      const pause = page.getByRole('button', { name: 'Остановить ленту туров' });
      console.log(`[${at()}] кнопка остановки: ${await pause.count() > 0 ? 'есть' : 'НЕТ'}`);
    }
  }

  // AI Спасатель (04.10, /sos): открыть, спросить, прочитать ответ.
  const rescueAsk = arg('--rescue', '');
  if (rescueAsk) {
    await page.waitForTimeout(3_000);
    const head = page.getByRole('button', { name: /AI Спасатель/ }).first();
    const found = await head.scrollIntoViewIfNeeded({ timeout: 15_000 }).then(() => true, () => false);
    console.log(`[${at()}] AI Спасатель на странице: ${found ? 'есть' : 'НЕТ'}`);
    if (found) {
      await head.click();
      const input = page.getByPlaceholder('Что происходит?');
      await input.fill(rescueAsk);
      await input.press('Enter');
      await page.waitForTimeout(2_500);
      const replies = await page.locator('div[style*="pre-wrap"]').allInnerTexts();
      console.log(`[${at()}] вопрос «${rescueAsk}» → ${replies.map(r => r.replace(/\s+/g, ' ').slice(0, 160)).join(' | ')}`);
      await input.scrollIntoViewIfNeeded();
    }
  }

  // Долистать до блока по тексту (04.10: «Экстренные контакты» на радаре —
  // номера ниже первого экрана).
  const scrollText = arg('--scroll-text', '');
  if (scrollText) {
    await page.waitForTimeout(4_000);
    await page.getByText(scrollText, { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 15_000 })
      .then(() => console.log(`[${at()}] долистано до «${scrollText}»`), () => console.log(`[${at()}] текста «${scrollText}» нет`));
  }

  // Запись трека переживает перезагрузку (12.10, скрин владельца «при
  // повторном открытии не сохраняется трек»). Телефон начинает запись,
  // проходит восемь точек, страница перезагружается. Правильно: запись идёт
  // дальше (кнопка «Остановить»), черновик без отметки остановки, отправок
  // трека НОЛЬ. Прежний код слал обрывок на сервер и бросал запись.
  // Отправка трека обрывается здесь же: на проде ничего не пишется.
  if (process.argv.includes('--track-reload')) {
    let posts = 0;
    await page.route('**/api/field-check/track', (r) => {
      posts++;
      console.log(`[${at()}] ПОПЫТКА ОТПРАВИТЬ ТРЕК — оборвана, на прод не ушла`);
      return r.abort('connectionfailed');
    });
    const draft = () => page.evaluate(() => new Promise<string>((resolve) => {
      const req = indexedDB.open('kamchatour-offline');
      req.onerror = () => resolve('база не открылась');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('fieldTracks')) { resolve('хранилища записи нет'); return; }
        const get = db.transaction('fieldTracks').objectStore('fieldTracks').get('current');
        get.onerror = () => resolve('черновик не прочитан');
        get.onsuccess = () => {
          const d = get.result as { points?: unknown[]; stoppedAt?: number } | undefined;
          resolve(d ? `точек ${d.points?.length ?? 0}, stoppedAt ${d.stoppedAt ?? 'нет'}` : 'черновика нет');
        };
      };
    }));
    const buttons = () => page.evaluate(() => Array.from(document.querySelectorAll('button'))
      .map(b => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length <= 60 && /трек|Остановить|Стоп|Действия поля/i.test(t)).slice(0, 6));
    const pressTrack = async (name: RegExp) => {
      const direct = page.getByRole('button', { name }).first();
      if (await direct.count() === 0) {
        await page.getByRole('button', { name: /^Действия поля/ }).first().click({ timeout: 5_000 }).catch(() => undefined);
      }
      return page.getByRole('button', { name }).first().click({ timeout: 8_000 }).then(() => true, () => false);
    };
    const walk = async (from: number, n: number) => {
      for (let i = from; i < from + n; i++) {
        await ctx.setGeolocation({ latitude: 53.0 + i * 0.0003, longitude: 158.65, accuracy: 5 });
        await page.waitForTimeout(1_500);
      }
    };

    await page.waitForTimeout(5_000);
    console.log(`[${at()}] кнопки до записи: ${(await buttons()).join(' | ') || 'нет'}`);
    const started = await pressTrack(/Записать трек|Запись трека/);
    console.log(`[${at()}] запись начата: ${started ? 'да' : 'НЕТ — кнопки не нашлось'}`);
    await walk(1, 8);
    console.log(`[${at()}] до перезагрузки: черновик ${await draft()} · кнопки: ${(await buttons()).join(' | ')}`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(8_000);
    console.log(`[${at()}] после перезагрузки: черновик ${await draft()} · кнопки: ${(await buttons()).join(' | ')}`);
    await walk(9, 4);
    const resumed = await page.getByRole('button', { name: /Остановить/ }).count() > 0;
    console.log(`[${at()}] ещё четыре точки: черновик ${await draft()}`);
    console.log(`ИТОГ: запись после перезагрузки ${resumed ? 'ИДЁТ' : 'НЕ ИДЁТ'} · попыток отправить трек: ${posts}`);
  }

  const shots: string[] = [];
  // У проверки записи итог — строки выше; кадры экрана ей не нужны.
  for (const wait of process.argv.includes('--track-reload') ? [] : [7_000, 30_000]) {
    await page.waitForTimeout(wait);
    const state = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('button'))
        .map(b => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(t => /^(Все|С маршрутом|Землетрясения|Вулканы|Озёра|Источники)/.test(t));
      const counter = Array.from(document.querySelectorAll('p'))
        .map(p => (p.textContent ?? '').trim())
        .find(t => t.startsWith('Точек') || t.startsWith('Толч') || t.startsWith('Загрузка')) ?? null;
      const canvases = document.querySelectorAll('canvas').length;
      // Снимки мест — их настоящий размер (01.10: кадры Алины переложены в 3:4).
      const photos = Array.from(document.querySelectorAll('img'))
        .filter(i => /\/api\/images\/(route|place-gallery)\//.test(i.currentSrc || i.src))
        .map(i => `${decodeURIComponent((i.currentSrc || i.src).replace(/^.*\/api\/images\//, '').slice(0, 70))} ${i.naturalWidth}x${i.naturalHeight}`);
      return { chips, counter, canvases, photos };
    });
    console.log(`[${at()}] счётчик: ${state.counter ?? 'нет'} · чипы: ${state.chips.join(' | ') || 'нет'} · canvas: ${state.canvases}`);
    for (const ph of state.photos) console.log(`[${at()}] снимок ${ph}`);
    const file = shot.replace(/\.jpg$/, `-${shots.length + 1}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 50 });
    shots.push(file);
  }

  for (const [n, file] of shots.entries()) {
    const b64 = readFileSync(file).toString('base64');
    console.log(`КАДР ${n + 1} base64, ${b64.length} знаков:`);
    for (let i = 0; i < b64.length; i += 4000) console.log(`B${n + 1}:${b64.slice(i, i + 4000)}`);
  }
  console.log('КАДР КОНЕЦ');
  await browser.close();
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  console.log(`проверка упала: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
