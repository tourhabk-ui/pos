/**
 * Зона планера по месту сводки (вулкан, округ, посёлок) — одна карта для
 * движка плана и страницы /trip (слово владельца 22.11: «Ключевской» вверху
 * плана, где Северной зоны нет). Нет привязки — пусто: зону не угадываем.
 * Чистый модуль без lookbehind — он доходит до клиента.
 */
const PLAN_ZONE_BY_PLACE: Array<[RegExp, string]> = [
  [/шивелуч|ключевск|безымянн|толбачик|усть-камчатск|мильков/, 'northern'],
  [/крашенинников|карымск|кроноцк/, 'eastern'],
  [/авачинск|корякск|мутновск|горелый|вилючинск|елизов|петропавловск/, 'avachinsky'],
  [/ичинск|усть-большерецк|левашов|соболев|быстринск/, 'western'],
];

export function placeZones(place: string): string[] {
  const p = place.toLowerCase().replace(/ё/g, 'е');
  const zones = new Set<string>();
  for (const [re, zone] of PLAN_ZONE_BY_PLACE) if (re.test(p)) zones.add(zone);
  return [...zones];
}

/**
 * Касается ли сводка о месте зон плана: место привязано к зоне плана — да;
 * привязано только к чужим зонам — нет; не привязано вовсе — да (молчать о
 * сводке, зону которой не знаем, нельзя).
 */
export function placeTouchesZones(place: string, planZones: readonly string[]): boolean {
  const z = placeZones(place);
  return z.length === 0 || z.some((x) => planZones.includes(x));
}
