/**
 * Аудит снимков мест: тот ли это кадр и не стоит ли он у двух мест сразу.
 *
 * Повод — витрина термальных источников 03.10: у Ходуткинских и
 * Нижне-Вилючинских одна и та же фотография, на кадрах водяной знак фотостока.
 * Владелец: «нужен инструмент сравнения фото с местом из открытых источников,
 * чтоб не было ошибок и дублей одного фото на разных геоточках».
 *
 * Инструмент — две проверки разной силы, и сила названа у каждой:
 *
 *  1. ОТПЕЧАТОК ВОСПРИЯТИЯ (dHash, 64 бита). Детерминирован: один и тот же
 *     кадр, пережатый или уменьшенный, даёт близкий отпечаток. Два места с
 *     расстоянием Хэмминга ≤ DUPLICATE_MAX_DISTANCE — дубль по построению,
 *     без модели и без догадок. md5 байтов такого не видит: после пережатия
 *     байты другие.
 *
 *  2. ЗРЕНИЕ (callVisionDetailed: qwen3-vl-plus с прода). Модель спрашивают
 *     ТРИ вещи, у каждой три исхода: есть ли водяной знак или надпись
 *     фотостока (да / нет / не разобрать), похоже ли изображённое на род места
 *     (да / нет / не разобрать), что изображено одной фразой. Ответ модели —
 *     ПОДСКАЗКА ДЛЯ РАЗБОРА ГЛАЗАМИ, не приговор: критичные факты модели не
 *     доверяются (§8), снимок снимается с показа только рукой человека.
 *
 * Чего здесь НЕТ и почему. Обратный поиск картинки по открытому вебу: у
 * Яндекс.Картинок нет публичного API, TinEye платный и из РФ не достижим;
 * выдавать такой поиск за «проверку по открытым источникам» было бы
 * объявленным исходом без производителя (§10.09). Единственный открытый
 * источник, который платформа умеет спрашивать законно, — Wikimedia Commons
 * по координатам (lib/services/ingest/wikimedia-photos); сверка с ним по
 * отпечатку — следующий шаг, когда отпечатки у наших снимков будут.
 */
import sharp from 'sharp';
import type { VisionResult } from '@/lib/ai/providers';

/** Расстояние Хэмминга, с которого два отпечатка считаются одним кадром. */
export const DUPLICATE_MAX_DISTANCE = 6;

/** Сторона уменьшенной копии, которая уходит модели: токены и сеть, не качество. */
export const VISION_SIDE_PX = 1024;

/**
 * dHash: серый кадр 9x8, бит — «левый пиксель светлее правого». 64 бита как
 * 16 hex-знаков. Поворот и кадрирование отпечаток меняют — это дубли другого
 * рода, их этот инструмент не ловит и не обещает.
 */
export async function dHash(buf: Buffer): Promise<string> {
  const { data } = await sharp(buf)
    .rotate()
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      bits += left > right ? '1' : '0';
    }
  }
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

export function hamming(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

export interface PhotoFingerprint { arkId: string; place: string; phash: string }

/** Пары разных мест с одним кадром по отпечатку. */
export function duplicatePairs(rows: PhotoFingerprint[], maxDistance = DUPLICATE_MAX_DISTANCE): Array<{ a: PhotoFingerprint; b: PhotoFingerprint; distance: number }> {
  const out: Array<{ a: PhotoFingerprint; b: PhotoFingerprint; distance: number }> = [];
  // Пара мест называется один раз, даже если у места несколько строк.
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].arkId === rows[j].arkId) continue;
      const key = [rows[i].arkId, rows[j].arkId].sort().join('|');
      if (seen.has(key)) continue;
      const d = hamming(rows[i].phash, rows[j].phash);
      if (d <= maxDistance) { seen.add(key); out.push({ a: rows[i], b: rows[j], distance: d }); }
    }
  }
  return out.sort((x, y) => x.distance - y.distance || x.a.place.localeCompare(y.a.place));
}

/** Уменьшенная JPEG-копия для модели: base64 и mime. */
export async function visionCopy(buf: Buffer): Promise<{ base64: string; mimeType: string }> {
  const out = await sharp(buf).rotate().resize(VISION_SIDE_PX, VISION_SIDE_PX, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { base64: out.toString('base64'), mimeType: 'image/jpeg' };
}

export type ThreeWay = 'yes' | 'no' | 'unknown';

export interface VisionVerdict {
  /** Что изображено, одной фразой модели. Пусто — модель не ответила. */
  depicts: string;
  /** Водяной знак, логотип или надпись фотостока на кадре. */
  watermark: ThreeWay;
  /** Похоже ли изображённое на род места (термальный источник, вулкан…). */
  matchesType: ThreeWay;
  /** Сырой ответ, если его не удалось разобрать: разбор глазами. */
  raw?: string;
  provider: string | null;
  model: string | null;
}

/**
 * Вопрос модели. Просится ТОЛЬКО то, что видно на кадре: наличие надписей и
 * род объекта. Узнать по снимку конкретное место модель не может, и просить
 * «это Ходуткинские источники?» значило бы заказывать выдумку (§4.0).
 */
export function visionAuditPrompt(placeName: string, typeLabel: string): string {
  return [
    `Снимок подписан как «${placeName}», род места — ${typeLabel}.`,
    'Ответь строго JSON без пояснений, ключи:',
    '"depicts" — что изображено, одна короткая фраза по-русски;',
    '"watermark" — есть ли на кадре водяной знак, логотип или повторяющаяся надпись фотобанка (например alamy, shutterstock, depositphotos): "yes", "no" или "unknown";',
    '"matches_type" — похоже ли изображённое на такой род места: "yes", "no" или "unknown".',
    'Если не уверен — пиши "unknown", не угадывай. Конкретное место по снимку не определяй.',
  ].join(' ');
}

const THREE = new Set(['yes', 'no', 'unknown']);

function three(v: unknown): ThreeWay {
  return typeof v === 'string' && THREE.has(v) ? (v as ThreeWay) : 'unknown';
}

/** Разбор ответа модели: не JSON или не те ключи — всё «unknown», сырой текст сохраняется. */
export function parseVisionVerdict(result: Pick<VisionResult, 'text' | 'legs'>): VisionVerdict {
  const ok = result.legs.find(l => l.outcome === 'ok');
  const base = { provider: ok?.provider ?? null, model: ok?.model ?? null };
  const text = (result.text ?? '').trim();
  if (!text) return { depicts: '', watermark: 'unknown', matchesType: 'unknown', ...base };
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { depicts: '', watermark: 'unknown', matchesType: 'unknown', raw: text.slice(0, 500), ...base };
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    return {
      depicts: typeof j.depicts === 'string' ? j.depicts.slice(0, 300) : '',
      watermark: three(j.watermark),
      matchesType: three(j.matches_type),
      ...base,
    };
  } catch {
    return { depicts: '', watermark: 'unknown', matchesType: 'unknown', raw: text.slice(0, 500), ...base };
  }
}

/** Снимок требует взгляда человека: водяной знак, не тот род, или дубль. */
export function needsHumanEye(v: Pick<VisionVerdict, 'watermark' | 'matchesType'> | null, hasDuplicate: boolean): boolean {
  return hasDuplicate || v?.watermark === 'yes' || v?.matchesType === 'no';
}
