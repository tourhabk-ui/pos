/**
 * «Как добраться» — текст из данных, не из головы (решение владельца 02.10:
 * «тексты „Как добраться" для 30 мест со спросом — делай»).
 *
 * Срез SEO 02.10: карточка места — около 170 слов, и в выдаче по «Долина
 * гейзеров как добраться» её нет. Дописать абзац рукой для тридцати мест
 * значило бы сочинять: правило платформы — текст из данных или источника.
 * А данных на этот вопрос у карточки уже много, они только не были
 * собраны в слова:
 *
 *  - координаты места и Петропавловска → расстояние по прямой и сторона
 *    света (считается, не записывается);
 *  - `places.access_info` — записанный человеком текст, идёт дословно;
 *  - маршруты каталога через место (`route_waypoints`) — сколько их,
 *    самый короткий с километрами и часами;
 *  - регистрация в МЧС (`location_safety_profile.registration_required`);
 *  - режим территории (`eco.zone`, `permitRequired`);
 *  - туры операторов, которые сюда возят.
 *
 * Чего здесь НЕТ намеренно: `road_type` / `road_accessibility` — у всех мест
 * стоит умолчание миграции 0645 ('gravel' и 50, см. lib/places/on-route.ts),
 * и слово «гравийка» было бы заглушкой, выданной за факт (§4.0). Нет и
 * времени в пути на машине: его считает дорожный граф в PlaceOwnRoute по
 * живой позиции человека, а не отсюда.
 *
 * Каждое предложение появляется только при наличии своего факта; без
 * фактов остаётся одно — где место относительно города, потому что
 * координаты у места обязательны.
 */
import { distanceKm } from '@/lib/geo/kamchatka';

/** Петропавловск-Камчатский — точка отсчёта «от города». */
export const PK = { lat: 53.0195, lng: 158.6483 } as const;

export interface AccessRoute {
  title: string;
  distanceKm: number | null;
  durationHours: number | null;
  difficulty: string | null;
}

export interface AccessFacts {
  name: string;
  lat: number;
  lng: number;
  district: string | null;
  zone: string | null;
  accessInfo: string | null;
  routes: AccessRoute[];
  registrationRequired: boolean;
  eco: { zone: string | null; permitRequired: boolean } | null;
  toursCount: number;
}

const ECO_ZONE_GENITIVE: Record<string, string> = {
  UNESCO: 'объекта Всемирного наследия ЮНЕСКО',
  federal_reserve: 'государственного заповедника',
  regional_reserve: 'регионального заповедника',
  natural_park: 'природного парка',
  zakaznik: 'государственного заказника',
};

const DIFFICULTY_RU: Record<string, string> = {
  easy: 'лёгкий', medium: 'средней сложности', hard: 'сложный', extreme: 'экстремальный',
};

/** Азимут от a к b, градусы 0..360 (0 — север). */
export function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const DIRECTIONS = ['северу', 'северо-востоку', 'востоку', 'юго-востоку', 'югу', 'юго-западу', 'западу', 'северо-западу'] as const;

/** «к северу», «к юго-западу» — восемь румбов. */
export function directionWord(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return DIRECTIONS[i];
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
}

function hoursWord(h: number): string {
  if (h >= 24) {
    const d = Math.round(h / 24);
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  const r = Math.round(h * 2) / 2;
  return `около ${fmt(r)} ч`;
}

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/**
 * Предложения «Как добраться» по порядку: где, записанный текст, маршруты,
 * допуск (МЧС, территория), туры. Пустой факт — пропущенное предложение.
 */
export function composeAccessText(f: AccessFacts): string[] {
  const out: string[] = [];

  // 1. Где — считается всегда: координаты обязательны.
  const km = Math.round(distanceKm(PK, { lat: f.lat, lng: f.lng }));
  const where = f.district?.trim() || f.zone?.trim() || '';
  if (km < 15) {
    out.push(`${f.name} — в черте Петропавловска-Камчатского или рядом с ним${where ? ` (${where})` : ''}.`);
  } else {
    const dir = directionWord(bearingDeg(PK, { lat: f.lat, lng: f.lng }));
    out.push(`${f.name} — в ${km} км по прямой к ${dir} от Петропавловска-Камчатского${where ? `, ${where}` : ''}.`);
  }

  // 2. Записанный человеком текст — дословно.
  if (f.accessInfo?.trim()) out.push(sentence(f.accessInfo));

  // 3. Маршруты каталога через место.
  const routes = f.routes.filter(r => r.title?.trim());
  if (routes.length > 0) {
    const n = routes.length;
    const withKm = routes.filter(r => r.distanceKm != null && r.distanceKm > 0)
      .sort((a, b) => (a.distanceKm as number) - (b.distanceKm as number));
    const shortest = withKm[0];
    let s = n === 1
      ? `Через место проходит маршрут каталога «${routes[0].title}»`
      : `Через место ${plural(n, 'проходит', 'проходят', 'проходит')} ${n} ${plural(n, 'маршрут', 'маршрута', 'маршрутов')} каталога`;
    if (shortest) {
      const parts = [`${fmt(shortest.distanceKm as number)} км`];
      if (shortest.durationHours != null && shortest.durationHours > 0) parts.push(hoursWord(shortest.durationHours));
      if (shortest.difficulty && DIFFICULTY_RU[shortest.difficulty]) parts.push(DIFFICULTY_RU[shortest.difficulty]);
      s += n === 1
        ? ` — ${parts.join(', ')}`
        : `; самый короткий — «${shortest.title}», ${parts.join(', ')}`;
    }
    out.push(`${s}.`);
  }

  // 4. Допуск: МЧС и режим территории.
  const permits: string[] = [];
  if (f.registrationRequired) permits.push('перед выходом нужна регистрация в МЧС');
  if (f.eco?.permitRequired) {
    const z = f.eco.zone ? ECO_ZONE_GENITIVE[f.eco.zone] : null;
    permits.push(z ? `посещение — по разрешению дирекции ${z}` : 'посещение — по разрешению');
  } else if (f.eco?.zone && ECO_ZONE_GENITIVE[f.eco.zone]) {
    permits.push(`место на территории ${ECO_ZONE_GENITIVE[f.eco.zone]}`);
  }
  if (permits.length > 0) {
    const text = permits.join(', ');
    out.push(text.charAt(0).toUpperCase() + text.slice(1) + '.');
  }

  // 5. Туры: сколько операторов сюда возят (ссылки — в разделе «Дальше»).
  if (f.toursCount > 0) {
    out.push(f.toursCount === 1
      ? 'Сюда возит один тур оператора платформы — ссылка ниже.'
      : `Сюда возят ${f.toursCount} ${plural(f.toursCount, 'тур', 'тура', 'туров')} операторов платформы — ссылки ниже.`);
  }

  return out;
}
