/**
 * Правка готового плана фразой — разбор по правилам, без модели (фича 5
 * супер-планера, 23.11). Чистый модуль: фраза → намерения → аргументы той же
 * правки, что у MCP `edit_trip_plan` (`readPlanEdit` → `applyPlanEdit`).
 * Остальные дни плана правка не трогает — это не перегенерация.
 *
 * Правило «без догадок» (слово владельца 23.11): часть фразы, которую
 * правила не узнали, — отказ всей фразы с примерами, а не «наверное, вы
 * имели в виду». Какой день убирается при «на день короче», сказано в
 * ответе словами (`said`), и правку можно отменить одной кнопкой.
 *
 * Импорт — только словарь интересов (сам без импортов): модуль годится и
 * серверу, и браузеру.
 */
import { INTEREST_WORDS, parseInterestWords } from './interest-words';

/** Минимум дня, по которому разбор выбирает дни. */
export interface PhraseDay {
  day: number;
  type?: string;
  title?: string;
  activityType?: string;
  realTour?: { tourId: string } | null;
  roadLeg?: { tourId: string } | null;
}

/** Аргументы правки в форме MCP `edit_trip_plan` (строки, как у агента). */
export interface EditArgs {
  action: string;
  day?: string;
  to_day?: string;
  interest?: string;
  lodging?: string;
  shift_days?: string;
  adults?: string;
}

/** Что человек попросил — до выбора номеров дней (номера считаются по текущему плану). */
export type PhraseIntent =
  | { kind: 'remove_day'; day: number }
  | { kind: 'remove_interest'; interests: string[]; words: string }
  | { kind: 'shorter'; days: number }
  | { kind: 'add_day'; interest: string }
  | { kind: 'replace_day'; day: number; interest: string }
  | { kind: 'move_day'; day: number; to: number }
  | { kind: 'set_lodging'; tier: 'economy' | 'comfort' | 'premium' }
  | { kind: 'shift_dates'; days: number }
  | { kind: 'set_party'; adults: number };

export type PhraseParse =
  | { ok: true; intents: PhraseIntent[] }
  | { ok: false; error: string };

/** Примеры для подсказки и для отказа — те, что разбор точно понимает. */
export const PHRASE_EXAMPLES: readonly string[] = [
  'без рыбалки', 'на день короче', 'замени день 3 на вулкан', 'добавь день рыбалки',
  'убери день 4', 'поставь день 5 на место 2', 'подешевле', 'на неделю позже', 'нас трое',
];

const MAX_PHRASE = 300;

/** Числа словами — только те, что встречаются в правке плана. */
const NUMBER_WORDS: Record<string, number> = {
  один: 1, одну: 1, одного: 1, день: 1, неделю: 1,
  два: 2, две: 2, двое: 2, двух: 2,
  три: 3, трое: 3, трех: 3,
  четыре: 4, четверо: 4, пять: 5, пятеро: 5, шесть: 6, шестеро: 6, семь: 7, семеро: 7,
};

function num(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d{1,2}$/.test(raw)) return Number(raw);
  return NUMBER_WORDS[raw] ?? null;
}

/** Служебные слова рядом с занятием: «день рыбалки», «морские прогулки». */
const FILLER = /^(?:и|или|день|дня|дни|дней|все|всех|всю|никак\S*|на|с|по|к|в|прогулк\S*|экскурси\S*|тур|туры|туров|поездк\S*)$/;

/**
 * В словах — только занятия и служебные слова. «Без рыбалки, чтобы весело»
 * не читается как «без рыбалки»: лишнее слово — отказ, а не молчаливый пропуск.
 */
function onlyInterestWords(words: string): boolean {
  const stems = Object.keys(INTEREST_WORDS);
  return words.split(/\s+/).filter(Boolean).every((w) => FILLER.test(w) || stems.some((st) => w.includes(st)));
}

/** Одно занятие из слов; ноль или два разных — null (не угадываем). */
function oneInterest(words: string): string | null {
  if (!onlyInterestWords(words)) return null;
  const keys = parseInterestWords(words);
  return keys.length === 1 ? keys[0] : null;
}

/** Ключи движка, которые значат одно и то же занятие в днях плана. */
const SAME_ACTIVITY: Record<string, readonly string[]> = {
  thermal: ['thermal', 'hot_spring'],
  boat_trip: ['boat_trip', 'sea'],
};

const VERB_AHEAD = /\s+(?:и|а|а также|потом|затем)\s+(?=(?:убер|удал|вычеркн|добав|замен|помен|постав|перестав|перенес|сдвин|без\s|не надо|день\s+\d|на\s+(?:\S+\s+)?(?:дн|день|недел)|нас\s|подешевл|дешевл|подорож|эконом|комфорт|премиум))/;

/** Фраза → части по запятым, точкам с запятой и «и/а/потом» перед новым глаголом. */
function clauses(phrase: string): string[] {
  return phrase
    .split(/[,;]|\.(?:\s|$)/)
    .flatMap((part) => part.split(VERB_AHEAD))
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseClause(c: string): PhraseIntent | null {
  let m: RegExpMatchArray | null;
  // «убери день 4», «удали 4 день»
  if ((m = c.match(/^(?:убери|убрать|удали|удалить|вычеркни)\s+(?:(?:день|дня)\s+(\d{1,2})|(\d{1,2})(?:-?й)?\s+день)$/))) {
    return { kind: 'remove_day', day: Number(m[1] ?? m[2]) };
  }
  // «поставь день 5 на место 2», «перенеси день 5 на 2»
  if ((m = c.match(/^(?:переставь|перенеси|поставь|передвинь|перемести)\s+день\s+(\d{1,2})\s+на\s+(?:место\s+(?:дня\s+)?|день\s+)?(\d{1,2})$/))) {
    return { kind: 'move_day', day: Number(m[1]), to: Number(m[2]) };
  }
  // «замени день 3 на вулкан», «вместо дня 3 вулкан», «день 3 — рыбалка»
  if ((m = c.match(/^(?:замени|заменить|поменяй)\s+день\s+(\d{1,2})\s+(?:на\s+)?(.+)$/))
    ?? (m = c.match(/^вместо\s+дня\s+(\d{1,2})\s+(.+)$/))
    ?? (m = c.match(/^день\s+(\d{1,2})\s*[—–-]\s*(.+)$/))) {
    const interest = oneInterest(m[2]);
    return interest ? { kind: 'replace_day', day: Number(m[1]), interest } : null;
  }
  // «на день короче», «короче на два дня»
  if ((m = c.match(/^(?:сделай\s+)?(?:поездку\s+)?(?:на\s+(?:(\S+)\s+)?(?:день|дня|дней)\s+короче|короче\s+на\s+(\S+)(?:\s+(?:день|дня|дней))?)$/))) {
    const n = m[1] === undefined && m[2] === undefined ? 1 : num(m[1] ?? m[2]);
    return n && n <= 7 ? { kind: 'shorter', days: n } : null;
  }
  // «на неделю позже», «на 3 дня раньше»
  if ((m = c.match(/^(?:сдвинь\s+|перенеси\s+)?(?:поездку\s+)?на\s+(\S+)(?:\s+(день|дня|дней|неделю|недели|недель))?\s+(позже|раньше)$/))) {
    const word = m[1];
    const unit = m[2] ?? (word === 'неделю' ? 'неделю' : word === 'день' ? 'день' : '');
    const n = num(word);
    if (!n || !unit) return null;
    const days = /недел/.test(unit) ? (word === 'неделю' ? 7 : n * 7) : n;
    return { kind: 'shift_dates', days: m[3] === 'позже' ? days : -days };
  }
  // «добавь день рыбалки», «добавь вулкан», «ещё день рыбалки»
  if ((m = c.match(/^(?:добавь|добавить|ещё|еще|плюс)\s+(?:один\s+)?(?:день\s+)?(.+)$/))) {
    const interest = oneInterest(m[1]);
    return interest ? { kind: 'add_day', interest } : null;
  }
  // «без рыбалки», «убери рыбалку», «не надо вулканов»
  if ((m = c.match(/^(?:без|убери|убрать|удали|не надо|не нужн[аоы]?)\s+(.+)$/))) {
    const keys = onlyInterestWords(m[1]) ? parseInterestWords(m[1]) : [];
    return keys.length > 0 ? { kind: 'remove_interest', interests: keys, words: m[1] } : null;
  }
  if (/^(?:подешевле|дешевле|жиль[её] подешевле|эконом(?:ное)?(?: жиль[её])?)$/.test(c)) return { kind: 'set_lodging', tier: 'economy' };
  if (/^(?:комфорт(?:ное)?(?: жиль[её])?)$/.test(c)) return { kind: 'set_lodging', tier: 'comfort' };
  if (/^(?:подороже|премиум(?: жиль[её])?|люкс)$/.test(c)) return { kind: 'set_lodging', tier: 'premium' };
  // «нас трое», «нас 4», «4 взрослых»
  if ((m = c.match(/^(?:нас\s+(\S+)|(\d{1,2})\s+взрослы[хй])$/))) {
    const n = num(m[1] ?? m[2]);
    return n && n >= 1 && n <= 30 ? { kind: 'set_party', adults: n } : null;
  }
  return null;
}

/** Фраза → намерения. Любая неузнанная часть — отказ всей фразы. */
export function parsePlanPhrase(raw: string): PhraseParse {
  const phrase = (raw ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (!phrase) return { ok: false, error: `Напишите, что поправить, например: ${examplesText()}.` };
  if (phrase.length > MAX_PHRASE) return { ok: false, error: `Фраза длиннее ${MAX_PHRASE} знаков — скажите короче, по одной правке через запятую.` };
  const intents: PhraseIntent[] = [];
  for (const c of clauses(phrase)) {
    const intent = parseClause(c);
    if (!intent) return { ok: false, error: `Не понял «${c}» — план не менял. Можно так: ${examplesText()}.` };
    intents.push(intent);
  }
  if (intents.length > 5) return { ok: false, error: 'Больше пяти правок за раз не делаю — разбейте на две фразы.' };
  return { ok: true, intents };
}

function examplesText(): string {
  return PHRASE_EXAMPLES.map((e) => `«${e}»`).join(', ');
}

const MOVABLE = new Set(['activity', 'rest', 'buffer']);

/** Дни одного тура (с днями дороги связки) — убираются вместе. */
function groupKey(d: PhraseDay): string | null {
  return d.realTour?.tourId ?? d.roadLeg?.tourId ?? null;
}

function groupSize(days: readonly PhraseDay[], d: PhraseDay): number {
  const k = groupKey(d);
  return k ? days.filter((x) => groupKey(x) === k).length : 1;
}

export type ResolvedIntent =
  | { ok: true; args: EditArgs[]; said: string }
  | { ok: false; error: string };

/**
 * Намерение → аргументы `edit_trip_plan` по ТЕКУЩЕМУ плану. Номера дней
 * убывают: правка позднего дня не сдвигает номера ранних.
 */
export function resolveIntent(intent: PhraseIntent, days: readonly PhraseDay[], names: Record<string, string> = {}): ResolvedIntent {
  const title = (d: PhraseDay) => `день ${d.day} «${d.title ?? ''}»`;
  switch (intent.kind) {
    case 'remove_day':
      return { ok: true, args: [{ action: 'remove_day', day: String(intent.day) }], said: `убрать день ${intent.day}` };
    case 'move_day':
      return { ok: true, args: [{ action: 'move_day', day: String(intent.day), to_day: String(intent.to) }], said: `день ${intent.day} — на место ${intent.to}` };
    case 'replace_day':
      return { ok: true, args: [{ action: 'replace_day', day: String(intent.day), interest: intent.interest }], said: `день ${intent.day} — ${names[intent.interest] ?? intent.interest}` };
    case 'add_day':
      return { ok: true, args: [{ action: 'add_day', interest: intent.interest }], said: `добавить день: ${names[intent.interest] ?? intent.interest}` };
    case 'set_lodging':
      return { ok: true, args: [{ action: 'set_lodging', lodging: intent.tier }], said: `жильё: ${{ economy: 'эконом', comfort: 'комфорт', premium: 'премиум' }[intent.tier]}` };
    case 'shift_dates':
      return { ok: true, args: [{ action: 'shift_dates', shift_days: String(intent.days) }], said: `поездка на ${Math.abs(intent.days)} дн. ${intent.days > 0 ? 'позже' : 'раньше'}` };
    case 'set_party':
      return { ok: true, args: [{ action: 'set_party', adults: String(intent.adults) }], said: `взрослых: ${intent.adults}` };
    case 'remove_interest': {
      const wanted = new Set(intent.interests.flatMap((k) => SAME_ACTIVITY[k] ?? [k]));
      const hit = days.filter((d) => d.type === 'activity' && d.activityType && wanted.has(d.activityType));
      if (hit.length === 0) return { ok: false, error: `В плане нет дней «${intent.words}» — убирать нечего.` };
      // Один представитель на тур (многодневный тур и связка убираются целиком).
      const seen = new Set<string>();
      const picks: PhraseDay[] = [];
      for (const d of [...hit].sort((a, b) => b.day - a.day)) {
        const k = groupKey(d);
        if (k && seen.has(k)) continue;
        if (k) seen.add(k);
        picks.push(d);
      }
      return {
        ok: true,
        args: picks.map((d) => ({ action: 'remove_day', day: String(d.day) })),
        said: `убрать ${picks.map(title).join(', ')}`,
      };
    }
    case 'shorter': {
      // Какой день убрать — правило, а не догадка: сначала свободные дни и
      // дни отдыха, потом последние однодневные занятия перед отъездом.
      // Многодневный тур целиком ради «на день короче» не снимаем.
      const single = days.filter((d) => MOVABLE.has(d.type ?? '') && d.type !== 'buffer' && groupSize(days, d) === 1);
      const rest = single.filter((d) => d.type === 'rest').sort((a, b) => b.day - a.day);
      const act = single.filter((d) => d.type === 'activity').sort((a, b) => b.day - a.day);
      const picks = [...rest, ...act].slice(0, intent.days).sort((a, b) => b.day - a.day);
      if (picks.length < intent.days) {
        return { ok: false, error: `Сделать поездку на ${intent.days} дн. короче не выходит: свободных и однодневных дней, которые можно убрать, меньше. Скажите, какой день убрать («убери день 4»).` };
      }
      return { ok: true, args: picks.map((d) => ({ action: 'remove_day', day: String(d.day) })), said: `на ${intent.days} дн. короче: убрать ${picks.map(title).join(', ')}` };
    }
  }
}
