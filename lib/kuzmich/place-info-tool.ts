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
 */
import { pool } from '@/lib/db-pool';
import { placeNameSearchSql } from '@/lib/places/name-match';
import { gradeNameMatch } from '@/lib/kuzmich/guardian-context';

export interface PlaceRow { name: string; description: string | null; category: string | null; district: string | null; is_visible?: boolean | null }
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
    parts.push(`${primary.name}${cat}${district}${primary.description ? ': ' + primary.description : ''}`);
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
  const placeMatch = placeNameSearchSql('name', placeName, 1);
  const [pr, kr] = await Promise.all([
    pool.query<PlaceRow>(
      // Слитые дубли отсекаются — то же правило, что у getGuardianContext и
      // resolvePlaceForLink, и та же сортировка «кратчайшее имя первым».
      // is_visible не фильтруется намеренно: у стража это записанное решение
      // («может знать скрытое место, но ссылку на невидимую страницу не даём»).
      `SELECT name, description, category, district, is_visible FROM places
        WHERE merged_into_id IS NULL AND (${placeMatch.clause})
        ORDER BY char_length(name) ASC
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
