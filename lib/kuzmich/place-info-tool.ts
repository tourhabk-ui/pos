/**
 * Ответ `get_place_info` — об ОДНОМ месте (25.09).
 *
 * Сверка MCP 25.09: «Курильское озеро» вернуло озеро, кальдеру и чужой кусок
 * про Долину гейзеров одним сплошным текстом. Причин две, обе в выборке:
 *
 *  - до трёх мест с похожим именем шли с ПОЛНЫМИ описаниями подряд — агент
 *    не мог понять, какое из них спрошенное;
 *  - заметки Кузьмича находились по `compiled_truth ILIKE '%запрос%'`, то есть
 *    по любому упоминанию в тексте: заметка о Долине гейзеров, где сказано
 *    «вертолёт летит мимо Курильского озера», становилась ответом об озере.
 *
 * Правило: первое (самое точное) место — целиком; остальные — только
 * названиями, с пометкой «спросите отдельно»; заметки — только те, чей
 * ЗАГОЛОВОК про это место (`gradeNameMatch`, то же правило, что у стража).
 *
 * Факты — впереди текста (26.09). Описание инструмента обещает «type,
 * coordinates, hazards», а ответом было одно `places.description` — у
 * Авачинского это рассказ от первого лица («Вчера поднялся…»), и внешняя
 * проверка MCP справедливо приняла его за художественный текст вместо
 * карточки. Теперь сначала строки фактов из `places` и
 * `location_safety_profile` (JOIN по `agent_route_id = places.ark_id`, §9),
 * потом «Описание:» — подписанным. Пустое поле — строки нет: ничего не
 * выдумывается (§4.0). Неизвестный ключ опасности пропускается — ответ читает
 * и Кузьмич вслух, а английское слово внутри русской фразы хуже пропуска
 * (то же решение, что у lib/kuzmich/place-advisory).
 */
import { pool } from '@/lib/db-pool';
import { placeNameSearchSql } from '@/lib/places/name-match';
import { gradeNameMatch } from '@/lib/kuzmich/guardian-context';
import { placeTypeLabel } from '@/lib/places/type-label';
import { HAZARDS } from '@/lib/safety/hazard-labels';

export interface PlaceRow {
  name: string; description: string | null; category: string | null; district: string | null; is_visible?: boolean | null;
  location_type?: string | null;
  lat?: string | number | null; lng?: string | number | null;
  altitude_m?: number | null;
  hazard_types?: string[] | null;
  nearest_medical_km?: string | number | null;
  sat_communicator_required?: boolean | null;
  registration_required?: boolean | null;
}

/** Описание длиннее этого режется по концу предложения: карточка, не статья. */
export const PLACE_DESCRIPTION_MAX = 700;

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clipDescription(text: string): string {
  const t = text.trim();
  if (t.length <= PLACE_DESCRIPTION_MAX) return t;
  const cut = t.slice(0, PLACE_DESCRIPTION_MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > PLACE_DESCRIPTION_MAX / 2 ? cut.slice(0, end + 1) : cut.trimEnd()) + ' …';
}

/** Строки фактов о месте — только то, что записано. */
export function placeFactLines(p: PlaceRow): string[] {
  const lines: string[] = [];
  const type = placeTypeLabel(p.location_type ?? p.category);
  if (type) lines.push(`Тип: ${type.toLocaleLowerCase('ru-RU')}`);
  const lat = num(p.lat), lng = num(p.lng);
  if (lat != null && lng != null) lines.push(`Координаты: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  if (p.altitude_m != null && p.altitude_m > 0) lines.push(`Высота: ${p.altitude_m} м`);
  const hazards = (p.hazard_types ?? [])
    .map((h) => HAZARDS[h]?.label?.toLocaleLowerCase('ru-RU'))
    .filter((h): h is string => Boolean(h));
  if (hazards.length > 0) lines.push(`Опасности: ${[...new Set(hazards)].join(', ')}`);
  const medical = num(p.nearest_medical_km);
  if (medical != null) lines.push(`До медпомощи: ${Math.round(medical)} км`);
  if (p.sat_communicator_required === true) lines.push('Спутниковая связь: нужна — сотовой может не быть');
  if (p.registration_required === true) lines.push('Регистрация группы в МЧС: требуется');
  return lines;
}
export interface NoteRow { title: string; compiled_truth: string }

export function composePlaceInfo(query: string, places: PlaceRow[], notes: NoteRow[]): string | null {
  const [primary, ...rest] = places;
  // Скрытое место в «похожих» не называется (решение владельца 25.09): список
  // зовёт спросить о нём отдельно, а скрытые — это мусор вроде «Долина
  // гейзеров. Курильское озеро. Вулканы Горелый и Авача» (экскурсия, попавшая
  // в места) и сняты с сайта. Основной ответ правило 19.09 не меняет: страж
  // может знать скрытое место.
  const others = rest.filter((p) => p.is_visible !== false);
  const own = notes.filter((n) => gradeNameMatch(query, n.title) === 'high');
  if (!primary && own.length === 0) return null;

  const parts: string[] = [];
  if (primary) {
    const cat = primary.category ? ` [${primary.category}]` : '';
    const district = primary.district ? ` (${primary.district})` : '';
    const card = [`${primary.name}${cat}${district}`, ...placeFactLines(primary)];
    if (primary.description?.trim()) card.push(`Описание: ${clipDescription(primary.description)}`);
    parts.push(card.join('\n'));
  }
  for (const n of own) parts.push(`Заметка Кузьмича «${n.title}»: ${n.compiled_truth}`);
  if (others.length > 0) {
    parts.push(`Другие объекты с похожим названием — это ОТДЕЛЬНЫЕ места, спросите о них отдельно: ${others
      .map((o) => `${o.name}${o.category ? ` [${o.category}]` : ''}`).join('; ')}.`);
  }
  return parts.join('\n\n');
}

export async function placeInfoForKuzmich(placeName: string): Promise<string | null> {
  // Слова, не буквальная фраза (issue #1987): «Горелый вулкан» не содержится
  // подстрокой в «Вулкан Горелый».
  const placeMatch = placeNameSearchSql('p.name', placeName, 1);
  const [pr, kr] = await Promise.all([
    pool.query<PlaceRow>(
      // Слитые дубли отсекаются — то же правило, что у getGuardianContext и
      // resolvePlaceForLink, и та же сортировка «кратчайшее имя первым».
      // is_visible не фильтруется намеренно: у стража это записанное решение
      // («может знать скрытое место, но ссылку на невидимую страницу не даём»).
      `SELECT p.name, p.description, p.category, p.district, p.is_visible,
              p.location_type, p.lat, p.lng,
              lsp.altitude_m, lsp.hazard_types, lsp.nearest_medical_km,
              lsp.sat_communicator_required, lsp.registration_required
         FROM places p
         LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
        WHERE p.merged_into_id IS NULL AND (${placeMatch.clause})
        ORDER BY char_length(p.name) ASC
        LIMIT 3`,
      placeMatch.params,
    ),
    pool.query<NoteRow>(
      // Только по заголовку: упоминание места в чужой заметке — не заметка о
      // нём. type <> 'outcome' — служебные оценки ответов туристу не отдаются
      // (20.09: «Оценка ответа: 6/10» ушла ответом про озеро).
      `SELECT title, compiled_truth FROM agent_knowledge
        WHERE agent_id='kuzmich' AND type <> 'outcome' AND title ILIKE $1
        LIMIT 3`,
      [`%${placeName}%`],
    ),
  ]);
  return composePlaceInfo(placeName, pr.rows, kr.rows);
}
