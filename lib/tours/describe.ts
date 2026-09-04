/**
 * Описание тура собирается ИЗ ЕГО СОБСТВЕННЫХ ПОЛЕЙ, а не сочиняется.
 *
 * Повод. Перепись готовности к чужой витрине: из восьми живых туров у шести
 * описание короче 300 знаков, и чинить это некому — агент Editor переписывает
 * описания МЕСТ и МАРШРУТОВ, до operator_tours он не дотягивается вовсе.
 *
 * Почему composition, а не «попросить модель написать». Тур — чужой
 * коммерческий продукт, которого мы не водили. Просить модель написать текст
 * о нём значит заказать выдумку: она напишет про «незабываемые виды» и
 * «опытных гидов», которых мы не проверяли, и подпишет это именем оператора.
 * Это ровно §4.0 CLAUDE.md: обязательное поле, которое нечем заполнить,
 * заполняется враньём. Поэтому текст собирается детерминированно из того, что
 * оператор УЖЕ записал: программа дня, состав, снаряжение, длительность,
 * сложность, сезон, как турист попадает на тур.
 *
 * Модель тут не нужна вовсе, и это не экономия, а свойство: сборка работает
 * при мёртвых провайдерах (04.09 живых было двое из восемнадцати), даёт
 * одинаковый результат на одинаковых данных и не может добавить факт,
 * которого нет во входе.
 *
 * Данных не хватило на 300 знаков — текст НЕ пишется, а прогон называет,
 * каких полей недостаёт. Дописать до порога водой значило бы обменять пустое
 * поле на бесполезное, и перепись бы позеленела, не изменив ничего для
 * покупателя.
 */

import { pickupWording, isPickupType } from '@/lib/tours/pickup';

/** Порог чужих витрин — тот же, что у переписи готовности. */
export const MIN_DESCRIPTION_CHARS = 300;

export interface TourFacts {
  title: string;
  location_name?: string | null;
  activity_type?: string | null;
  duration_hours?: number | null;
  duration_type?: string | null;
  multi_day_count?: number | null;
  difficulty?: string | null;
  season_start?: string | null;
  season_end?: string | null;
  max_participants?: number | null;
  min_participants?: number | null;
  weather_dependent?: boolean | null;
  program?: unknown;
  included?: string[] | null;
  what_to_bring?: string[] | null;
  pickup_type?: string | null;
  pickup_details?: string | null;
}

export interface ComposeResult {
  /** Готовый текст; null — данных не хватило. */
  text: string | null;
  /** Из каких полей собран — для журнала и для спора с оператором. */
  used: string[];
  /** Чего не хватило, когда текста нет. Пусто — текст собран. */
  missing: string[];
  chars: number;
}

const DIFFICULTY_WORDS: Record<string, string> = {
  easy: 'Маршрут несложный: подойдёт без специальной подготовки',
  medium: 'Нагрузка средняя: нужна обычная физическая форма',
  hard: 'Маршрут тяжёлый: нужна хорошая физическая форма и опыт',
  extreme: 'Маршрут экстремальный: только с опытом и снаряжением',
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «2026-06-15» или «06-15» → «15 июня»; не разобралось — null. */
export function seasonPhrase(from: string | null | undefined, to: string | null | undefined): string | null {
  const part = (v: string | null | undefined): string | null => {
    if (!v) return null;
    const m = /(\d{1,2})-(\d{1,2})\s*$/.exec(v.trim());
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${day} ${MONTHS[month - 1]}`;
  };
  const a = part(from);
  const b = part(to);
  if (a && b) return `Сезон — с ${a} по ${b}`;
  if (a) return `Сезон начинается ${a}`;
  if (b) return `Сезон заканчивается ${b}`;
  return null;
}

/** Длительность словами. Часы и дни — разные вопросы, не смешиваем. */
export function durationPhrase(f: TourFacts): string | null {
  if (f.multi_day_count && f.multi_day_count > 1) {
    const d = f.multi_day_count;
    const word = d % 10 === 1 && d % 100 !== 11 ? 'день' : (d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 10 || d % 100 >= 20)) ? 'дня' : 'дней';
    return `Поездка занимает ${d} ${word}`;
  }
  const h = f.duration_hours;
  if (h && h > 0) {
    const rounded = Number.isInteger(h) ? h : Math.round(h * 10) / 10;
    const word = rounded % 10 === 1 && rounded % 100 !== 11 ? 'час' : (rounded % 10 >= 2 && rounded % 10 <= 4 && (rounded % 100 < 10 || rounded % 100 >= 20)) ? 'часа' : 'часов';
    return `Тур занимает около ${rounded} ${word}`;
  }
  return null;
}

interface ProgramStep { title?: unknown; text?: unknown }

/** Шаги программы, у которых есть заголовок. Чужая форма — пустой список. */
export function programSteps(program: unknown): Array<{ title: string; text: string }> {
  if (!Array.isArray(program)) return [];
  const out: Array<{ title: string; text: string }> = [];
  for (const raw of program) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as ProgramStep;
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    if (title) out.push({ title, text });
  }
  return out;
}

function listPhrase(items: string[] | null | undefined, max: number): string | null {
  if (!Array.isArray(items)) return null;
  const clean = items.map((i) => String(i).trim()).filter(Boolean);
  if (clean.length === 0) return null;
  const head = clean.slice(0, max);
  const tail = clean.length > max ? ` и ещё ${clean.length - max}` : '';
  return head.join(', ').toLowerCase() + tail;
}

/**
 * Собрать описание. Порядок абзацев отвечает порядку вопросов покупателя:
 * что это и где, как проходит, сколько длится и кому по силам, что взять и
 * что уже включено, как он попадёт на тур.
 */
export function composeTourDescription(f: TourFacts): ComposeResult {
  const used: string[] = [];
  const parts: string[] = [];

  // 1. Что и где.
  const where = (f.location_name ?? '').trim();
  if (where) {
    parts.push(`${f.title.trim()} — программа на Камчатке, район: ${where}.`);
    used.push('location_name');
  } else {
    parts.push(`${f.title.trim()} — программа на Камчатке.`);
  }

  // 2. Как проходит — самое ценное, что есть у оператора.
  const steps = programSteps(f.program);
  if (steps.length > 0) {
    used.push('program');
    const lines = steps.slice(0, 6).map((s) => (s.text ? `${s.title} — ${s.text}` : s.title));
    parts.push(`Как проходит: ${lines.join('; ')}.`);
  }

  // 3. Длительность и сложность.
  const dur = durationPhrase(f);
  if (dur) { parts.push(`${dur}.`); used.push(f.multi_day_count && f.multi_day_count > 1 ? 'multi_day_count' : 'duration_hours'); }
  const diff = f.difficulty ? DIFFICULTY_WORDS[f.difficulty.trim().toLowerCase()] : undefined;
  if (diff) { parts.push(`${diff}.`); used.push('difficulty'); }

  // 4. Сезон и погода.
  const season = seasonPhrase(f.season_start, f.season_end);
  if (season) { parts.push(`${season}.`); used.push('season'); }
  if (f.weather_dependent) {
    parts.push('Программа зависит от погоды: при плохих условиях оператор переносит выход.');
    used.push('weather_dependent');
  }

  // 5. Группа.
  if (f.max_participants && f.max_participants > 0) {
    parts.push(`Группа до ${f.max_participants} человек.`);
    used.push('max_participants');
  }

  // 6. Что включено и что взять.
  const inc = listPhrase(f.included, 5);
  if (inc) { parts.push(`В стоимость входит: ${inc}.`); used.push('included'); }
  const bring = listPhrase(f.what_to_bring, 5);
  if (bring) { parts.push(`С собой нужно взять: ${bring}.`); used.push('what_to_bring'); }

  // 7. Как попадёт на тур (932).
  if (isPickupType(f.pickup_type)) {
    const w = pickupWording(f.pickup_type);
    const details = (f.pickup_details ?? '').trim();
    parts.push(details ? `${w.summary} ${details.split('\n')[0].trim()}` : w.summary);
    used.push('pickup');
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();

  if (text.length < MIN_DESCRIPTION_CHARS) {
    // Называем, ЧЕГО не хватило: оператору нужен список полей, а не отказ.
    const missing: string[] = [];
    if (steps.length === 0) missing.push('program');
    if (!inc) missing.push('included');
    if (!bring) missing.push('what_to_bring');
    if (!dur) missing.push('duration');
    if (!isPickupType(f.pickup_type)) missing.push('pickup');
    if (missing.length === 0) missing.push('too_short');
    return { text: null, used, missing, chars: text.length };
  }

  return { text, used, missing: [], chars: text.length };
}
