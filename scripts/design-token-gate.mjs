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
 * Запуск:
 *   node scripts/design-token-gate.mjs                       # localhost:3000
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

/** Версия закреплена: гейт не должен менять вердикт из-за апдейта извлекателя. */
const DEMBRANDT = 'dembrandt@0.26.1';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

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

function main() {
  const tokens = documentedTokens();
  const allowed = loadAllowlist();

  let data;
  try {
    data = extract();
  } catch (e) {
    // Недоступное приложение — не вердикт о дизайне. Красим прогон, но честно
    // называем причину: молча зелёный гейт хуже отсутствующего.
    log('ERROR', 'извлечение не удалось — приложение недоступно или нет браузера', { error: String(e).slice(0, 300) });
    process.exit(2);
  }

  const palette = data.colors?.palette ?? [];
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

main();
