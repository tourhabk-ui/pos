/**
 * lib/agents/scout-study.ts — разведчик изучает НАЗВАННЫЙ источник.
 *
 * ── Зачем понадобилось ───────────────────────────────────────────────────
 *
 * 29.08 владелец спросил про частоты LoRa-региона RU и попросил «заставь
 * разведчика изучить meshtastic.org и доложить». Не вышло, и по трём
 * разным причинам сразу:
 *
 *   1. Разведчик по устройству — суточный RSS-дайджест. Он ходит по ленте
 *      источников, которую ему задали заранее, и не умеет «сходи вот
 *      сюда и ответь вот на это»;
 *   2. рабочая среда разработчика закрывает часть доменов egress-политикой,
 *      а прод — нет. То есть прод МОЖЕТ прочитать то, что не может человек
 *      за клавиатурой;
 *   3. ответ пришлось добывать поиском, и в MESH.md он лёг с пометкой
 *      «глазами не читан» — честно, но это работа, которую платформа
 *      должна уметь делать сама.
 *
 * Здесь — недостающий инструмент: взять адрес и вопрос, прочитать источник,
 * ответить ТОЛЬКО из прочитанного и назвать, чего в нём не нашлось.
 *
 * ── Что здесь НЕ делается ────────────────────────────────────────────────
 *
 * Сеть живёт не здесь. Разбор и правила судятся тестами, а не прогоном по
 * живому чужому сайту — тот же порядок, что в lib/security/site-probe.ts.
 * Этот модуль чистый: ему передают уже добытый текст.
 */

import type { ChatMessage } from '@/lib/ai/prompts';
import { htmlToText as canonicalHtmlToText } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

/** Чем закончилось изучение. Исходов ТРИ, и «не смог» не равен «нечего сказать» (§4.0). */
export type StudyOutcome =
  /** Источник прочитан, на вопрос есть ответ из его текста. */
  | { kind: 'answered'; answer: string; quotes: string[] }
  /** Источник прочитан, но нужного в нём нет. Это ФАКТ об источнике, не сбой. */
  | { kind: 'not_in_source'; note: string }
  /** Прочитать или разобрать не удалось. Причина обязана быть названа. */
  | { kind: 'failed'; reason: string };

/** Сколько текста источника отдаём модели. Больше — дороже и без пользы: суть страницы в начале. */
export const SOURCE_CHARS_LIMIT = 24_000;

/**
 * HTML → текст источника.
 *
 * Своего разбора здесь НЕТ намеренно, и это не вкусовщина: первая версия
 * этого файла несла собственную регулярку — и сторожа репозитория
 * (tests/unit/html-text.test.ts, html-entities.test.ts) поймали в ней ровно
 * тот дефект, ради которого заведены. `<\/script>` требовался точным, а
 * браузер принимает `</script >` и `</script foo>` — тело чужого скрипта
 * осталось бы в «тексте страницы» и уехало прямо в промпт модели. Разворот
 * сущностей цепочкой замен — вторая та же ошибка (двойное раскрытие).
 *
 * Поэтому: разбор — канонический `lib/html/text`, сущности — канонический
 * `decodeHtmlEntities`. Разбор в репозитории один.
 */
export function sourceHtmlToText(html: string): string {
  return decodeHtmlEntities(canonicalHtmlToText(html));
}

/** Обрезка по границе строки: рвать число пополам — верный способ получить враньё. */
export function clipForModel(text: string, limit = SOURCE_CHARS_LIMIT): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > limit * 0.5 ? cut.slice(0, lastBreak) : cut;
}

/**
 * Промпт изучателя.
 *
 * Правило владельца о промптах (§8): добавлять ПРИНЦИПЫ, не перечни кейсов.
 * Принцип здесь один и он же главный запрет платформы — не выдумывать:
 * модель отвечает только из поданного текста и обязана прямо сказать, если
 * нужного там нет. Пустой ответ лучше придуманного (§4.0).
 */
export function buildStudyMessages(source: string, question: string, text: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Ты изучаешь один источник и отвечаешь строго по его тексту.',
        'Правила, нарушать которые нельзя:',
        '1. Отвечай ТОЛЬКО тем, что есть в поданном тексте. Ничего не добавляй по памяти.',
        '2. Если ответа в тексте нет — так и скажи. Это нормальный исход, а не неудача.',
        '3. Каждое утверждение подкрепляй дословной цитатой из текста.',
        '4. Числа, единицы измерения и названия переноси буквально, не округляй и не пересчитывай.',
        'Ответ верни строгим JSON без markdown-обёртки:',
        '{"found": true|false, "answer": "...", "quotes": ["...", "..."], "missing": "..."}',
        'found=false — если нужного в тексте нет; тогда answer пустой, а missing называет, чего именно не нашлось.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Источник: ${source}\nВопрос: ${question}\n\nТекст источника:\n${clipForModel(text)}`,
    },
  ];
}

interface RawVerdict {
  found?: unknown;
  answer?: unknown;
  quotes?: unknown;
  missing?: unknown;
}

/**
 * Разбор ответа модели в исход.
 *
 * Неразобранный ответ — это `failed`, а НЕ «в источнике ничего нет»: разница
 * между «модель не ответила» и «источник молчит» ровно та, на которой уже
 * обжигались (см. шапку scout-diagnose: заглушка отказа провайдеров
 * двадцать один день читалась как ответ модели).
 */
export function parseStudyVerdict(raw: string | null): StudyOutcome {
  if (!raw || !raw.trim()) {
    return { kind: 'failed', reason: 'модель не ответила' };
  }

  // Модели любят обрамлять JSON в ```json — снимаем, но не «чиним» содержимое.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { kind: 'failed', reason: `ответ не похож на JSON: ${cleaned.slice(0, 120)}` };
  }

  let parsed: RawVerdict;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as RawVerdict;
  } catch {
    return { kind: 'failed', reason: `JSON не разобрался: ${cleaned.slice(0, 120)}` };
  }

  const quotes = Array.isArray(parsed.quotes)
    ? parsed.quotes.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    : [];
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';

  if (parsed.found !== true) {
    const missing = typeof parsed.missing === 'string' && parsed.missing.trim()
      ? parsed.missing.trim()
      : 'модель не назвала, чего именно не нашлось';
    return { kind: 'not_in_source', note: missing };
  }

  if (!answer) {
    return { kind: 'failed', reason: 'модель отметила found=true, но ответ пуст' };
  }

  // Ответ без единой цитаты — ровно то, что промпт запрещает. Пропустить его
  // значит принять пересказ по памяти за факт из источника.
  if (quotes.length === 0) {
    return { kind: 'failed', reason: 'ответ без цитат из источника — принять нельзя' };
  }

  return { kind: 'answered', answer, quotes };
}

/** Строка для журнала и Telegram: исход обязан читаться без открывания JSON. */
export function describeOutcome(outcome: StudyOutcome): string {
  switch (outcome.kind) {
    case 'answered':
      return `нашёл ответ (${outcome.quotes.length} цит.)`;
    case 'not_in_source':
      return `в источнике нет: ${outcome.note}`;
    case 'failed':
      return `не смог: ${outcome.reason}`;
  }
}
