/**
 * «Подними всё на 10%», «наценка на выходные 15%» — K.ai B4.
 *
 * Без модели: процент — только из слов партнёра, цифры предпросмотра — из
 * движка счёта. Кузьмич цены НЕ ПИШЕТ: он кладёт изменение на сервер и даёт
 * ссылку; меняет цену подтверждение на сайте (вход, право цен, 24 часа,
 * одноразово — решение владельца 03.11). В тексте — только туры и цены,
 * личных данных нет.
 */
import { pool } from '@/lib/db-pool';
import { changeProblem, previewPriceChange, previewText, type PriceChange } from '@/lib/crm/price-preview';
import { confirmUrl, createPendingChange } from '@/lib/crm/price-change';

export type PhraseParse = { change: PriceChange } | { problem: string } | null;

/** Тур партнёра для разбора фразы: id и название. */
export interface PhraseTour { id: number; title: string }

/** Слова команды — не название тура. */
const COMMAND_WORD = /^(подн|поды|повыс|увелич|накин|накрут|дорож|сниз|опуст|уменьш|пониз|дешев|наценк|надбавк|цен|тур|прайс|стоим|базов|процент|выходн|суббот|воскрес|пожалуйст|сдела|постав|убер|сним|отмен|выключ|мои|моих|мой|моем|этот|этом|котор|только|один|одн|для|нужн|надо|давай|хочу|срочн|сегодн|завтр|сейчас|тоже|также|всего|позже|пока|чтоб|прошу|можно|ставк)/;
const ALL_TOURS = /(^|[^а-я])(вс[её]|все|всех|всем|везде|кажд)([^а-я]|$)/;

function norm(raw: string): string {
  return raw.toLowerCase().replace(/ё/g, 'е');
}

function words(raw: string): string[] {
  return norm(raw).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w));
}

const stem = (w: string) => w.slice(0, Math.min(w.length, 5));

/**
 * Какие туры назвал партнёр. 'all' — «всё/все туры» или тур не назван;
 * массив — названные туры; `{ unknown }` — слова похожи на название, но
 * такого тура нет (не угадываем, переспрашиваем).
 *
 * Тур считается названным, если слово фразы (кроме слов команды) совпадает
 * с началом слова в названии (≥4 букв, по первым 5 — падежи: «Мутновский» /
 * «Мутновского»). Из нескольких совпавших берутся туры с наибольшим числом
 * совпавших слов.
 */
export function scopeTours(raw: string, tours: readonly PhraseTour[]): number[] | 'all' | { unknown: string } {
  const t = norm(raw);
  if (ALL_TOURS.test(t)) return 'all';
  const asked = words(t).filter((w) => !COMMAND_WORD.test(w));
  if (asked.length === 0) return 'all';
  let best = 0;
  let ids: number[] = [];
  for (const tour of tours) {
    const title = words(tour.title).map(stem);
    const hits = asked.filter((w) => title.some((tw) => tw.startsWith(stem(w)) || stem(w).startsWith(tw))).length;
    if (hits === 0) continue;
    if (hits > best) { best = hits; ids = [tour.id]; } else if (hits === best) ids.push(tour.id);
  }
  return ids.length > 0 ? ids : { unknown: asked.join(' ') };
}

const WEEKEND = /выходн|суббот|воскрес|(^|[^а-я])(сб|вс)([^а-я]|$)/;
const UP = /подним|подыми|повыс|увелич|накин|накрут|дороже|наценк|надбавк/;
const DOWN = /сниз|опуст|уменьш|пониз|дешевле/;
const REMOVE = /(убер|сним|отмен|выключ)[а-я]*\s+(\S+\s+)?(наценк|надбавк)/;
const PRICE = /цен|(^|[^а-я])все([^а-я]|$)|тур|прайс|наценк|надбавк/;

/** Разбор фразы. null — это не про изменение цены (пусть отвечает обычный путь). */
export function parsePriceChangePhrase(raw: string, tours?: readonly PhraseTour[]): PhraseParse {
  const t = raw.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  // Скидки на последние места и группу — свой экран; сюда не берём.
  if (/скидк/.test(t)) return null;
  const pct = /(\d+(?:[.,]\d+)?)\s*(%|процент)/.test(t);
  const remove = REMOVE.test(t) && WEEKEND.test(t);
  if (!pct && !remove) return null;
  if (!(UP.test(t) || DOWN.test(t) || remove || /наценк|надбавк/.test(t))) return null;
  // Туры не переданы — как раньше, все туры (обратная совместимость разбора).
  const scope = tours ? scopeTours(t, tours) : 'all';
  const named = Array.isArray(scope);
  // «Подними Мутновский на 10%»: названный тур — тоже про цену, слово «цены» не нужно.
  if (!remove && !PRICE.test(t) && !named) return null;
  if (scope !== 'all' && !named) {
    return { problem: `Не нашёл у вас тур «${scope.unknown}». Назовите тур, как он записан на сайте, или скажите «все туры».` };
  }
  const tourIds: number[] | 'all' = scope;
  if (remove) return { change: { kind: 'weekend_markup', percent: null, tourIds } };
  const m = /(\d+(?:[.,]\d+)?)\s*(%|процент)/.exec(t);
  if (!m) return null;
  const up = UP.test(t), down = DOWN.test(t);
  if (up === down) return null; // направление не названо или названы оба — не угадываем
  const n = Number(m[1].replace(',', '.'));
  const change: PriceChange = WEEKEND.test(t)
    ? { kind: 'weekend_markup', percent: n, tourIds }
    : { kind: 'base_price', percent: up ? n : -n, tourIds };
  if (WEEKEND.test(t) && down) return { problem: 'На выходные можно только наценку. Снизить цену в выходные — через скидку на экране «Скидки».' };
  const problem = changeProblem(change);
  return problem ? { problem } : { change };
}

/** Туры партнёра для разбора фразы (только id и название). */
async function partnerTours(partnerId: string): Promise<PhraseTour[]> {
  const { rows } = await pool.query<{ id: number; title: string }>(
    `SELECT id::int AS id, title FROM operator_tours WHERE operator_id = $1 AND deleted_at IS NULL`,
    [partnerId],
  );
  return rows;
}

/** Кнопка-ссылка под ответом; в канале без кнопок ссылка остаётся в тексте. */
export interface PriceChangeAnswer { text: string; button?: { text: string; url: string } }

/** Ответ на фразу или null — фраза не про цены. */
export async function handlePriceChangePhrase(opts: { partnerId: string; sellsTours: boolean; text: string; nowMs: number }): Promise<PriceChangeAnswer | null> {
  if (!opts.sellsTours) return null;
  // Быстрый отказ без базы: фраза не про цены ни для всех туров, ни для тура,
  // названного её же словами («подними Мутновский на 10%»), — туры не грузим.
  if (parsePriceChangePhrase(opts.text) === null && parsePriceChangePhrase(opts.text, [{ id: 0, title: opts.text }]) === null) return null;
  let tours: PhraseTour[] | undefined;
  try { tours = await partnerTours(opts.partnerId); } catch (err) {
    console.error('[price-change-phrase] туры не прочитаны:', err instanceof Error ? err.message : String(err));
    return { text: 'Не смог прочитать ваши туры — ничего не менял. Попробуйте ещё раз или на сайте, «Скидки и наценки».' };
  }
  const parsed = parsePriceChangePhrase(opts.text, tours);
  if (parsed === null) return null;
  if ('problem' in parsed) return { text: `${parsed.problem}\nЦены не менял.` };
  try {
    const preview = await previewPriceChange(opts.partnerId, parsed.change, opts.nowMs);
    if (preview.tours.length === 0) return { text: 'Понял так: изменить цены. Но туров для изменения не нашлось — цены не менял.' };
    const id = await createPendingChange(pool, opts.partnerId, preview, opts.nowMs);
    const url = confirmUrl(id);
    return {
      text: [
        `Понял так: ${previewText(preview)}`,
        '',
        'Я цены не меняю. Проверьте и подтвердите на сайте (нужен вход, ссылка одноразовая, действует 24 часа):',
        url,
      ].join('\n'),
      button: { text: 'Проверить и подтвердить', url },
    };
  } catch (err) {
    console.error('[price-change-phrase] предпросмотр не собран:', err instanceof Error ? err.message : String(err));
    return { text: 'Не смог посчитать новые цены — ничего не менял. Попробуйте ещё раз или на сайте, «Скидки и наценки».' };
  }
}
