/**
 * Машинный перевод публичных текстов на китайский — честный по построению
 * (аудит 15.10, CN-pages; Китай, шаг 7, вариант «в»: малый объём с честной
 * пометкой машинного перевода).
 *
 * ── Что переводится, а что нет ────────────────────────────────────────────
 *
 * Моделью переводятся только тексты, у которых нет другого источника, кроме
 * слов оператора: у живого тура — название, краткое описание, описание,
 * программа, что включено / не включено, что взять; у места — описание
 * (ZH_TOUR_FIELDS, ZH_PLACE_FIELDS). Цифры, цены, даты, длительность, группа,
 * телефоны, опасности и правила безопасности моделью НЕ переводятся: страница
 * берёт их из полей базы при показе (lib/zh/entry — priceZh, durationZh;
 * опасности и safety_notes — по-русски с пометкой). Модель, которой отдали
 * цену, могла бы её «перевести» неверно, и турист поверил бы китайской цифре.
 *
 * ── Почему перевод нельзя принять на веру ─────────────────────────────────
 *
 * Модель дописывает. Поэтому:
 *   - промпт просит дословно и прямо разрешает пустую строку вместо догадки;
 *   - ответ сверяется детерминированно (checkSegment): в переводе те же числа,
 *     что в исходнике, и ни одного нового; латинские слова исходника на
 *     месте; в переводе есть иероглифы (русский текст, вернувшийся как есть, —
 *     не перевод); пустой сегмент — отказ, а не «перевод пустой»;
 *   - исходник уходит в модель через redactPII: в описаниях бывают телефоны
 *     оператора, а провайдеры из водопада — зарубежные;
 *   - обратный перевод на русский пишется рядом (back_translation), чтобы
 *     владелец сверял по-русски, не читая по-китайски.
 *
 * Отказ любого шага — «не переведено» с причиной (§4.0). Пустая строка как
 * перевод не записывается никогда (и CHECK в миграции 1283 это держит).
 *
 * ── Устаревание ───────────────────────────────────────────────────────────
 *
 * sourceHash — SHA-256 нормализованного поля. Хранится рядом с переводом; при
 * показе считается заново от живого поля. Не совпал — перевод устарел, и
 * страница показывает русский текст с пометкой, а не старый китайский.
 *
 * Модель — только через обёртки водопада (CLAUDE.md §4, сторож
 * ai-direct-calls): прямой путь у перевода — качественный (callAIQualityOrNull:
 * провайдеры по очереди, первым DeepSeek), обратный — быстрый (callAIFastOrNull).
 */

import type { ChatMessage } from '@/lib/ai/prompts';
import { callAIQualityOrNull, callAIFastOrNull } from '@/lib/ai/providers';
import { redactPII } from '@/lib/security/pii-redact';
import {
  ZH_MODEL_PATH, checkSegment, fromSegments, toSegments,
  type ZhFieldKind, type ZhFieldValue,
} from '@/lib/zh/fields';

// ── Промпт и разбор ответа ──────────────────────────────────────────────

const FORWARD_SYSTEM = [
  'Ты переводишь тексты туристической платформы о Камчатке с русского на упрощённый китайский (zh-CN).',
  'Переводи дословно и полно: ничего не добавляй, не опускай, не поясняй и не украшай.',
  'Числа, цены, даты, время, номера, адреса сайтов, латинские слова и фрагменты в квадратных скобках переноси без изменений, цифрами как в исходнике.',
  'Не превращай слова в числа и числа в слова.',
  'Названия мест и компаний передавай общепринятым китайским названием, только если уверен в нём; иначе оставь русское написание.',
  'Если сегмент нельзя перевести без догадки, верни для него пустую строку: пустая строка лучше выдумки.',
  'Ответ — только JSON вида {"segments": ["..."]}: столько же строк, в том же порядке, что во входе.',
].join(' ');

const BACK_SYSTEM = [
  'Переведи сегменты с китайского на русский дословно, ничего не добавляя и не опуская.',
  'Числа и латинские слова переноси без изменений.',
  'Ответ — только JSON вида {"segments": ["..."]}: столько же строк, в том же порядке.',
].join(' ');

function messagesFor(system: string, segments: readonly string[]): ChatMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ segments }) },
  ];
}

/** Ответ модели → сегменты. null — не JSON нужной формы или не той длины. */
export function parseSegments(answer: string, n: number): string[] | null {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
  const segs = (parsed as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(segs) || segs.length !== n || !segs.every((s) => typeof s === 'string')) return null;
  return segs as string[];
}

/** Потолок ответа по длине входа: китайский короче русского, плюс запас на JSON. */
function maxTokensFor(segments: readonly string[]): number {
  const chars = segments.reduce((s, x) => s + x.length, 0);
  return Math.min(8000, Math.max(800, Math.ceil(chars * 1.5) + 400));
}

export type ZhTranslateOutcome =
  | { ok: true; zh: ZhFieldValue; back: ZhFieldValue | null; model: string }
  | { ok: false; reason: string };

/**
 * Перевести поле. Исходник — уже нормализованный (normalizeSource). Модель
 * получает текст после redactPII; сверка идёт с тем, что модель видела.
 */
export async function translateFieldValue(kind: ZhFieldKind, source: ZhFieldValue): Promise<ZhTranslateOutcome> {
  const segments = toSegments(kind, source).map((s) => redactPII(s));
  if (segments.length === 0) return { ok: false, reason: 'исходник пуст — переводить нечего' };

  let answer: string | null;
  try {
    answer = await callAIQualityOrNull(messagesFor(FORWARD_SYSTEM, segments), {
      json: true, temperature: 0.2, deepThinking: false, maxTokens: maxTokensFor(segments),
    });
  } catch (err) {
    return { ok: false, reason: `вызов модели упал: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
  if (answer === null) return { ok: false, reason: 'модель не ответила: отказали все провайдеры водопада' };

  const zhSegs = parseSegments(answer, segments.length);
  if (!zhSegs) return { ok: false, reason: `ответ модели не JSON из ${segments.length} сегментов` };
  for (let i = 0; i < segments.length; i++) {
    const why = checkSegment(segments[i], zhSegs[i]);
    if (why) return { ok: false, reason: `сегмент ${i + 1}: ${why}` };
  }
  const zh = fromSegments(kind, source, zhSegs.map((s) => s.trim()));
  if (zh === null) return { ok: false, reason: 'перевод не собрался в форму исходника' };

  // Обратный перевод — для сверки владельцем по-русски. Не получен — NULL в
  // колонке, а не выдуманный текст; прямой перевод от этого не отменяется:
  // его уже сверили детерминированно.
  let back: ZhFieldValue | null = null;
  try {
    const backAnswer = await callAIFastOrNull(messagesFor(BACK_SYSTEM, toSegments(kind, zh)), {
      json: true, maxTokens: maxTokensFor(segments),
    });
    const backSegs = backAnswer === null ? null : parseSegments(backAnswer, segments.length);
    back = backSegs ? fromSegments(kind, source, backSegs.map((s) => s.trim())) : null;
    if (back === null) console.error('[zh-translate] обратный перевод не получен:', backAnswer === null ? 'модель не ответила' : 'ответ не той формы');
  } catch (err) {
    console.error('[zh-translate] обратный перевод упал:', err instanceof Error ? err.message : String(err));
  }
  return { ok: true, zh, back, model: ZH_MODEL_PATH };
}
