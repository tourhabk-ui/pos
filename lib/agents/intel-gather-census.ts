/**
 * lib/agents/intel-gather-census.ts — почему у разведки пусто.
 *
 * ── Что случилось 30.08 ───────────────────────────────────────────────────
 *
 * Watchdog третьи сутки писал: «Intelligence Monitor — 4 прогонов подряд без
 * результата, успеха не было за всё окно, чаще всего: no_signals». А в
 * словаре исходов `no_signals` объявлен как «источники ответили, но пусто» —
 * то есть утверждение О ФАКТЕ: источники ЖИВЫ, новостей НЕТ.
 *
 * Код это утверждение подтвердить не мог. Исход `gather_failed` в словаре
 * есть, но НЕДОСТИЖИМ на практике: он выставляется только если промис домена
 * отклонён, а `gatherDomain` не отклоняется никогда — каждый отказ ленты
 * проглочен в `[]` собственным `.catch`, а поисковики отвечают `[]` и на
 * отсутствие ключа (`if (!key) return []`), и на отказ сети
 * (`if (!res.ok) return []`).
 *
 * Три разные реальности — ключа нет, источник недоступен, источник пуст —
 * приходили владельцу одним словом, и это слово называло самую безобидную
 * из трёх.
 *
 * ── Почему это не догадка ─────────────────────────────────────────────────
 *
 * В том же отчёте, строкой выше: «OpenRouter недоступен... режет край сети
 * по нашему адресу» и «Anthropic недоступен». А ленты разведки — это
 * openai.com, anthropic.com, blog.google, huggingface.co, skift.com. Те же
 * зарубежные хосты, тот же прод, тот же край сети.
 *
 * Утверждать, что дело именно в этом, отсюда нельзя — но именно поэтому и
 * нужен честный исход: пусть код скажет, ответила ли лента, вместо того
 * чтобы мы гадали.
 *
 * ── Чего перепись НЕ охватывает ───────────────────────────────────────────
 *
 * Поисковых API (Tavily, Brave). Их помощники глушат отказ внутри себя и
 * наружу отдают пустой список, неотличимый от «ничего не нашлось». Поэтому
 * перепись считает ТОЛЬКО ленты и говорит именно про ленты — «ни одна из N
 * лент не ответила», а не «ни один источник». Обещать больше, чем измерено,
 * — та же болезнь, которую тут чинят.
 */

/** Что вышло при опросе лент домена. */
export interface GatherCensus {
  /** Сколько лент пытались опросить. */
  attempted: number;
  /** Сколько ответили (пусть даже пустым списком). */
  answered: number;
  /** Сколько отказали. */
  failed: number;
  /** Тексты отказов — для отчёта, чтобы чинили конкретное. */
  failures: string[];
  /**
   * Ленты, которые ответили, но не дали ни одной записи — поимённо и с
   * тем, ЧТО они отдали (03.09). «5 из 5 лент ответили и пусты» — класс
   * беды; чинят конкретную ленту, а у пустоты три разных лица: HTML вместо
   * ленты (бот-заслон или сменившийся адрес), лента без записей, чужой
   * формат. Из класса их не различить.
   */
  empties?: string[];
}

/** Что пришло вместо ленты — по корневому тегу, не по заголовку Content-Type. */
export type FeedBodyKind = 'rss' | 'atom' | 'html' | 'json' | 'empty' | 'other';

export function classifyFeedBody(text: string): FeedBodyKind {
  const head = text.slice(0, 2048).trimStart();
  if (!head) return 'empty';
  if (/^\s*[{[]/.test(head)) return 'json';
  if (/<(rss|rdf:RDF)[\s>]/i.test(head)) return 'rss';
  if (/<feed[\s>]/i.test(head)) return 'atom';
  if (/<!doctype html|<html[\s>]/i.test(head)) return 'html';
  return 'other';
}

/** Одна строка о пустой ленте — для причины и для лога. */
export function describeFeedBody(host: string, status: number, bytes: number, kind: FeedBodyKind): string {
  const size = bytes >= 1024 ? `${Math.round(bytes / 1024)} КБ` : `${bytes} Б`;
  const what: Record<FeedBodyKind, string> = {
    rss: 'RSS без записей',
    atom: 'Atom без записей',
    html: 'HTML вместо ленты',
    json: 'JSON вместо ленты',
    empty: 'пустое тело',
    other: 'не лента (неизвестный формат)',
  };
  return `${host}: HTTP ${status}, ${size}, ${what[kind]}`;
}

/** Сколько пустых лент называть в причине. */
const EMPTIES_SHOWN = 5;

/**
 * Вердикт при пустом улове. Возвращает ИМЯ ИСХОДА из словаря
 * IntelligenceOutcome плюс причину словами.
 */
export type EmptyGatherVerdict =
  | { outcome: 'gather_failed'; reason: string }
  | { outcome: 'no_signals'; reason: string };

/** Сколько отказов показывать в причине: строка идёт в алерт, не в отчёт. */
const FAILURES_SHOWN = 3;

/**
 * Пусто — но почему?
 *
 * Правило одно: сказать «источники ответили, но пусто» можно ТОЛЬКО если
 * хоть один источник действительно ответил. Во всех прочих случаях пустота
 * — факт о сети, а не о новостях.
 */
export function judgeEmptyGather(c: GatherCensus): EmptyGatherVerdict {
  if (c.attempted === 0) {
    // Ни одной ленты не настроено. Это не «новостей нет» — это «мы не
    // смотрели», и путать их нельзя: чинится оно в настройке источников.
    return { outcome: 'gather_failed', reason: 'у домена не настроено ни одной ленты' };
  }

  if (c.answered === 0) {
    const shown = c.failures.slice(0, FAILURES_SHOWN).join('; ');
    const tail = c.failures.length > FAILURES_SHOWN
      ? ` (и ещё ${c.failures.length - FAILURES_SHOWN})`
      : '';
    return {
      outcome: 'gather_failed',
      reason: `ни одна из ${c.attempted} лент не ответила${shown ? `: ${shown}${tail}` : ''}`,
    };
  }

  // Хоть кто-то ответил — теперь «пусто» это правда о содержимом. Но если
  // часть лент при этом отказала, об этом всё равно говорим: улов мог быть
  // неполным, и молчать об этом значит выдать частичную картину за полную.
  const partial = c.failed > 0 ? `, ${c.failed} отказали` : '';
  // Поимённо: «ответили и пусты» — класс, а чинят ленту.
  const empties = c.empties ?? [];
  const named = empties.slice(0, EMPTIES_SHOWN).join('; ');
  const more = empties.length > EMPTIES_SHOWN ? ` (и ещё ${empties.length - EMPTIES_SHOWN})` : '';
  return {
    outcome: 'no_signals',
    reason: `${c.answered} из ${c.attempted} лент ответили и пусты${partial}${named ? `: ${named}${more}` : ''}`,
  };
}
