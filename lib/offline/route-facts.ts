/**
 * Факты маршрута в телефоне — чтобы Кузьмич без сети отвечал по ним.
 *
 * Карт-бланш владельца 27.11, шаг 2 после «Кузьмич без сети отвечает
 * памятками». Сервер и раньше отдавал в офлайн-пакете маршрута
 * (`/api/routes/[id]/offline-bundle`) опасности, снаряжение, регистрацию МЧС,
 * парк и предупреждения, но экраны брали из ответа только рамку для карты.
 * В поле без сети человек спрашивал «что взять» или «нужна ли регистрация» —
 * а ответ лежал в том самом пакете и выбрасывался.
 *
 * Карточка пишется вместе с картой — при удачном сохранении карты маршрута
 * (`saveRouteMap`), той же кнопкой на карточке маршрута и в планере. Только
 * факты маршрута: ни имени, ни телефона, ни координат человека.
 *
 * Факты — на дату сохранения, и это говорится в каждом ответе: предупреждения
 * и обстановка с тех пор могли измениться (vedar-design §7).
 */

export const ROUTE_FACTS_PREFIX = 'kh_route_facts_';

export function routeFactsKey(routeId: string): string {
  return `${ROUTE_FACTS_PREFIX}${routeId}`;
}

export interface RouteFactAlert {
  title: string;
  /** До какого числа действует; null — срок не записан. */
  until: string | null;
}

export interface RouteFacts {
  id: string;
  title: string;
  /** Когда сервер собрал пакет (ISO); null — не назвал. */
  builtAt: string | null;
  /** Когда факты легли в телефон (мс). 0 — ещё не сохранены (план). */
  savedAt: number;
  hazards: string[];
  equipment: string[];
  /** true — обязательна; false — в данных не отмечена; null — не записано. */
  mchsRequired: boolean | null;
  mchsPhone: string | null;
  parkName: string | null;
  alerts: RouteFactAlert[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null).slice(0, 30) : [];

/** Карточка из ответа `/offline-bundle`. Нет маршрута или названия — null. */
export function routeFactsFromBundle(bundle: Record<string, unknown>): RouteFacts | null {
  const route = bundle.route;
  if (!isRecord(route)) return null;
  const id = route.id === undefined || route.id === null ? null : String(route.id);
  const title = str(route.title);
  if (!id || !title) return null;
  const alerts = Array.isArray(bundle.alerts)
    ? bundle.alerts.filter(isRecord).map((a) => ({ title: str(a.title), until: str(a.until) }))
      .filter((a): a is RouteFactAlert => a.title !== null).slice(0, 10)
    : [];
  return {
    id,
    title,
    builtAt: str(bundle.built_at),
    savedAt: 0,
    hazards: strList(route.hazards),
    equipment: strList(route.equipment),
    mchsRequired: typeof route.mchs_registration_required === 'boolean' ? route.mchs_registration_required : null,
    mchsPhone: str(route.mchs_phone),
    parkName: str(route.park_name),
    alerts,
  };
}

/** Разобрать сохранённую карточку; чужое и битое — null. */
export function parseRouteFacts(raw: string | null): RouteFacts | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || typeof v.id !== 'string' || typeof v.title !== 'string' || typeof v.savedAt !== 'number') return null;
    return {
      id: v.id,
      title: v.title,
      builtAt: str(v.builtAt),
      savedAt: v.savedAt,
      hazards: strList(v.hazards),
      equipment: strList(v.equipment),
      mchsRequired: typeof v.mchsRequired === 'boolean' ? v.mchsRequired : null,
      mchsPhone: str(v.mchsPhone),
      parkName: str(v.parkName),
      alerts: Array.isArray(v.alerts)
        ? v.alerts.filter(isRecord).map((a) => ({ title: str(a.title), until: str(a.until) }))
          .filter((a): a is RouteFactAlert => a.title !== null)
        : [],
    };
  } catch {
    return null;
  }
}

/** Положить карточку в телефон. Хранилище закрыто (приватный режим) — false. */
export function saveRouteFacts(facts: RouteFacts, now: number = Date.now()): boolean {
  try {
    localStorage.setItem(routeFactsKey(facts.id), JSON.stringify({ ...facts, savedAt: now }));
    return true;
  } catch (err) {
    console.error('[route-facts] карточка маршрута не сохранена:', err instanceof Error ? err.name : 'unknown');
    return false;
  }
}

/** Все сохранённые карточки, свежие первыми. Хранилище закрыто — пусто. */
export function readSavedRouteFacts(): RouteFacts[] {
  const out: RouteFacts[] = [];
  try {
    if (typeof localStorage === 'undefined') return out;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(ROUTE_FACTS_PREFIX)) continue;
      const facts = parseRouteFacts(localStorage.getItem(key));
      if (facts) out.push(facts);
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
