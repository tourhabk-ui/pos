/**
 * Паспорт реестра, который к карточке маршрута НЕ привязан (#3568, слово
 * владельца 20.11 «2 дописать»).
 *
 * У шести карточек (семь паспортов) есть официальный паспорт в реестре visitkamchatka.ru с тем
 * же названием, но тот ли это маршрут, по карточке не понять: старт и финиш
 * не подписаны, длина другого рода (у Вилючинского перевала в паспорте —
 * другая нитка, 76 км на машине от п. Геологи). Паспортную длину на такую
 * карточку не переносим. Карточка говорит, что в паспорте, и что маршрут там
 * может отличаться, — а не выбирает за человека.
 *
 * Данные — `kamchatka_routes.registry_passports` (миграция 1478): список
 * `{ url, km, side, label }`. Ссылка — только PDF из каталога паспортов
 * реестра (`registryPassportPdf`): адрес из базы уходит в href, и другой
 * источник паспортом не назовём.
 */

import { registryPassportPdf, routeDistanceWords } from './distance-words';

export interface RegistryPassportRef {
  /** PDF паспорта в реестре visitkamchatka.ru. */
  url: string;
  /** Протяжённость по паспорту, км. */
  km: number;
  /** Как паспорт мерит: «в одну сторону», «в обе стороны»; нет пометки — null. */
  side: string | null;
  /** Какой это паспорт, когда их несколько: «летний», «зимний». */
  label: string | null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Разбор колонки: неверная запись отбрасывается, а не чинится догадкой. */
export function parseRegistryPassports(raw: unknown): RegistryPassportRef[] {
  if (!Array.isArray(raw)) return [];
  const out: RegistryPassportRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const url = registryPassportPdf(text(o.url));
    const km = typeof o.km === 'number' ? o.km : Number(o.km);
    if (!url || !Number.isFinite(km) || km <= 0) continue;
    out.push({ url, km, side: text(o.side), label: text(o.label) });
  }
  return out;
}

const MAY_DIFFER = 'Маршрут в паспорте может отличаться от этой карточки.';

/**
 * Что в паспортах: «В официальном паспорте — 76 км в обе стороны»; разные
 * длины — каждая со своей подписью, через `sep`. Паспортов нет — null.
 */
function passportsHead(refs: RegistryPassportRef[], sep: string): string | null {
  if (refs.length === 0) return null;
  const dist = refs.map((r) => routeDistanceWords(r.km, r.side) as string);
  if (dist.every((d) => d === dist[0])) {
    const head = refs.length === 1
      ? 'В официальном паспорте'
      : refs.length === 2 ? 'В обоих официальных паспортах' : `Во всех ${refs.length} официальных паспортах`;
    return `${head} — ${dist[0]}`;
  }
  const parts = refs.map((r, i) => `${r.label ?? `паспорт ${i + 1}`} — ${dist[i]}`);
  return `В официальных паспортах: ${parts.join(sep)}`;
}

/** «В официальном паспорте — 76 км в обе стороны. Маршрут в паспорте может отличаться…» */
export function registryPassportNote(refs: RegistryPassportRef[]): string | null {
  const head = passportsHead(refs, '; ');
  return head ? `${head}. ${MAY_DIFFER}` : null;
}

/**
 * Те же слова для Кузьмича и MCP (слово владельца 20.11 «1 да»): там, где
 * агент называет длину маршрута, он узнаёт и длину паспорта — и что паспорт
 * может описывать другую нитку. «Этой карточки» агенту не скажешь: у него
 * маршрут каталога. Одно предложение без точки в конце — строка встаёт и в
 * перечень фактов, и в скобки после длины.
 */
export function registryPassportAgentClause(refs: RegistryPassportRef[]): string | null {
  const head = passportsHead(refs, ', ');
  return head ? `${head}; маршрут в паспорте может отличаться от этого маршрута каталога` : null;
}

/** Ссылки на PDF для агента: «паспорт (PDF): …», «летний паспорт (PDF): …, зимний паспорт (PDF): …». */
export function registryPassportAgentLinks(refs: RegistryPassportRef[]): string | null {
  if (refs.length === 0) return null;
  return refs.map((r) => `${r.label ? `${r.label.toLowerCase()} паспорт` : 'паспорт'} (PDF): ${r.url}`).join(', ');
}

/**
 * Строка фактов маршрута для агента: сказанное и ссылки. Принимает колонку
 * как есть (`kamchatka_routes.registry_passports`) — разбор тот же, что у
 * карточки; неверная запись не печатается.
 */
export function registryPassportAgentLine(raw: unknown): string | null {
  const refs = parseRegistryPassports(raw);
  const clause = registryPassportAgentClause(refs);
  return clause ? `${clause} — ${registryPassportAgentLinks(refs)}` : null;
}

/** Подпись ссылки: «Летний паспорт (PDF)», «Паспорт (PDF)». */
export function registryPassportLinkLabel(ref: RegistryPassportRef): string {
  if (!ref.label) return 'Паспорт (PDF)';
  return `${ref.label.charAt(0).toUpperCase()}${ref.label.slice(1)} паспорт (PDF)`;
}
