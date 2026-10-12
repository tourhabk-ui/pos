#!/usr/bin/env node
/**
 * Токен-гейт: цвет на живой странице, которого нет в дизайн-системе, — нарушение.
 *
 * Зачем именно рантайм. Grep по CSS не решает каскад: локальное правило может
 * перекрасить SOS при формально «чистых» токенах (теневой `--danger:#C0392B`
 * внутри `.v7` — ровно этот случай). Здесь страница рендерится в настоящем
 * Chromium, снимаются ВЫЧИСЛЕННЫЕ стили, и палитра сверяется с токенами.
 *
 * Извлечение делает dembrandt (open-source CLI на Playwright, MIT) — он умеет
 * снимать палитру с confidence и раскладкой по страницам. Своё здесь только
 * правило: что считать нарушением.
 *
 * Храповик, а не стена. Известные нарушения перечислены в allowlist с причиной
 * и НЕ красят прогон: гейт падает только на НОВЫХ. Иначе гейт был бы красным с
 * первого дня, его бы отключили, и он не защищал бы ничего.
 *
 * ── Браузер: одна версия на всё (12.10, #2378) ───────────────────────────────
 *
 * С 17.08 по 12.10 гейт был красным 67 прогонов подряд с диагнозом «приложение
 * недоступно» при живом приложении. Причина — дрейф версий: dembrandt@0.26.1
 * держал playwright-core диапазоном ^1.60.0, workflow ставил Chromium от
 * playwright@1.62.1, а диапазон уплыл на 1.64 — ревизии Chromium разошлись, и
 * браузер не запускался. Теперь пин один: dembrandt@0.39.2 закрепляет
 * playwright-core точной версией (1.63.0), а Chromium ставит сам dembrandt
 * (`install-browser`, режим `--install-browser` ниже) — той версией, которой
 * и будет рендерить. Второй версии Playwright в workflow больше нет.
 *
 * Три исхода (§4.0): вердикт по палитре; «приложение недоступно» — проба
 * адреса ДО запуска браузера, чтобы отказ сети не читался как отказ браузера;
 * «браузер или извлекатель не сработали при живом приложении». Пустая палитра
 * — тоже отказ, а не «нарушений нет».
 *
 * Запуск:
 *   node scripts/design-token-gate.mjs --install-browser      # один раз: Chromium под dembrandt
 *   node scripts/design-token-gate.mjs                        # localhost:3000
 *   BASE_URL=https://vedarai.ru node scripts/design-token-gate.mjs
 *
 * Требует запущенного приложения по BASE_URL и браузера для Playwright.
 * В песочнице без доступа к CDN Playwright: подними свой Chromium с
 * --remote-debugging-port и задай BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222.
 */

'use strict';

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Версия закреплена ТОЧНО: гейт не должен менять вердикт из-за апдейта
 * извлекателя, а браузер обязан совпадать с его playwright-core. Сторож
 * (tests/unit/design-token-gate.test.ts) требует, чтобы workflow ставил
 * браузер через этот же пин, а не своей версией Playwright.
 */
const DEMBRANDT = 'dembrandt@0.39.2';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/** Сколько ждать ответа приложения в пробе доступности. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Страницы под наблюдением. Смысл выборки — разные семьи поверхностей:
 * главная, безопасность (там живёт --danger), карточки маршрута и тура,
 * каталог. Все публичные: гейт не требует ни авторизации, ни секретов.
 */
const PATHS = (process.env.GATE_PATHS || '/sos /routes /emergency /catalog').split(/\s+/).filter(Boolean);

const ALLOWLIST_PATH = join(ROOT, 'scripts/design-token-gate.allowlist.json');

/** Нейтральные значения, которые не являются решением дизайнера. */
const NEUTRAL = new Set(['#ffffff', '#000000']);

function log(stage, message, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage, message, ...data }));
}

/**
 * Chromium под закреплённый dembrandt: `install-browser` зовёт playwright-core
 * той версии, которую dembrandt бандлит, и ставит ровно его ревизию браузера.
 * `--with-deps` — системные библиотеки для раннера CI.
 */
function installBrowser() {
  log('INSTALL', `браузер под ${DEMBRANDT}`);
  execFileSync('npx', ['--yes', DEMBRANDT, 'install-browser', '--with-deps', 'chromium'], { stdio: 'inherit' });
  log('INSTALL', 'браузер установлен');
}

/**
 * Все hex-значения из globals.css — это и есть дизайн-система в её единственном
 * источнике истины. Токены не перечисляем руками: список бы устарел молча.
 */
function documentedTokens() {
  const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf-8');
  const hexes = css.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  return new Set(hexes.map((h) => h.toLowerCase()));
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Map();
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
  return new Map(Object.entries(raw.colors ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * Проба адреса до запуска браузера: отвечает ли приложение вообще. Два месяца
 * красного с диагнозом «приложение недоступно» при живом приложении (#2378) —
 * это сигнал, поданный неверно; теперь недоступность — измеренный факт.
 */
async function probeApp() {
  const url = `${BASE_URL.replace(/\/$/, '')}${PATHS[0] ?? '/'}`;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { ok: res.ok, url, status: res.status };
  } catch (e) {
    return { ok: false, url, status: null, error: String(e?.cause?.code ?? e?.name ?? e).slice(0, 120) };
  }
}

function extract() {
  const out = execFileSync(
    'npx',
    ['--yes', DEMBRANDT, BASE_URL, ...PATHS, '--no-sandbox', '--json-only'],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const data = JSON.parse(out);
  if (data.error) throw new Error(`${data.error.code}: ${data.error.message}`);
  return data;
}

async function main() {
  if (process.argv.includes('--install-browser')) {
    installBrowser();
    return;
  }

  const tokens = documentedTokens();
  const allowed = loadAllowlist();

  const probe = await probeApp();
  if (!probe.ok) {
    // Недоступное приложение — не вердикт о дизайне и не вина браузера:
    // браузер ещё не запускался. Красим прогон, называя причину.
    log('ERROR', 'приложение недоступно по BASE_URL — браузер не запускался, вердикта о дизайне нет', {
      url: probe.url, http_status: probe.status, error: probe.error ?? null,
    });
    process.exit(2);
  }

  let data;
  try {
    data = extract();
  } catch (e) {
    // Приложение отвечает (проба выше), значит упали браузер или извлекатель.
    // Чаще всего это Chromium не той ревизии, что у playwright-core dembrandt.
    log('ERROR', 'браузер или извлекатель не сработали при живом приложении — вердикта о дизайне нет', {
      url: probe.url, http_status: probe.status, error: String(e).slice(0, 300),
      hint: 'поставить браузер под закреплённый dembrandt: node scripts/design-token-gate.mjs --install-browser',
    });
    process.exit(2);
  }

  const palette = data.colors?.palette ?? [];
  if (palette.length === 0) {
    // Ноль результатов — отказ, а не «нарушений нет» (§4.0): страницы с
    // вёрсткой не бывают бесцветными.
    log('ERROR', 'палитра пуста: извлечение не дало ни одного цвета — это отказ, а не «нарушений нет»', {
      base_url: BASE_URL, paths: PATHS, extractor: DEMBRANDT,
    });
    process.exit(2);
  }

  const offenders = [];
  const known = [];

  for (const c of palette) {
    const hex = (c.normalized || '').toLowerCase();
    if (!hex || NEUTRAL.has(hex) || tokens.has(hex)) continue;
    (allowed.has(hex) ? known : offenders).push({
      color: hex,
      count: c.count,
      pages: c.pageCount,
      confidence: c.confidence,
      reason: allowed.get(hex),
    });
  }

  log('TOKEN_GATE', `палитра: ${palette.length} цветов`, {
    base_url: BASE_URL,
    paths: PATHS,
    extractor: DEMBRANDT,
    tokens_documented: tokens.size,
    known_exceptions: known.length,
    new_offenders: offenders.length,
  });

  for (const k of known) {
    log('KNOWN', `${k.color} — исключение: ${k.reason}`, { count: k.count, pages: k.pages });
  }

  if (offenders.length === 0) {
    log('TOKEN_GATE', 'новых цветов вне дизайн-системы нет');
    return;
  }

  for (const o of offenders) {
    log('OFFENDER', `${o.color} — нет в токенах globals.css`, {
      count: o.count, pages: o.pages, confidence: o.confidence,
    });
  }
  log('TOKEN_GATE', 'гейт красный: на страницах есть цвета вне дизайн-системы', {
    new_offenders: offenders.map((o) => o.color),
    hint: 'заменить на CSS-переменную или, если это осознанно, внести в scripts/design-token-gate.allowlist.json с причиной',
  });
  process.exit(1);
}

main().catch((e) => {
  log('ERROR', 'гейт упал до вердикта', { error: String(e).slice(0, 300) });
  process.exit(2);
});
