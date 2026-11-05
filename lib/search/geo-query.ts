/**
 * ПОИСК · места, маршруты и парки по словам запроса — для поиска в шапке
 * сайта (`/api/search`, лупа и Ctrl+K).
 *
 * До 05.11 шапка искала всю строку одним `ILIKE '%строка%'`: место проходило,
 * только если слова стоят в имени подряд и в той же форме. «Озеро Курильское»
 * не находило «Курильское озеро», «вулкан Горелый» — «Горелый», «Kurile Lake»
 * и «volcano» — ничего, хотя `search` коннектора с 12.10 режет запрос на слова
 * и переводит английские. Теперь шапка ищет тем же правилом
 * (`searchTerms`, lib/search/query-words): запись проходит по ЛЮБОМУ слову,
 * выше та, где совпало больше слов, затем точное имя, затем короткое.
 *
 * Заодно места — только видимые (`is_visible`): скрытая миграцией запись
 * (координата без источника, тур под видом места) находилась шапкой, хотя
 * `/api/places` и `search` коннектора её не отдают.
 *
 * SQL здесь собирается только из литералов и плейсхолдеров `$n`; слова
 * запроса уходят параметрами, шаблоном «содержит» (`containsPattern`).
 *
 * Сторож: tests/unit/search-geo-words.test.ts, настоящий PostgreSQL —
 * tests/integration/search-geo-words.pg.test.ts.
 */
import { containsPattern, escapeLike } from '@/lib/db/like';
import { MATCHES_NAME_OR_ALIAS, NOT_MERGED } from '@/lib/places/aliases';
import { searchTerms } from './query-words';

export interface SearchQuery {
  sql: string;
  params: Array<string | number>;
}

/**
 * Общая часть: $1 — запрос целиком (точное имя — выше), $2..$(n+1) — слова,
 * последний — предел. `cond(p)` — условие совпадения одного слова.
 */
function byWords(q: string, limit: number, cond: (param: string) => string) {
  const terms = searchTerms(q);
  const conds = terms.map((_, i) => cond(`$${i + 2}`));
  return {
    where: conds.map((c) => `(${c})`).join(' OR '),
    hits: conds.map((c) => `(${c})::int`).join(' + '),
    limit: `$${terms.length + 2}`,
    params: [escapeLike(q.trim()), ...terms.map(containsPattern), limit] as Array<string | number>,
  };
}

/** Места: имя или псевдоним, только видимые и не слитые. */
export function placesSearchQuery(q: string, limit: number): SearchQuery {
  const w = byWords(q, limit, (p) => MATCHES_NAME_OR_ALIAS('p', p));
  return {
    sql: `SELECT p.id, p.name AS title, p.location_type, (${w.hits}) AS hits
       FROM places p
      WHERE p.is_visible = TRUE AND ${NOT_MERGED('p')}
        AND (${w.where})
      ORDER BY hits DESC,
               CASE WHEN p.name ILIKE $1 THEN 0 ELSE 1 END,
               LENGTH(p.name) ASC
      LIMIT ${w.limit}`,
    params: w.params,
  };
}

/**
 * Маршруты по названию — запасной путь, когда поиск по смыслу выключен или
 * не ответил. id — в пространстве VIEW agent_route_knowledge
 * (COALESCE(ark_id, id)): по нему строится ссылка /routes/[id].
 */
export function routesSearchQuery(q: string, limit: number): SearchQuery {
  const w = byWords(q, limit, (p) => `title ILIKE ${p}`);
  return {
    sql: `SELECT COALESCE(ark_id, id) AS id, title, category, (${w.hits}) AS hits
       FROM kamchatka_routes
      WHERE is_visible = TRUE AND merged_into_id IS NULL
        AND (${w.where})
      ORDER BY hits DESC,
               CASE WHEN title ILIKE $1 THEN 0 ELSE 1 END,
               LENGTH(title) ASC
      LIMIT ${w.limit}`,
    params: w.params,
  };
}

/** Парки: справочник маленький, до трёх строк. */
export function parksSearchQuery(q: string): SearchQuery {
  const w = byWords(q, 3, (p) => `display_name ILIKE ${p}`);
  return {
    sql: `SELECT slug, display_name, (${w.hits}) AS hits
       FROM parks
      WHERE is_active = TRUE
        AND (${w.where})
      ORDER BY hits DESC,
               CASE WHEN display_name ILIKE $1 THEN 0 ELSE 1 END,
               display_name
      LIMIT ${w.limit}`,
    params: w.params,
  };
}
