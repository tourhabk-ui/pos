/**
 * Можно ли сегодня рекламировать тур в канале (25.09).
 *
 * Владелец 25.09 прислал снимок канала: «Летняя рыбалка на чавычу и нерку» —
 * «летняя? уже сентябрь». Сезон тура на проде записан 01.06–15.08, то есть
 * пост вышел через сорок дней после его конца. Выбор тура для канала смотрел
 * на фото и на паузу между повторами, но не на даты. У каталога правило сезона
 * уже было (`catalogAvailability`), до канала оно не доходило.
 *
 * Пост о туре — оферта: турист жмёт «Подробности и бронирование» и хочет
 * поехать. Реклама поездки, которую купить нельзя, — ложь, как бы честно ни
 * был собран текст поста.
 *
 * Два источника, и каждый может сказать «нет»:
 *   - даты оператора (`season_start/season_end`) — то же правило, что у
 *     каталога: поездка, начатая завтра, должна успеть закончиться в сезоне;
 *   - рыба, названная в ТЕКСТЕ ПОСТА (заголовок и краткое описание): если ни
 *     один названный вид не идёт ни в этом, ни в следующем месяце, пост
 *     обещает то, чего сейчас нет. Сезоны видов — из единого справочника
 *     `lib/fish-species.ts`, своих здесь нет.
 *
 * Исходов три (§4.0): `in_season` — даты есть и сезон идёт или впереди;
 * `unknown` — дат нет, опровержения тоже; `out_of_season` — хоть один
 * источник опроверг. Незнание не выдаётся за «сезон», и вызывающий ставит
 * такие туры после проверенных.
 *
 * Слово «летняя» в заголовке сезоном не считается: «Летняя рыбалка на
 * кижуча» у оператора идёт до 15.10, и кижуч в сентябре — самый ход. Имя —
 * решение оператора, сезон — его даты.
 */
import { catalogAvailability, type AvailabilityInput } from '@/lib/tours/catalog-availability';
import { detectFishSpecies } from '@/lib/fish-species';

export type PostSeason = 'in_season' | 'unknown' | 'out_of_season';

export interface PostSeasonInput extends Omit<AvailabilityInput, 'has_availability'> {
  title: string;
  short_description: string | null;
}

export interface PostSeasonVerdict {
  season: PostSeason;
  reason: string;
}

/** Камчатка — UTC+12 без перехода на летнее время. */
const KAMCHATKA_OFFSET_MS = 12 * 60 * 60 * 1000;

function kamchatkaMonth(now: Date): number {
  return new Date(now.getTime() + KAMCHATKA_OFFSET_MS).getUTCMonth() + 1;
}

function dayLabel(d: string): string {
  const x = new Date(d);
  return Number.isFinite(x.getTime())
    ? `${String(x.getUTCDate()).padStart(2, '0')}.${String(x.getUTCMonth() + 1).padStart(2, '0')}.${x.getUTCFullYear()}`
    : d;
}

export function tourPostSeason(t: PostSeasonInput, now: Date = new Date()): PostSeasonVerdict {
  if (t.season_end && catalogAvailability({ ...t, has_availability: null }, now) === 'season_over') {
    return { season: 'out_of_season', reason: `сезон тура закончился ${dayLabel(t.season_end)}` };
  }

  const text = [t.title, t.short_description ?? ''].join(' ');
  const fish = detectFishSpecies(text);
  if (fish.length > 0) {
    const month = kamchatkaMonth(now);
    const next = (month % 12) + 1;
    const running = fish.some((f) => f.seasonMonths.includes(month) || f.seasonMonths.includes(next));
    if (!running) {
      return {
        season: 'out_of_season',
        reason: `в тексте поста ${fish.map((f) => `${f.name.toLowerCase()} (${f.season.toLowerCase()})`).join(', ')} — сейчас не сезон`,
      };
    }
  }

  if (t.season_start && t.season_end) return { season: 'in_season', reason: `сезон ${dayLabel(t.season_start)}–${dayLabel(t.season_end)}` };
  return { season: 'unknown', reason: 'сезон у тура не записан' };
}

const RANK: Record<PostSeason, number> = { in_season: 0, unknown: 1, out_of_season: 2 };

/**
 * Первый тур для поста: сначала с подтверждённым сезоном, потом с незаписанным,
 * внутри группы — в порядке, который дал вызывающий. Вне сезона — никогда.
 * Возвращает и отсеянных с причинами: молча выброшенный тур выглядел бы как
 * «туров нет».
 */
export function pickInSeason<T extends PostSeasonInput>(
  rows: T[],
  now: Date = new Date(),
): { pick: T | null; verdict: PostSeasonVerdict | null; skipped: Array<{ title: string; reason: string }> } {
  const judged = rows.map((row, i) => ({ row, i, v: tourPostSeason(row, now) }));
  const skipped = judged.filter((j) => j.v.season === 'out_of_season').map((j) => ({ title: j.row.title, reason: j.v.reason }));
  const best = judged
    .filter((j) => j.v.season !== 'out_of_season')
    .sort((a, b) => RANK[a.v.season] - RANK[b.v.season] || a.i - b.i)[0];
  return { pick: best?.row ?? null, verdict: best?.v ?? null, skipped };
}
