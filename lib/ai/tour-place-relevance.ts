/**
 * Туры в подсказке модели — про то место, о котором спросили (проба 764,
 * 13.10, через журнал общения A2A).
 *
 * Вопрос «какая сейчас обстановка у Авачинского вулкана?» Кузьмич ответил
 * про Ключевскую сопку: жёлтый код KVERT и тур «Восхождение на Ключевскую
 * сопку» за 320 000 ₽. Инструменты при этом отвечали верно — Авачинский
 * зелёный по обеим шкалам (проверено вызовом get_volcano_status и
 * get_guardian_context в тот же час). Подменило другое: слово «вулкан»
 * включало подбор туров (lib/ai/booking-intent), подбор брал три САМЫХ
 * НОВЫХ тура по вулканам — первым шёл свежий импорт «Края Вулканов», — и
 * они уходили в системный промпт с припиской «используй в ответе» и
 * «называй конкретный тур». Названный в вопросе вулкан подбор не видел.
 *
 * Правило: если в тексте назван вулкан, тур, который называет ТОЛЬКО другие
 * вулканы, в подсказку не попадает. Туры про названный вулкан идут первыми,
 * туры без имён вулканов («Вулканы Камчатки») остаются — они не про чужое
 * место. Не назван ни один — порядок и состав прежние.
 *
 * Имена — из одного справочника (KNOWN_VOLCANO_NAMES_RU, kvert-vona), основа
 * — той же функцией, что сопоставляет коды KVERT с местами (volcanoStem):
 * «Авачинского» и «Авачинский» дают одну основу. Нечёткого поиска нет:
 * неузнанное имя не фильтрует ничего — лучше прежний ответ, чем угаданный.
 *
 * ── Вечер 13.10: «и даже не один тур» ────────────────────────────────────
 *
 * Отсев чужих туров был половиной дела. Кандидатов подбор брал по ТИПУ:
 * слово «вулкан» давало тип volcano, а он в каталоге у одного тура —
 * Ключевской за 320 000 ₽. Оба тура на Авачинский перевал («Местечко
 * Камчатка», джип за 11 000 ₽ и снегоход) — другого типа и в кандидаты не
 * попадали никогда. До утренней правки Кузьмич предлагал на Авачинский
 * Ключевскую, после — не предлагал ничего. Сторож проверял правку на
 * выдуманном туре «Восхождение на Авачинский вулкан» с типом volcano, а не
 * на настоящем каталоге, — и зеленел.
 *
 * Теперь названный вулкан сам приводит туры к нему, какого бы типа они ни
 * были: volcanoNamePatterns даёт образцы для отбора в SQL. Образец —
 * надмножество (основа подстрокой); решает по-прежнему namedVolcanoes,
 * нормализация одна на оба конца.
 *
 * Модуль чистый. Сторож: tests/unit/tour-place-relevance.test.ts.
 */

import { volcanoStem } from '@/lib/services/safety/volcano-match';
import { KNOWN_VOLCANO_NAMES_RU } from '@/lib/services/safety/kvert-vona';

/** Короче этого основу сравниваем только целиком: «опал» не должен ловить «опалённый». */
const PREFIX_MIN = 5;

/** Основы слов текста: буквы, без родовых слов («вулкан», «сопка»…), с одной нормализацией. */
function textStems(text: string): string[] {
  const letters = text.replace(/[^A-Za-zА-Яа-яЁё]+/g, ' ');
  return volcanoStem(letters).split(' ').filter((w) => w.length > 0);
}

/** Основы одного имени вулкана: «Плоский Толбачик» → два слова, оба обязаны встретиться. */
const VOLCANO_STEMS: ReadonlyArray<{ name: string; stems: string[] }> = KNOWN_VOLCANO_NAMES_RU
  .map((name) => ({ name, stems: textStems(name) }))
  .filter((v) => v.stems.length > 0);

function wordMatches(textStem: string, nameStem: string): boolean {
  if (textStem === nameStem) return true;
  return nameStem.length >= PREFIX_MIN && textStem.startsWith(nameStem);
}

/** Какие вулканы из справочника названы в тексте (имена как в справочнике). */
export function namedVolcanoes(text: string): string[] {
  const stems = textStems(text);
  if (stems.length === 0) return [];
  const found = VOLCANO_STEMS.filter((v) => v.stems.every((ns) => stems.some((ts) => wordMatches(ts, ns))));
  // «Плоский Толбачик» содержит «Толбачик»: если назван составной, простой
  // по его словам не считается отдельно названным.
  return found
    .filter((v) => !found.some((o) => o !== v && o.stems.length > v.stems.length && v.stems.every((s) => o.stems.includes(s))))
    .map((v) => v.name);
}

/**
 * Образцы ILIKE для отбора туров к названным вулканам: `%основа%` каждого
 * слова имени. Основа — только буквы (textStems), спецсимволов LIKE в ней нет.
 * Тур, совпавший образцом, — лишь кандидат: про какой он вулкан, решает
 * pickToursForMessage той же основой.
 */
export function volcanoNamePatterns(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of VOLCANO_STEMS) {
    if (names.includes(v.name)) for (const s of v.stems) out.add(`%${s}%`);
  }
  return [...out];
}

export interface TourText {
  title: string;
  location?: string | null;
  description?: string | null;
}

/**
 * Туры для подсказки: при названном вулкане — без туров про чужие вулканы,
 * свои первыми; иначе — первые `limit` в прежнем порядке.
 */
export function pickToursForMessage<T extends TourText>(message: string, tours: readonly T[], limit: number): T[] {
  const asked = namedVolcanoes(message);
  if (asked.length === 0) return tours.slice(0, limit);
  const own: T[] = [];
  const generic: T[] = [];
  for (const t of tours) {
    const mentioned = namedVolcanoes([t.title, t.location ?? '', t.description ?? ''].join(' '));
    if (mentioned.length === 0) generic.push(t);
    else if (mentioned.some((m) => asked.includes(m))) own.push(t);
    // иначе тур про другой вулкан — в подсказку не идёт
  }
  return [...own, ...generic].slice(0, limit);
}
