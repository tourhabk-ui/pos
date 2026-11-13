/**
 * lib/parks/route-permit-card.ts
 *
 * Условия посещения территории — в форме для карточки маршрута (#3302, срез 6).
 *
 * Перепись 13.11 (`GET /api/cron/route-permit-census`, 368 живых маршрутов):
 * блок «Разрешение на посещение парка» со словами «Нужны оба» стоял на 75
 * карточках, и у 52 из них справочник этого не подтверждал. У 34 территория
 * не записана вовсе (блок выводился из-за одной регистрации в МЧС — так у
 * SUP-маршрута на полуострове Завойко), у 16 территория названа, но условий её
 * посещения в базе нет (памятники природы в черте города среди них), у 2 —
 * федеральный заказник, где заявку принимает Кроноцкий заповедник.
 *
 * Решение владельца 19.09 «где нужна регистрация — там же и „Зелёная кнопка“»
 * остаётся: кнопка стоит на тех же карточках. Меняются слова — утверждение
 * «нужно разрешение парка» карточка делает только там, где его делает ответ
 * агенту (`routePermitCase`): справочник ведёт территорию на страницу условий
 * КГБУ. В остальных случаях карточка говорит, что ей известно, и что нет.
 *
 * Модуль без базы: его читает клиентский компонент
 * (components/safety/ParkPermitAction). Случай считает сервер
 * (lib/routes/route-detail) и отдаёт в этой форме — она переживает JSON и
 * офлайн-копию карточки.
 */
import type { ParkPermitRecord, RoutePermitCase } from '@/lib/parks/route-permit';

/**
 * Случай маршрута для карточки. У случаев, которые правило узнаёт по названию
 * (`no_permit`, `kronoki`, `free_visit`, `federal`), подробности карточка
 * берёт тем же `permitRuleFor`: в них лежат регулярные выражения, через JSON
 * они не проходят.
 */
export type RoutePermitCardCase =
  | { kind: 'none' | 'no_permit' | 'kronoki' | 'free_visit' | 'federal' | 'kgbu' }
  | { kind: 'recorded'; park: ParkPermitRecord }
  | { kind: 'unrecorded' | 'unread'; territory: string }
  | { kind: 'ambiguous'; territory: string; names: string[] };

export function permitCardCase(c: RoutePermitCase): RoutePermitCardCase {
  switch (c.kind) {
    case 'recorded': return { kind: 'recorded', park: c.park };
    case 'unrecorded': return { kind: 'unrecorded', territory: c.territory };
    case 'unread': return { kind: 'unread', territory: c.territory };
    case 'ambiguous': return { kind: 'ambiguous', territory: c.territory, names: c.names };
    default: return { kind: c.kind };
  }
}

/**
 * Как карточка говорит о разрешении парка:
 *  - `asserted` — «нужно разрешение, вот способы» (справочник ведёт на КГБУ,
 *    парк ушёл в федеральное ведение — со своей оговоркой, — либо у маршрута
 *    записана ссылка согласования с дирекцией парка);
 *  - `conditional` — территория не записана или её условий нет в базе:
 *    способы КГБУ названы с условием «если маршрут идёт по парку сети»;
 *  - `recorded` — у территории своя запись: её каналы, без «Зелёной кнопки»;
 *  - `ambiguous` — к названию подходят несколько записей: способов нет.
 * Случаи по названию (Вачкажец, Кроноцкий, свободная зона) сюда не доходят.
 */
export type PermitCardWording = 'asserted' | 'conditional' | 'recorded' | 'ambiguous';

/**
 * Адрес из базы идёт в ссылку, только если это обычный веб-адрес: пробелы и
 * `javascript:` ссылкой не становятся. Одна мера на блок карточки и на перепись.
 */
export function webHref(url: string | null | undefined): string | null {
  const t = (url ?? '').trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

/**
 * Слова блока по случаю. `permit` не пришёл (старая офлайн-копия карточки,
 * страница регистрации) — прежний вид. Ссылка согласования маршрута —
 * записанный факт о маршруте: с ней блок утверждает, каким бы ни был случай
 * территории, кроме чужого ведомства (`recorded`). Парк в федеральном ведении
 * (`federal`) утверждает со своей оговоркой — её ставит блок.
 */
export function permitCardWording(
  permit: RoutePermitCardCase | null | undefined,
  opts: { hasApprovalUrl: boolean },
): PermitCardWording {
  if (!permit) return 'asserted';
  if (permit.kind === 'recorded') return 'recorded';
  if (permit.kind === 'ambiguous') return 'ambiguous';
  if (permit.kind === 'none' || permit.kind === 'unrecorded' || permit.kind === 'unread') {
    return opts.hasApprovalUrl ? 'asserted' : 'conditional';
  }
  return 'asserted';
}

/** Территория у маршрута не записана — «не знаем», а не «парка нет». */
export const TERRITORY_NOT_RECORDED_RU =
  'Проходит ли маршрут по охраняемой территории, в базе Ведара не записано.';

/** Территория названа, условий её посещения в базе нет. Хвост — общий с ответом агенту. */
export const CONDITIONS_NOT_RECORDED_RU =
  'Условия её посещения в базе Ведара не записаны — это не значит, что разрешение не нужно: '
  + 'уточните у администрации территории.';

/** Справочник не прочитался — это не «условий нет». */
export const CONDITIONS_UNREAD_RU =
  'Условия посещения территории сейчас не прочитались — это не значит, что разрешение не нужно.';

/** У территории своя запись: нужно ли разрешение на этом маршруте, запись не говорит. */
export const RECORDED_UNKNOWN_RU =
  'Нужно ли разрешение именно на этом маршруте, справочник Ведара не говорит — уточните у администрации территории.';

/** Подводка к способам КГБУ там, где парк маршрута не подтверждён записью. */
export const KGBU_IF_IN_PARK_RU =
  'Если маршрут идёт по природному парку сети КГБУ «Вулканы Камчатки», нужно разрешение парка — его оформляют так:';

/** Несколько записей справочника на одно название. */
export function ambiguousTerritoryRu(names: readonly string[]): string {
  return `В справочнике Ведара к этому названию подходят несколько записей (${names.join('; ')}) — `
    + 'чьи условия посещения действуют, по базе не определить: уточните у администрации территории.';
}
