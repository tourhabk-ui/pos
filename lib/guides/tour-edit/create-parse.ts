/**
 * Новый тур фразой гида — разбор правилами, без модели (слово владельца
 * 31.10: гид сам создаёт свои туры). Форма одна:
 *
 *   новый тур: Восхождение на Горелый; цена 15000; группа 4; описание: …
 *
 * После «новый тур:» — название до «;» или новой строки, затем через «;» или
 * с новой строки «цена …» (можно «за человека» / «за группу»; без слов — за
 * человека, как у формы оператора), «группа …» (сколько человек максимум) и
 * последним — «описание: …»: всё после него, с абзацами, — описание. Порядок
 * «цены» и «группы» любой.
 *
 * Фраза другой формы — `null`: это не создание, сообщение идёт дальше своим
 * путём. «новый тур» без двоеточия — подсказка формы. Чего не хватает или что
 * не разобрано — называется словами, ничего не заводится: название, цену и
 * группу не угадываем (§4.0).
 *
 * Значения проверяются ТЕМИ ЖЕ правилами и пределами, что правка фразой
 * (./parse: название 5–255, описание до 4000, цена 100 – 10 млн) — и ещё раз
 * схемой общей функции создания (lib/guides/own-tour-create).
 *
 * Подпись к документу Word (`parseCreateCaption`) разбирается тем же
 * правилом сегментов: «цена 15000; группа 4» — цена и группа нового тура из
 * документа, в самом документе их нет.
 */

import { OWN_TOUR_GROUP_MAX, type OwnTourDraftInput } from '@/lib/guides/own-tour-create';
import { parseFieldValue, parsePrice, type EditReject } from './parse';
import { rejectText } from './screens';

/** Поля, без которых тур не создаётся. */
export type CreateField = 'title' | 'base_price' | 'max_participants' | 'description';

export const CREATE_FIELD_LABEL: Readonly<Record<CreateField, string>> = {
  title: 'название',
  base_price: 'цена',
  max_participants: 'размер группы (сколько человек максимум)',
  description: 'описание',
};

export interface CreateSpecs {
  title?: string;
  base_price?: number;
  price_unit?: 'per_person' | 'per_tour';
  max_participants?: number;
  description?: string;
}

export type CreateParse =
  /** «новый тур» без полей — показать форму. */
  | { kind: 'hint' }
  | { kind: 'ok'; values: OwnTourDraftInput }
  /** Чего-то нет или не разобралось — ничего не заводится. */
  | { kind: 'incomplete'; specs: CreateSpecs; missing: CreateField[]; problems: string[] };

function lower(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

const HEAD = /^(?:новый|новая|создать|создай)\s+(?:тур|экскурсия|экскурсию)(?=$|[\s:])/;
const DESCRIPTION_AT = /(^|[;\n])\s*описание\s*:/i;
const PRICE = /^(?:цена|стоимость)\s*:?\s*(.+)$/i;
const UNIT = /\s*[,(]?\s*(?:за|с)\s+(человека|чел\.?|1 чел\.?|одного|группу|тур|всю группу|всех)\s*\)?\s*\.?$/i;
const GROUP = /^(?:группа|в группе|размер группы|человек в группе|мест)\s*:?\s*(?:до\s+)?(\d{1,4})(?:\s*(?:человек|чел\.?|мест))?\s*\.?$/i;
const GROUP_UP_TO = /^до\s+(\d{1,4})\s*(?:человек|чел\.?)\s*(?:в группе)?\s*\.?$/i;

/** Сегмент «цена …» → число и единица; не цена — null; цена с ошибкой — причина. */
function priceOf(seg: string): { price: number; unit: 'per_person' | 'per_tour' | null } | { reject: EditReject } | null {
  const m = PRICE.exec(seg);
  if (!m) return null;
  let body = m[1]!.trim();
  let unit: 'per_person' | 'per_tour' | null = null;
  const u = UNIT.exec(body);
  if (u) {
    unit = /^(?:групп|тур|всю|всех)/i.test(u[1]!) ? 'per_tour' : 'per_person';
    body = body.slice(0, u.index).trim();
  }
  const p = parsePrice(body);
  return 'reason' in p ? { reject: p } : { price: p.value, unit };
}

function groupOf(seg: string): number | 'bad' | null {
  const m = GROUP.exec(seg) ?? GROUP_UP_TO.exec(seg);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= OWN_TOUR_GROUP_MAX ? n : 'bad';
}

interface SegmentsOut { specs: CreateSpecs; problems: string[]; unknown: string[] }

/** Цена и группа из сегментов; прочие — в `unknown` (по порядку). */
function readSegments(segments: readonly string[]): SegmentsOut {
  const out: SegmentsOut = { specs: {}, problems: [], unknown: [] };
  for (const seg of segments) {
    const price = priceOf(seg);
    if (price) {
      if ('reject' in price) out.problems.push(rejectText('base_price', price.reject).replace(' Ничего не записал.', ''));
      else {
        out.specs.base_price = price.price;
        if (price.unit) out.specs.price_unit = price.unit;
      }
      continue;
    }
    const group = groupOf(seg);
    if (group === 'bad') {
      out.problems.push(`Размер группы — целым числом от 1 до ${OWN_TOUR_GROUP_MAX}: «группа 4».`);
      continue;
    }
    if (group !== null) {
      out.specs.max_participants = group;
      continue;
    }
    out.unknown.push(seg);
  }
  return out;
}

function splitSegments(s: string, commas: boolean): string[] {
  return s.split(commas ? /[;\n,]/ : /[;\n]/).map((x) => x.trim()).filter((x) => x.length > 0);
}

function titleOf(raw: string, problems: string[]): string | undefined {
  const t = parseFieldValue('title', raw.replace(/^[«"„]+|[»"“]+$/g, '').trim());
  if ('reason' in t) {
    problems.push(rejectText('title', t).replace(' Ничего не записал.', ''));
    return undefined;
  }
  return t.value as string;
}

/** Собрать итог: всё есть — вход общей функции создания; нет — что недостаёт. */
export function finishCreate(specs: CreateSpecs, problems: string[]): CreateParse {
  const missing = (['title', 'base_price', 'max_participants', 'description'] as const).filter((f) => specs[f] === undefined);
  if (missing.length > 0 || problems.length > 0) return { kind: 'incomplete', specs, missing, problems };
  return {
    kind: 'ok',
    values: {
      title: specs.title!,
      base_price: specs.base_price!,
      price_unit: specs.price_unit ?? 'per_person',
      max_participants: specs.max_participants!,
      description: specs.description!,
    },
  };
}

/** Фраза создания тура или нет. */
export function parseTourCreate(raw: string): CreateParse | null {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  const head = HEAD.exec(lower(text));
  if (!head) return null;
  let rest = text.slice(head[0].length);
  if (!/^\s*:/.test(rest)) return rest.trim() === '' ? { kind: 'hint' } : null;
  rest = rest.replace(/^\s*:\s*/, '');
  if (rest.trim() === '') return { kind: 'hint' };

  const problems: string[] = [];
  let headPart = rest;
  let description: string | undefined;
  const d = DESCRIPTION_AT.exec(rest);
  if (d) {
    headPart = rest.slice(0, d.index);
    const body = parseFieldValue('description', rest.slice(d.index + d[0].length));
    if ('reason' in body) problems.push(rejectText('description', body).replace(' Ничего не записал.', ''));
    else description = body.value as string;
  }
  const segs = readSegments(splitSegments(headPart, false));
  const specs: CreateSpecs = { ...segs.specs };
  if (description !== undefined) specs.description = description;
  problems.push(...segs.problems);
  const [first, ...more] = segs.unknown;
  if (first !== undefined) {
    const title = titleOf(first, problems);
    if (title !== undefined) specs.title = title;
  }
  for (const m of more) problems.push(`Не понял часть «${m.length > 60 ? `${m.slice(0, 59)}…` : m}» — пишите «цена 15000», «группа 4», «описание: …».`);
  return finishCreate(specs, problems);
}

/**
 * Подпись к документу: цена, группа и, если есть, название. Название из
 * первой строки документа «…» сильнее подписи — его называет сам документ.
 */
export function parseCreateCaption(caption: string): {
  specs: CreateSpecs;
  problems: string[];
  /**
   * Слова тура из подписи для поиска среди своих: без цены и группы. Подпись
   * без цены и группы — целиком, как было до 31.10; пустая — null.
   */
  tourWords: string | null;
} {
  const text = caption.replace(/\r\n?/g, '\n').trim();
  const segs = readSegments(splitSegments(text, true));
  const problems = [...segs.problems];
  const specs: CreateSpecs = { ...segs.specs };
  const [first] = segs.unknown;
  if (first !== undefined) {
    const t = parseFieldValue('title', first.replace(/^[«"„]+|[»"“]+$/g, '').trim());
    if (!('reason' in t)) specs.title = t.value as string;
  }
  const hadSpecs = specs.base_price !== undefined || specs.max_participants !== undefined || problems.length > 0;
  const tourWords = hadSpecs ? (segs.unknown.join(' ').trim() || null) : (text || null);
  return { specs, problems, tourWords };
}
