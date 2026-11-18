/**
 * lib/tours/price-label.ts
 *
 * Цена тура словами. У неё три состояния, а не два.
 *
 * ── Что нашлось 18.09 ─────────────────────────────────────────────────────
 *
 * Владелец попросил посмотреть прод, и каталог (MCP `get_tours`) отдал:
 *
 *   ID34 «Сплав по реке Быстрая (три дня)» — от 0 р/чел
 *
 * Читается это как «бесплатно». На самом деле нуля в базе НЕТ и быть не
 * может: у `operator_tours.base_price` стоит CHECK `base_price > 0`, а сама
 * колонка NULLABLE — то есть ноль записать нельзя, а «цены нет» можно.
 * Значит у тура `base_price IS NULL`, а ноль на экране родил формат:
 *
 *   `от ${Number(r.base_price).toLocaleString('ru-RU')} р/чел`
 *
 * `Number(null)` — это `0`. Ровно тот же механизм уже стоил разбора на
 * денежном пути (§7, 11.09): `Number(null)` в `/api/bookings/tour` давал
 * нулевую комиссию платформы молча. Здесь он даёт бесплатный тур.
 *
 * ── Почему это опаснее обычной опечатки ───────────────────────────────────
 *
 * Врёт не оператор и не данные — врёт ПОКАЗ. В базе честное «не знаю», на
 * экране уверенное число. Турист не может отличить «ещё не договорились» от
 * «стоит ноль», и первым это увидит не он, а тот, кто придёт бронировать.
 *
 * ── Правило ───────────────────────────────────────────────────────────────
 *
 * `null` на входе — `null` на выходе. Вызывающий обязан сказать словами, что
 * цены нет, а не подставлять её. Складывать «не знаю» с нулём запрещено.
 */

import { PRICE_UNIT_LABELS } from '@/lib/tours/labels';

/*
 * ── Почему «от» здесь больше нет (#3487, 17.11) ───────────────────────────
 *
 * До 17.11 у цены тура было два формата: карточка и JSON-LD печатали
 * «97 000 ₽ за человека», а MCP, Кузьмич, сравнение и плитки главной —
 * «от 97 000 ₽/чел.» (`priceFrom`/`priceFromUnit`). Признака «цена от» у тура
 * нет: в `operator_tours.base_price` одно число, и «от» дописывал форматтер, а
 * не оператор. Агент пересказывал «от» человеку как слово оператора, хотя на
 * карточке того же тура его не было.
 *
 * Правило: цена ОДНОГО тура — одна строка на все поверхности,
 * `priceWithUnitWords`. «От» — только там, где оно правда само по себе:
 * наименьшая из нескольких цен (планер, перевозчик по прайсу), и такие места
 * пишут его сами, а не через этот модуль. Появится у оператора настоящая
 * «цена от» — она заводится признаком записи и печатается и на карточке, и в
 * MCP, а не префиксом форматтера.
 *
 * Сторож: tests/unit/tour-surfaces-agree.test.ts.
 */

/** Слова единицы, когда она не записана или незнакома: не «за человека» (§4.0). */
export const PRICE_UNIT_NOT_RECORDED = 'за что назначена цена, не записано';

/**
 * Сумма цены тура: «97 000 ₽». Цены нет (null, пусто, ноль, не число) — `null`:
 * ноль невозможен по CHECK колонки, и пришедший ноль — поломка чтения, а не
 * бесплатный тур. Вызывающий говорит «цена не указана» сам.
 */
export function priceSum(basePrice: string | number | null | undefined): string | null {
  if (basePrice == null || basePrice === '') return null;
  const n = Number(basePrice);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString('ru-RU')} ₽`;
}

/**
 * За что назначена цена — словами из словаря каталога (`PRICE_UNIT_LABELS`):
 * «за человека», «за группу». Не записано или незнакомо — так и сказано.
 */
export function priceUnitWords(priceUnit: string | null | undefined): string {
  const words = priceUnit ? PRICE_UNIT_LABELS[priceUnit] : undefined;
  return words ?? PRICE_UNIT_NOT_RECORDED;
}

/** Единица записана и знакома словарю. */
export function priceUnitKnown(priceUnit: string | null | undefined): boolean {
  return Boolean(priceUnit && PRICE_UNIT_LABELS[priceUnit]);
}

/**
 * Цена тура одной строкой — на карточке, в блоке туров места, в MCP, у
 * Кузьмича, в сравнении и на плитках главной: «15 000 ₽ за человека»,
 * «48 000 ₽ за группу». Единица незнакома — «… ₽ — за что назначена цена, не
 * записано». Цены нет — `null`.
 */
export function priceWithUnitWords(
  basePrice: string | number | null | undefined,
  priceUnit: string | null | undefined,
): string | null {
  const sum = priceSum(basePrice);
  if (!sum) return null;
  return priceUnitKnown(priceUnit) ? `${sum} ${priceUnitWords(priceUnit)}` : `${sum} — ${PRICE_UNIT_NOT_RECORDED}`;
}

/** То же, но строка непуста: цены нет — так и говорим. */
export function priceWithUnitWordsOrSay(
  basePrice: string | number | null | undefined,
  priceUnit: string | null | undefined,
  absent = 'цена не указана',
): string {
  return priceWithUnitWords(basePrice, priceUnit) ?? absent;
}

/** Указание модели, когда единица не записана: человеку его не показывают. */
export const PRICE_UNIT_AGENT_NOTE = 'не называй её ценой с человека';

/**
 * Та же строка для текста модели (MCP, Кузьмич): цифра и слова те же, что у
 * человека, а при незаписанной единице добавлено указание модели в скобках —
 * иначе агент по привычке назовёт сумму ценой с человека (сверка каналов
 * 29.09). Человеку — `priceWithUnitWords`, без указания.
 */
export function priceForAgent(
  basePrice: string | number | null | undefined,
  priceUnit: string | null | undefined,
): string | null {
  const said = priceWithUnitWords(basePrice, priceUnit);
  if (!said) return null;
  return priceUnitKnown(priceUnit) ? said : `${said} (${PRICE_UNIT_AGENT_NOTE})`;
}

/** То же, но строка непуста: цены нет — так и говорим. */
export function priceForAgentOrSay(
  basePrice: string | number | null | undefined,
  priceUnit: string | null | undefined,
  absent = 'цена не указана',
): string {
  return priceForAgent(basePrice, priceUnit) ?? absent;
}

/**
 * Цена «за группу» с размером группы (слово владельца 03.11: у «Камчатской
 * рыбалки» группа — это число мест тура, до 14). Размер — только из
 * `max_participants` тура (живая строка базы), не выдумка: нет числа или
 * группа без предела — `null`, и цена остаётся «за группу, уточните».
 * Оценка с человека — цена / N и подписана «при полной группе»: меньше
 * людей — дороже на каждого.
 */
export function groupPriceNote(
  basePrice: string | number | null | undefined,
  priceUnit: string | null | undefined,
  maxParticipants: string | number | null | undefined,
  groupSizeUnlimited?: boolean | null,
): string | null {
  if (priceUnit !== 'per_tour' || groupSizeUnlimited === true) return null;
  const n = Number(maxParticipants);
  if (maxParticipants == null || !Number.isInteger(n) || n < 1) return null;
  const price = Number(basePrice);
  const each = Number.isFinite(price) && price > 0 && n > 1
    ? `; при полной группе ≈ ${Math.round(price / n).toLocaleString('ru-RU')} ₽/чел.`
    : '';
  return `за группу до ${n} чел.${each}`;
}

/**
 * Размер группы у цены с человека (слово владельца 03.11: «цена за 1
 * человека», группа — до числа мест тура). Только из `max_participants`
 * живой строки; без числа или без предела — `null`. Цену НЕ делит: делить
 * имеет смысл только цену за группу (`groupPriceNote`).
 */
export function groupSizeNote(
  priceUnit: string | null | undefined,
  maxParticipants: string | number | null | undefined,
  groupSizeUnlimited?: boolean | null,
  minParticipants?: string | number | null,
): string | null {
  if (priceUnit === 'per_tour' || groupSizeUnlimited === true || maxParticipants == null) return null;
  const n = Number(maxParticipants);
  if (!Number.isInteger(n) || n < 1) return null;
  // Минимум — тоже из живой строки (слово владельца 03.11: «минимум 5, до 14»).
  const m = minParticipants == null ? NaN : Number(minParticipants);
  return Number.isInteger(m) && m > 1 && m < n ? `группа ${m}–${n} чел.` : `группа до ${n} чел.`;
}
