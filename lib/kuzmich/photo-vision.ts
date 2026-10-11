/**
 * Фото Кузьмичу: что видно на снимке — и ничего сверх этого (11.10).
 *
 * Повод — снимок Трёх Братьев от владельца. Кузьмич узнал место верно, но
 * дописал две неправды:
 *   - «на горизонте — Авачинский и Корякский вулканы»: на снимке за водой
 *     низкие сопки противоположного берега, вулкана в кадре нет вовсе, а в
 *     той стороне — Вилючинский; Авачинский и Корякский у снимавшего за спиной;
 *   - «их видно почти с любой точки набережной»: Три Брата стоят на входе в
 *     Авачинскую бухту, с набережной их не видно.
 *
 * Механизм тот же, что с числами в заявках (lib/leads/intent-grounding):
 * место, где нельзя сказать «не знаю», заполняется враньём (§4.0). Снимок
 * смотрит модель зрения с заданием «опиши, определяй вулканы», а отвечает
 * другая модель, которая снимка не видит — только строку описания — и
 * достраивает её «известным» о Петропавловске. Направления съёмки не знает ни
 * та, ни другая: точки съёмки и компаса им никто не даёт.
 *
 * Отсюда три правила, одно на все каналы (сайт, Telegram, MAX, WhatsApp —
 * до 11.10 у каждого был свой промпт):
 *   1. Зрение описывает только видимое и называет вершину на горизонте лишь
 *      по отчётливому узнаваемому силуэту, иначе «сопки на горизонте».
 *   2. Узнанное место сверяется с базой (placeInfoForKuzmich — тот же ответ,
 *      что у инструмента get_place_info), и факты о нём модель чата получает
 *      из базы, а не из памяти.
 *   3. Модели чата сказано прямо: о снимке — только описание и факты базы;
 *      что видно в той стороне, откуда снято и откуда место видно — не
 *      проверено, и этого она не пишет.
 */

import { callVision } from '@/lib/ai/providers';
import { placeInfoForKuzmich } from '@/lib/kuzmich/place-info-tool';

export const KUZMICH_PHOTO_PROMPT = [
  'Опиши снимок для гида по Камчатке. Ответ — строго две строки:',
  'Место: <название, если место уверенно узнаётся по характерным признакам; иначе «не узнал»>',
  'Видно: <1–2 предложения о том, что действительно видно в кадре>',
  '',
  'Правила:',
  '- Только то, что видно в кадре. Не пиши, откуда снято, что за кадром или «в той стороне», откуда это место видно, легенды и историю.',
  '- Гору или вулкан на горизонте называй, только если его силуэт отчётливо виден и узнаётся. Иначе пиши «сопки на горизонте» или «горы в дымке».',
  '- Не уверен — так и пиши («похоже на …»), не угадывай.',
].join('\n');

/**
 * Правило для модели чата — рядом с описанием снимка, в каждом канале.
 * Описание пишет зрение, а модель чата снимка не видит: всё, что она
 * добавит о кадре, будет догадкой.
 */
export const PHOTO_ANSWER_RULE = 'О снимке говори только то, что есть в этом описании и в фактах из базы. '
  + 'Не добавляй, что ещё видно в кадре, что находится в той стороне, откуда снято и откуда это место видно: '
  + 'точки и направления съёмки никто не знает. Спросят — так и скажи и предложи назвать, откуда снимали.';

export interface PhotoReading {
  /** Что видно на снимке — словами зрения. */
  seen: string;
  /** Место, которое зрение уверенно узнало; null — не узнало или не уверено. */
  place: string | null;
}

const NOT_RECOGNIZED = /^(не\s+узнал|не\s+узнано|неизвестно|нет|—|-)\.?$/iu;

/**
 * Разбор ответа зрения. Формат не соблюдён — весь текст считается описанием,
 * места нет: лучше не сверить с базой, чем сверить чужое.
 */
export function parsePhotoReading(text: string): PhotoReading {
  const t = text.trim();
  const placeLine = t.match(/^\s*Место:\s*(.+)$/imu)?.[1]?.trim() ?? null;
  const seenPart = t.match(/^\s*Видно:\s*([\s\S]+)$/imu)?.[1]?.trim() ?? null;
  if (placeLine === null && seenPart === null) return { seen: t, place: null };

  let place: string | null = placeLine ? placeLine.replace(/[«»"]/g, '').trim() : null;
  // «похоже на …» — не узнал уверенно: в описании остаётся, с базой не сверяется.
  const doubtful = place !== null && /^похоже/iu.test(place);
  if (place !== null && (NOT_RECOGNIZED.test(place) || doubtful)) place = null;

  const seen = [doubtful && placeLine ? `Место: ${placeLine}.` : '', seenPart ?? ''].filter(Boolean).join(' ').trim();
  return { seen: seen || t, place };
}

/** Что известно о месте по базе: нашлось, нет в базе, база не ответила. */
export type PlaceFacts =
  | { kind: 'found'; text: string }
  | { kind: 'absent' }
  | { kind: 'failed' };

/**
 * Текст снимка для модели чата: что видно, факты узнанного места из базы и
 * правило. Его и кладут в «[Фото: …]» все каналы.
 */
export function photoForModel(reading: PhotoReading, facts: PlaceFacts | null): string {
  const parts = [`Видно на снимке (описание модели зрения): ${reading.seen}`];
  if (reading.place) {
    const head = `Место по снимку: ${reading.place}.`;
    if (facts?.kind === 'found') parts.push(`${head} Факты о нём из базы Ведара:\n${facts.text}`);
    else if (facts?.kind === 'failed') parts.push(`${head} Факты о нём из базы сейчас не прочитались — сверх описания снимка о месте ничего не утверждай.`);
    else parts.push(`${head} В базе Ведара его нет — фактов о нём сверх описания снимка нет.`);
  }
  parts.push(PHOTO_ANSWER_RULE);
  return parts.join('\n\n');
}

/**
 * Посмотреть фото и приготовить его для модели чата. null — зрение не
 * ответило (причина — в следе callVisionDetailed).
 */
export async function describeKuzmichPhoto(imageBase64: string, mimeType: string): Promise<string | null> {
  const raw = await callVision(imageBase64, mimeType, KUZMICH_PHOTO_PROMPT);
  if (!raw?.trim()) return null;
  const reading = parsePhotoReading(raw);
  if (!reading.place) return photoForModel(reading, null);
  let facts: PlaceFacts;
  try {
    const text = await placeInfoForKuzmich(reading.place, { pageLinks: true });
    facts = text ? { kind: 'found', text } : { kind: 'absent' };
  } catch (err) {
    // Отказ базы — не «места нет» (§4.0): модели так и сказано, причина — в логе.
    console.error('[kuzmich/photo] факты места не прочитаны', (err as { code?: string } | null)?.code ?? '', err instanceof Error ? err.message : err);
    facts = { kind: 'failed' };
  }
  return photoForModel(reading, facts);
}
