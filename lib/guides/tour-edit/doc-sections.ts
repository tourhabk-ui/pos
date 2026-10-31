/**
 * Документ гида (.docx) → поля тура — правилами, без модели (слово владельца
 * 30.10 «гид должен полностью управлять своей ролью из MAX»). Повод — гид
 * правит тексты своих туров в Word/Google-документах, и до сих пор их переносил
 * разработчик миграцией (1356).
 *
 * Документы гида устроены одинаково (папка 30.10): первая строка — название
 * тура в «ёлочках», подзаголовок, вступление, затем разделы под короткими
 * заголовками: «О вулкане» / «Описание маршрута», «Программа …», «Сколько
 * длится», «Насколько сложный», «Что взять с собой», «В стоимость включено» /
 * «Что включено …», «Важно знать». Раздел — по заголовку из словаря; что под
 * ним — в поле:
 *   · вступление и «О вулкане», «Описание маршрута» — описание;
 *   · «Программа …» — шаги программы: короткая строка — заголовок шага,
 *     абзацы под ней — его текст; пункт списка — шаг сам по себе;
 *   · «Что взять» — что взять с собой; «Включено» — что включено; «Не входит» —
 *     что не входит; «Сколько длится», «Насколько сложный», «Стоит учитывать»,
 *     «Формат…», «Важно знать» — безопасность (первый пункт раздела — с его
 *     заголовком, чтобы «Спуск: 1,5–2 часа» не потерял смысл).
 * Подписи групп («Одежда и обувь:») пунктом не становятся.
 *
 * Слова гида не переписываются и не сокращаются: поле, которое не помещается в
 * пределы сайта (описание 4000 знаков, пункт 200, безопасность 500 — lib/tours/text-limits), не записывается вовсе и
 * называется отказом с причиной — его гид правит фразой. Подзаголовок не
 * угадывается ни анонсом, ни названием: он назван «не записываю».
 */

import type { DocxParagraph } from '@/lib/docs/docx-text';
import type { TourProgramStep } from '@/lib/tours/tour-write';
import { LIMITS, parseFieldValue, type EditField, type EditReject, type EditValue } from './parse';

/** Поля, которые документ гида заполняет; порядок — номер поля в кнопке. */
// Документ — только текст тура: название, анонс и цену правит фраза.
export const DOC_FIELDS = [
  'description', 'program', 'included', 'not_included', 'what_to_bring', 'safety_notes',
] as const satisfies readonly EditField[];
export type DocField = (typeof DOC_FIELDS)[number];

// Без \b: в JS он про латиницу, и «программа\b» не находил «Программа дня».
const SECTION_HEADS: ReadonlyArray<[RegExp, DocField]> = [
  [/^программа(?:\s|$)/, 'program'],
  [/^(?:что взять|взять с собой|что с собой|снаряжение(?:\s|$))/, 'what_to_bring'],
  [/^(?:не входит|не включено|дополнительно оплачива|оплачивается отдельно)/, 'not_included'],
  [/^(?:в стоимость (?:\S+ )?(?:включено|входит)|что включено|включено(?:\s|$)|входит в стоимость|стоимость включает)/, 'included'],
  [/^(?:важно знать|сколько длится|насколько сложн|стоит учитывать|что стоит учесть|формат (?:путешествия|тура|экскурсии)|противопоказания|безопасность|ограничения)/, 'safety_notes'],
  [/^(?:о вулкане|о туре|об экскурсии|о маршруте|описание(?:\s|$))/, 'description'],
];

/** Заголовки безопасности, которые сами — «правила»: их слова пункту не нужны. */
const PLAIN_SAFETY = /^(?:важно знать|безопасность|противопоказания|ограничения)/;

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[:.\s]+$/g, '').trim();
}

/** Короткая строка без точки в конце — похожа на заголовок. */
function headingLike(p: DocxParagraph, max = 80): boolean {
  return !p.listItem && p.text.length <= max && !/[.!?…;]$/.test(p.text);
}

function sectionOf(p: DocxParagraph): DocField | null {
  if (!headingLike(p, 70)) return null;
  const n = norm(p.text);
  for (const [re, field] of SECTION_HEADS) if (re.test(n)) return field;
  return null;
}

/** Подпись группы внутри списка: «Одежда и обувь:», «Снаряжение и мелочи:». */
function groupLabel(p: DocxParagraph): boolean {
  return !p.listItem && p.text.length <= 60 && /:$/.test(p.text);
}

export interface DocSections {
  /** Слова тура из первой строки «…»; null — первой строки в «ёлочках» нет. */
  tourWords: string | null;
  /** Поля, которые прошли проверку сайта. */
  values: Partial<Record<DocField, EditValue>>;
  /** Поля, которые в документе есть, но записать нельзя, — с причиной. */
  rejects: Array<{ field: DocField; reject: EditReject }>;
  /** Что не легло ни в одно поле (подзаголовок). */
  skipped: string[];
}

interface Bucket { heading: string | null; paragraphs: DocxParagraph[] }

export function docSections(paragraphs: readonly DocxParagraph[]): DocSections {
  const out: DocSections = { tourWords: null, values: {}, rejects: [], skipped: [] };
  let i = 0;
  const first = paragraphs[0];
  const quoted = first ? /^[«"„]\s*(.+?)\s*[»"“]$/.exec(first.text) : null;
  if (quoted) {
    out.tourWords = quoted[1]!;
    i = 1;
    // Подзаголовок под названием — не угадываем, куда он.
    const sub = paragraphs[1];
    if (sub && headingLike(sub, 150) && sectionOf(sub) === null) {
      out.skipped.push(sub.text);
      i = 2;
    }
  }

  const buckets = new Map<DocField, Bucket[]>();
  let current: { field: DocField; bucket: Bucket } = { field: 'description', bucket: { heading: null, paragraphs: [] } };
  buckets.set('description', [current.bucket]);
  for (; i < paragraphs.length; i++) {
    const p = paragraphs[i]!;
    const field = sectionOf(p);
    if (field) {
      const bucket: Bucket = { heading: p.text.replace(/[:\s]+$/, ''), paragraphs: [] };
      buckets.set(field, [...(buckets.get(field) ?? []), bucket]);
      current = { field, bucket };
      continue;
    }
    current.bucket.paragraphs.push(p);
  }

  for (const [field, list] of buckets) {
    if (field === 'program') {
      const r = programOf(list);
      if (r === null) continue;
      if ('reason' in r) out.rejects.push({ field, reject: r });
      else out.values.program = r;
      continue;
    }
    const body = bodyOf(field, list);
    if (body === null) continue;
    const r = parseFieldValue(field, body);
    if ('reason' in r) out.rejects.push({ field, reject: r });
    else out.values[field] = r.value;
  }
  return out;
}

function bodyOf(field: DocField, list: readonly Bucket[]): string | null {
  if (field === 'description') {
    const text = list.flatMap((b) => b.paragraphs.map((p) => p.text)).join('\n\n').trim();
    return text || null;
  }
  const items: string[] = [];
  for (const b of list) {
    const own = b.paragraphs.filter((p) => !groupLabel(p)).map((p) => p.text);
    if (own.length === 0) continue;
    if (field === 'safety_notes' && b.heading && !PLAIN_SAFETY.test(norm(b.heading))) {
      own[0] = `${b.heading}: ${own[0]}`;
    }
    items.push(...own);
  }
  return items.length > 0 ? items.join('\n') : null;
}

/**
 * Шаги программы. Короткая строка — заголовок шага как написан (тире в нём не
 * режется), абзацы под ней — текст шага. Пункт списка или абзац без
 * заголовка — шаг сам по себе: заголовок ему ищет разбор программы фразы (до
 * двоеточия или тире, иначе первое предложение), не нашёл — отказ, не догадка.
 * Пределы — те же, что у фразы.
 */
function programOf(list: readonly Bucket[]): TourProgramStep[] | EditReject | null {
  const steps: TourProgramStep[] = [];
  let open: TourProgramStep | null = null;
  for (const p of list.flatMap((b) => b.paragraphs)) {
    if (!p.listItem && headingLike(p)) {
      open = { title: p.text, text: '' };
      steps.push(open);
    } else if (open && !p.listItem) {
      open.text = open.text ? `${open.text}\n${p.text}` : p.text;
    } else {
      open = null;
      const one = parseFieldValue('program', `1. ${p.text}`);
      if ('reason' in one) return one.reason === 'step_no_title' ? { reason: 'step_no_title', index: steps.length + 1 } : one;
      steps.push(...(one.value as TourProgramStep[]));
    }
  }
  if (steps.length === 0) return null;
  if (steps.length > LIMITS.programSteps) return { reason: 'too_many', max: LIMITS.programSteps, got: steps.length };
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]!;
    if (st.title.length > LIMITS.stepTitle) return { reason: 'item_too_long', index: i + 1, max: LIMITS.stepTitle };
    if (st.text.length > LIMITS.stepText) return { reason: 'item_too_long', index: i + 1, max: LIMITS.stepText };
  }
  return steps;
}
