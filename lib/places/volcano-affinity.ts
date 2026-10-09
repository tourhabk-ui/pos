/**
 * Места, которые относятся к вулкану, — по УПОМИНАНИЮ, а не по расстоянию
 * (26.09).
 *
 * После правки статуса мест (safety-ingest, уровень по KVERT и КФ ЕГС)
 * Мутновский стал жёлтым, а «Скитур на Мутновский вулкан» и «Смотровая на
 * Мутновский вулкан» остались зелёными: это отдельные записи, код вулкана к
 * ним не привязан. Радиуса опасной зоны у вулканологов в открытых источниках
 * не нашлось (пробы 596-600: парк пишет «не приближаться», числа нет), а
 * связь «маршрут — место» у маршрутов к вулкану размечена как «рядом».
 *
 * Поэтому привязку предлагает перепись по тексту: место, в названии или
 * описании которого назван вулкан, — кандидат. Решает владелец, список идёт
 * ему; автомат ничего не привязывает. Близость без упоминания печатается
 * отдельно и только для сведения: выводить связь из расстояния — то же, что
 * запрещено для рода связи маршрута (§4.1).
 */
import { volcanoStem } from '@/lib/services/safety/volcano-match';
import { distanceKm } from '@/lib/routes/place-link';

export interface AffinityPlace {
  id: string;
  name: string;
  type: string;
  lat: number | null;
  lng: number | null;
  visible: boolean;
  desc: string | null;
}

export interface AffinityHit {
  place: AffinityPlace;
  /** Где назван вулкан: в названии или только в описании. */
  where: 'name' | 'desc' | null;
  km: number | null;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[()«»"'.,:;!?—–-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Назван ли вулкан в тексте. Каждое слово основы имени обязано быть началом
 * какого-то слова текста: основа «мутнов» ловит «Мутновский», «Мутновского»,
 * «Мутновскому». Основа короче четырёх букв не судит — слишком много ложных.
 */
export function volcanoMentioned(text: string, volcanoName: string): boolean {
  const stem = volcanoStem(volcanoName).split(' ').filter(Boolean);
  if (stem.length === 0 || stem.some((s) => s.length < 4)) return false;
  const ws = words(text);
  return stem.every((s) => ws.some((w) => w.startsWith(s)));
}

/** Кандидаты одного вулкана: упомянувшие его — по расстоянию; соседи без упоминания — отдельно. */
export function affinityFor(
  volcano: AffinityPlace,
  places: AffinityPlace[],
  nearKm: number,
): { mentioned: AffinityHit[]; nearOnly: AffinityHit[] } {
  const km = (p: AffinityPlace): number | null =>
    volcano.lat != null && volcano.lng != null && p.lat != null && p.lng != null
      ? Math.round(distanceKm(volcano.lat, volcano.lng, p.lat, p.lng) * 10) / 10
      : null;
  const mentioned: AffinityHit[] = [];
  const nearOnly: AffinityHit[] = [];
  for (const p of places) {
    if (p.id === volcano.id) continue;
    const where = volcanoMentioned(p.name, volcano.name) ? 'name'
      : p.desc && volcanoMentioned(p.desc, volcano.name) ? 'desc'
      : null;
    const d = km(p);
    if (where) mentioned.push({ place: p, where, km: d });
    else if (d != null && d <= nearKm) nearOnly.push({ place: p, where: null, km: d });
  }
  const byKm = (a: AffinityHit, b: AffinityHit) => (a.km ?? 1e9) - (b.km ?? 1e9);
  return { mentioned: mentioned.sort(byKm), nearOnly: nearOnly.sort(byKm) };
}
