/**
 * scripts/map-tiles/verify-packs.ts — читается ли то, что лежит в хранилище.
 *
 * ── Почему это появилось ──────────────────────────────────────────────────
 *
 * Скрин владельца 02.09 из поля: «Своя карта не отрисовалась: Expected ','
 * or ']' after array element in JSON at position 387966 (line 1 column
 * 387967)». Позиция ошибки совпадает с КОНЦОМ строки — так JSON.parse
 * говорит про оборванный текст, а не про испорченную середину. То есть
 * какой-то из файлов пакета доехал до телефона неполным.
 *
 * Проверить это из контейнера нельзя: адрес бакета и ключи живут в секретах
 * репозитория, наружу из контейнера ход закрыт прокси. Значит место проверки
 * — раннер, там же, где пакет собирается и заливается (§8, «где что
 * исполняется»).
 *
 * ── Три исхода, не два (§4.0) ─────────────────────────────────────────────
 *
 * У каждого файла ровно один вердикт, и «не смог проверить» не равен
 * «хорошо»:
 *
 *   ok           — HTTP 200, тело целиком, JSON разобрался;
 *   truncated    — байт пришло меньше, чем обещал Content-Length;
 *   bad_json     — тело целое, но не разбирается (позиция и кусок текста);
 *   http         — код не 200/206 (403 бакета, 404 несобранного файла);
 *   unreachable  — запрос не состоялся вовсе (сеть, DNS, TLS).
 *
 * Последний — это и есть «не знаю»: он не доказывает ни исправности файла,
 * ни его порчи, и потому не зелёный, но и не приговор пакету.
 *
 * ── Что проверяется ───────────────────────────────────────────────────────
 *
 * Список ключей берётся ИЗ РЕЕСТРОВ (`BUILT_PACK_REGIONS`, `OSM_BUILT_REGIONS`,
 * `OSM_LAYERS`, `packKey`/`osmKey`), а не выписывается здесь второй раз:
 * свой список разошёлся бы с тем, что просит карта, и проверял бы не то.
 *
 * GeoJSON качается ЦЕЛИКОМ — иначе про обрыв в конце файла ничего не узнать.
 * Рельеф (PMTiles) читается первыми килобайтами Range-запросом: так его
 * читает и клиент, а качать 190 МБ ради заголовка незачем.
 *
 * Запуск:
 *   MAP_PACK_BASE_URL=https://s3.example.ru/bucket npx tsx scripts/map-tiles/verify-packs.ts
 *   (или S3_ENDPOINT + S3_BUCKET — база собирается той же формулой, что в
 *   lib/storage/s3.ts)
 */

import {
  BUILT_PACK_REGIONS, OSM_BUILT_REGIONS, OSM_LAYERS, packKey, osmKey,
} from '@/lib/map/pack-source';

export type PackVerdict = 'ok' | 'truncated' | 'bad_json' | 'http' | 'unreachable';

export interface PackCheck {
  key: string;
  verdict: PackVerdict;
  /** Что именно случилось — словами, для человека и для сводки прогона. */
  detail: string;
  /** Сколько байт реально прочитано. null — тело не читалось (Range) или не пришло. */
  bytes: number | null;
}

/** Ключи всех файлов, которые карта просит у хранилища. Порядок — районами. */
export function packKeysToVerify(): Array<{ key: string; kind: 'json' | 'archive' }> {
  const out: Array<{ key: string; kind: 'json' | 'archive' }> = [];
  for (const region of BUILT_PACK_REGIONS) {
    out.push({ key: packKey(region, 'terrain'), kind: 'archive' });
    out.push({ key: packKey(region, 'contours'), kind: 'json' });
    if (!OSM_BUILT_REGIONS.includes(region)) continue;
    for (const layer of OSM_LAYERS) out.push({ key: osmKey(region, layer), kind: 'json' });
  }
  return out;
}

/**
 * Разбор JSON с указанием места. Возвращает `null`, если всё хорошо, иначе —
 * позицию и кусок текста вокруг неё: по одному тексту исключения нельзя
 * отличить обрыв (позиция = конец строки) от порчи в середине.
 */
export function jsonFailure(text: string): { detail: string } | null {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = /position (\d+)/.exec(message);
    if (!at) return { detail: message.slice(0, 200) };
    const pos = Number(at[1]);
    const tail = pos >= text.length - 1
      ? ' — это КОНЕЦ текста: тело оборвано, а не испорчено'
      : ` — рядом: ${JSON.stringify(text.slice(Math.max(0, pos - 40), pos + 40))}`;
    return { detail: `${message.slice(0, 160)} (длина текста ${text.length})${tail}` };
  }
}

async function checkJson(url: string, key: string, fetchImpl: typeof fetch): Promise<PackCheck> {
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: 'no-store' });
  } catch (err) {
    const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { key, verdict: 'unreachable', detail: name.slice(0, 160), bytes: null };
  }
  if (res.status !== 200) {
    return { key, verdict: 'http', detail: `HTTP ${res.status}`, bytes: null };
  }
  const declared = Number(res.headers.get('content-length') ?? '0') || null;
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    // Обрыв ПОСЛЕ заголовков — ровно то, что искали: тело не доехало.
    const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { key, verdict: 'truncated', detail: `тело оборвалось: ${name.slice(0, 120)}`, bytes: null };
  }
  const bytes = buf.byteLength;
  if (declared !== null && bytes !== declared) {
    return {
      key, verdict: 'truncated', bytes,
      detail: `Content-Length ${declared}, пришло ${bytes} (${declared - bytes} байт не доехало)`,
    };
  }
  const bad = jsonFailure(new TextDecoder().decode(buf));
  if (bad) return { key, verdict: 'bad_json', detail: bad.detail, bytes };
  return { key, verdict: 'ok', detail: `${(bytes / 1024 / 1024).toFixed(2)} МБ, JSON разобран`, bytes };
}

/** Заголовок архива — тот же первый запрос, что делает читатель PMTiles. */
async function checkArchive(url: string, key: string, fetchImpl: typeof fetch): Promise<PackCheck> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { range: 'bytes=0-16383' }, cache: 'no-store' });
  } catch (err) {
    const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { key, verdict: 'unreachable', detail: name.slice(0, 160), bytes: null };
  }
  if (res.status !== 206 && res.status !== 200) {
    return { key, verdict: 'http', detail: `HTTP ${res.status}`, bytes: null };
  }
  const head = new Uint8Array(await res.arrayBuffer());
  const magic = new TextDecoder().decode(head.slice(0, 7));
  if (magic !== 'PMTiles') {
    // Не JSON, но беда того же рода: файл на месте и не является собой.
    return { key, verdict: 'bad_json', detail: `заголовок не PMTiles: ${JSON.stringify(magic)}`, bytes: head.length };
  }
  return { key, verdict: 'ok', detail: `HTTP ${res.status}, заголовок PMTiles на месте`, bytes: head.length };
}

/**
 * Адрес файла по ключу. Собирается `new URL`, а не склейкой строк с
 * подрезкой хвостовых слэшей: разбор адреса — работа платформы, и свой
 * разбор здесь означал бы свои же краевые случаи (двойной слэш, база с
 * путём, база без схемы).
 */
export function packUrl(baseUrl: string, key: string): string {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error(`Адрес хранилища должен быть http(s), получено: ${base.protocol}`);
  }
  return new URL(key, base).toString();
}

export async function verifyPacks(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PackCheck[]> {
  const out: PackCheck[] = [];
  for (const { key, kind } of packKeysToVerify()) {
    const url = packUrl(baseUrl, key);
    out.push(kind === 'json'
      ? await checkJson(url, key, fetchImpl)
      : await checkArchive(url, key, fetchImpl));
  }
  return out;
}

const VERDICT_LABEL: Record<PackVerdict, string> = {
  ok: 'цел',
  truncated: 'ОБОРВАН',
  bad_json: 'НЕ ЧИТАЕТСЯ',
  http: 'НЕ ОТДАН',
  unreachable: 'не смог проверить',
};

async function main(): Promise<number> {
  const base = process.env.MAP_PACK_BASE_URL
    || (process.env.S3_BUCKET
      ? `${process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru'}/${process.env.S3_BUCKET}`
      : '');
  if (!base) {
    console.error('Не задан адрес хранилища: нужен MAP_PACK_BASE_URL либо S3_BUCKET (+ S3_ENDPOINT).');
    return 2;
  }

  const checks = await verifyPacks(base);
  for (const c of checks) {
    const label = VERDICT_LABEL[c.verdict];
    console.log(`${c.verdict === 'ok' ? ' ' : '!'} ${c.key}: ${label} — ${c.detail}`);
  }

  const broken = checks.filter(c => c.verdict === 'truncated' || c.verdict === 'bad_json' || c.verdict === 'http');
  const unknown = checks.filter(c => c.verdict === 'unreachable');

  // Сводку прогона пишет сам workflow, перенаправляя этот вывод: скрипт
  // ничего не знает про GitHub и никуда не пишет по чужому пути.
  console.log('');
  console.log(`проверено ${checks.length}, испорчено ${broken.length}, не смогли проверить ${unknown.length}`);
  if (broken.length > 0) return 1;
  // «Не смог проверить» — не успех: зелёный прогон здесь означал бы, что
  // пакеты в порядке, а мы этого не знаем (§4.0).
  if (unknown.length > 0) return 3;
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('verify-packs.ts')) {
  main().then(code => process.exit(code)).catch(err => {
    console.error('Проверка не состоялась:', err);
    process.exit(2);
  });
}
