/**
 * lib/routes/duplicate-audit.ts
 *
 * Сколько маршрутов в справочнике описывают одно и то же.
 *
 * ── Откуда взялся вопрос ───────────────────────────────────────────────────
 *
 * Пересуд привязок 11.08 дал 106 «неоднозначных» — треков, рядом с которыми
 * стоит другой маршрут вплотную. Разбор показал, что это в основном не чужие
 * привязки, а НАШИ СОБСТВЕННЫЕ ДВОЙНИКИ:
 *
 *   «Вулкан Горелый»                 ⟷ «Вулкан Горелый»
 *   «Маршрут Пиначево - Центральный» ⟷ «Маршрут Пиначево — Центральный»
 *   «Озеро Толмачева»                ⟷ «На каяках по озеру Толмачево»
 *
 * Вторая пара отличается только видом тире. Совпадение по имени их не
 * склеило, они живут двумя записями, и трек лёг на ту из них, чей якорь в
 * семидесяти четырёх километрах от него.
 *
 * Значит часть «лажи с маршрутами» не про геометрию вовсе: объектов в
 * справочнике больше, чем мест на Камчатке.
 *
 * ── Чего этот модуль НЕ делает ─────────────────────────────────────────────
 *
 * Не объявляет дубликатом по одной близости якорей. Урок Эссо: на Камчатке
 * маршруты стартуют из общих посёлков, и «две записи в одной точке» —
 * законная картина для перевалки. Близость идёт уликой только вместе с
 * похожим именем; всё остальное считается отдельно и называется своим
 * именем — «стоят рядом», а не «дубликаты».
 *
 * READ-ONLY: ничего не пишет и ничего не сливает.
 */

import { pool } from '@/lib/db-pool';
import { normalizeTitle } from '@/lib/import/kml-inbox';

/** Насколько близко якоря, чтобы вопрос вообще возник, км. */
export const SAME_SPOT_KM = 0.3;

/** Слова короче этого в сравнении имён не участвуют: «на», «по», «и». */
const MIN_TOKEN = 4;

/**
 * Сколько начальных букв слова сравнивать.
 *
 * Русское словоизменение меняет хвост: Толмачева / Толмачево / Толмачевом.
 * Шести букв хватает, чтобы «толмач» совпало, и мало, чтобы совпало что-то
 * постороннее.
 */
const STEM = 6;

const R = 6371;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const t = (d: number) => (d * Math.PI) / 180;
  const dLat = t(lat2 - lat1), dLng = t(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Родовые слова, общие для половины справочника.
 *
 * «Вулкан Горелый» и «Вулкан Мутновский» делят слово «вулкан», но общего у
 * них ровно столько же, сколько у двух улиц слово «улица». Основа роднит,
 * только если она в имени СОБСТВЕННОМ.
 *
 * Список намеренно короткий и из наших же названий: длинный список общих слов
 * начинает выкусывать смысл («источники» в «Малкинские источники» — родовое,
 * а вот «Дачные горячие источники» без него теряет половину имени, поэтому
 * решает не одно слово, а наличие ХОТЯ БЫ ОДНОЙ негородовой общей основы).
 */
const GENERIC = new Set([
  'вулкан', 'сопка', 'гора', 'хребет', 'перевал', 'кальдера',
  'озеро', 'озера', 'озеру', 'река', 'реки', 'ручей', 'бухта', 'залив',
  'источник', 'источники', 'горячие', 'термальные', 'водопад', 'долина',
  'кордон', 'парк', 'мыс', 'маршрут', 'поход', 'тропа', 'тур', 'экскурсия',
  'камчатка', 'камчатки',
  // Список пишется ЦЕЛЫМИ словами, а сравнение идёт по той же усечённой
  // основе, что и у названий. Иначе запись длиннее среза не совпадёт никогда:
  // до 11.08 здесь лежали 'источ' (пять букв) и 'перевал' (семь) при срезе в
  // шесть — и «источники» родовым словом не считались, вопреки комментарию
  // выше. Тест на «Малкинские источники» это и вскрыл. Усечение в одном
  // месте убирает весь класс ошибки, а не две её строки.
].map((w) => w.slice(0, STEM)));

/**
 * Заголовок записан латиницей — то есть это слаг из адреса, а не название.
 *
 * «dachnye istochniki», «ganalskie vostryaki», «mayak petropavlovskiy mys
 * vertikalnyy» — так скрейпер подставил кусок URL вместо заголовка страницы.
 * Беда не косметическая: «Дачные источники» лежат в справочнике ОТДЕЛЬНОЙ
 * записью, и совпадение по имени эти две никогда не склеит.
 *
 * Судим по наличию кириллицы, а не по списку слов: латинские буквы в русском
 * названии встречаются законно («SUP-маршрут по реке Пиначевская»), а вот
 * полное отсутствие кириллицы в названии камчатского маршрута — признак
 * машинного происхождения. Заодно отсекаются записи вроде «5 стройка»: в них
 * кириллица есть.
 */
export function isLatinTitle(title: string): boolean {
  return /[a-z]/i.test(title) && !/[а-яё]/i.test(title);
}

/** Значимые основы слов названия. Родовые слова отбрасываются. */
export function stems(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeTitle(title).split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < MIN_TOKEN) continue;
    const stem = w.slice(0, STEM);
    if (GENERIC.has(stem)) continue;
    out.add(stem);
  }
  return out;
}

/** Есть ли у названий общая значимая основа. */
export function shareStem(a: string, b: string): boolean {
  const sa = stems(a);
  for (const s of stems(b)) if (sa.has(s)) return true;
  return false;
}

/**
 * Концы пути, если название их называет: «Пиначево — Центральный».
 *
 * Возвращает null, когда название устроено иначе («Вулкан Горелый»).
 * Приведение уже свело все виды тире к дефису и убрало пробелы вокруг него,
 * поэтому делить можно по одному символу.
 */
export function endpoints(title: string): [string, string] | null {
  const parts = normalizeTitle(title).split('-').map((s) => s.trim()).filter(Boolean);
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

/**
 * Про одно ли эти два названия.
 *
 * Общий конец пути — не общий маршрут, и это не тонкость, а картина
 * справочника. Скопления якорей 11.08: на кордоне «Центральный» стоят
 * «Авачинский — Центральный», «Радыгино — Центральный», «5 стройка —
 * Центральный», «Центральный — Таловские источники». Слово «Центральный»
 * у них общее ПО УСТРОЙСТВУ НАЗВАНИЯ: так называется точка, из которой они
 * расходятся. Считать их одним предметом — та же ошибка, что считать одним
 * маршрутом всё, что выходит из Эссо, только на уровне букв, а не координат.
 *
 * Поэтому у названий-пар предметом считается ПАРА концов целиком: совпасть
 * должны оба, в любом порядке (обратный обход — тот же путь). Названия иного
 * устройства судятся как прежде — по общей значимой основе.
 */
export function sameSubject(a: string, b: string): boolean {
  const ea = endpoints(a), eb = endpoints(b);
  if (!ea || !eb) return shareStem(a, b);
  return (shareStem(ea[0], eb[0]) && shareStem(ea[1], eb[1]))
    || (shareStem(ea[0], eb[1]) && shareStem(ea[1], eb[0]));
}

export type DuplicateKind =
  /** Названия совпадают после приведения — двойник наверняка. */
  | 'same_name'
  /** Якоря в одной точке И названия про одно — очень вероятно двойник. */
  | 'same_spot_same_subject'
  /**
   * Якоря в одной точке, названия про разное.
   *
   * НЕ дубликат: на Камчатке это обычная перевалка, откуда расходятся разные
   * маршруты (урок Эссо). Считается отдельно, чтобы не выдать общий порог за
   * общий объект.
   */
  | 'same_spot_only';

export interface DuplicatePair {
  kind: DuplicateKind;
  a: { id: string; title: string };
  b: { id: string; title: string };
  anchorKm: number;
}

/** Сколько маршрутов делит одну и ту же точку якоря. */
export interface AnchorCluster {
  lat: number;
  lng: number;
  routes: number;
  /** Несколько названий — по ним видно, ЧТО это за точка. */
  sample: string[];
}

export interface DuplicateAudit {
  routes_counted: number;
  /**
   * Насколько якорь вообще различает маршруты.
   *
   * Пары «стоят в одной точке» ничего не говорят сами по себе — надо знать,
   * СКОЛЬКО различных точек обслуживают четыреста двадцать один маршрут.
   *
   * Замер 11.08 ответил: 287 точек, самое большое скопление — три записи, и
   * те про одно («Поход вокруг Толбачиков» и «Поход вокруг Толбачиков.
   * Камчатка»). То есть якорь РАЗЛИЧАЕТ, вопреки ожиданию, с которым это
   * поле заводилось. Ожидание строилось на 6188 парах «стоят рядом», а те
   * оказались артефактом `Number(null) === 0` в этой же переписи.
   *
   * Поле оставлено: без него вернуться к тому же неверному выводу нечем
   * помешать.
   */
  distinct_anchors: number;
  /** Крупнейшие скопления: по названиям видно, что это за общая точка. */
  anchor_clusters: AnchorCluster[];
  by_kind: Record<DuplicateKind, number>;
  /** Сколько маршрутов участвует хотя бы в одной паре-двойнике. */
  routes_in_duplicates: number;
  /**
   * Сколько записей вовсе без координат.
   *
   * Число, которое пряталось за `Number(null) === 0`: такие маршруты вставали
   * нулевой широтой в Гвинейском заливе и попадали в пары «стоят рядом» друг
   * с другом. Оно должно быть на виду — маршрут без якоря не показать на
   * карте и не найти «рядом со мной», и это отдельная беда, не двойники.
   */
  routes_without_anchor: number;
  /**
   * Откуда взялись записи без якоря — по источнику и категории.
   *
   * Сто двенадцать записей из четырёхсот двадцати одной нельзя ни показать на
   * карте, ни найти «рядом со мной». Чинить их можно двумя очень разными
   * способами — дозаполнить координаты или удалить как мусор импорта, — и
   * выбор зависит от того, ОДИН это источник или все понемногу. Пока это
   * неизвестно, любая правка будет догадкой.
   */
  anchorless_by_source: Array<{ source: string; category: string; routes: number; sample: string[] }>;
  /**
   * Чем безъякорная запись подтверждает, что она вообще маршрут.
   *
   * Разбор по источнику (проба 48) показал, что «сто двенадцать без
   * координат» — не одна беда, а три разные, и мерить их одним числом
   * бессмысленно:
   *
   *   1. Не маршруты вовсе. «История Камчатки», «Растения Камчатки»,
   *      «Когда лучше ехать на Камчатку» — статьи сайта kamchatkaland.ru,
   *      затянутые скрейпером в справочник МАРШРУТОВ. Координат у них нет не
   *      по недосмотру: у статьи нет места.
   *   2. Заголовок — слаг из адреса. «dachnye istochniki», «ganalskie
   *      vostryaki», «gornyy massiv vachkazhets». Запись про настоящее место,
   *      но названа машинным именем — и потому не склеивается с одноимённой
   *      кириллической («Дачные источники» лежит отдельной записью).
   *   3. Настоящие места без координат: озёра, источники, SUP-маршруты.
   *      Этим координату надо дозаполнить.
   *
   * Замер (проба 49) показал, что улики разделяют НЕ то, на что я
   * рассчитывал, и это стоит записать, чтобы никто не повторил:
   *
   *   nothing_at_all  97   ни координат, ни линии, ни путевых точек
   *   has_waypoints   15
   *   has_geometry     0   линии нет ни у одной — такой группы не существует
   *   latin_title      4
   *
   * Девяносто семь из ста двенадцати — то есть мера почти не различает.
   * В одной куче оказались и «Флора Камчатки» (статья), и «Поселок Эссо»
   * (населённый пункт), и «Восхождение на Плоский Толбачик» (настоящий
   * маршрут). ОТСУТСТВИЕ ДАННЫХ НЕ ОТЛИЧАЕТ статью от маршрута, которому
   * просто никто не проставил координату.
   *
   * Что улики говорят честно: у 97 записей нет НИКАКОГО позиционного
   * сведения, и на карте их не показать — это факт, и он полезен. Чем именно
   * является каждая — вопрос к записи, а не к этой мере.
   *
   * Пятнадцать с путевыми точками — единственная группа, где положение
   * выводится из имеющегося, а не выдумывается (миграция 847).
   *
   * Чем СТАТЬЮ отличить от маршрута — см. `anchorless_by_url_path`: адрес
   * страницы у источника, а не слова в названии.
   *
   * Все они при этом видимы: перепись считает только `is_visible` — то есть
   * «Растения Камчатки» лежат в справочнике маршрутов как маршрут.
   */
  anchorless_by_url_path: Array<{ path: string; routes: number; sample: string[] }>;
  /**
   * Безъякорный маршрут и МЕСТО, которые, похоже, про одно.
   *
   * Точное равенство имён (шаг 9c ремонта) дало НОЛЬ пар на 97 записей. Слово
   * владельца объяснило почему: «„Малкинские горячие источники“ против
   * „Малкинские источники“ — но у них одни геоточки». То есть объект один, а
   * разошлись имена: «горячие» — качество источника, а не часть названия.
   *
   * Отсюда не следует «сравнивать мягче». Отсюда следует ПОСМОТРЕТЬ, что
   * даст ослабление, прежде чем что-то писать в базу. Список кандидатов —
   * с обоими именами рядом, чтобы пара была видна глазом.
   *
   * Две ступени, и они РАЗНЫЕ по надёжности:
   *
   *   equal  — наборы значимых основ совпадают. Разница только в родовых
   *            словах и падежах.
   *   subset — основы одного строго входят в другой: ровно случай владельца
   *            («малкин» ⊂ «малкин, горячи»). Слабее: так же выглядит и
   *            «Гейзеры Камчатки» рядом с «Долиной гейзеров», а это статья
   *            рядом с настоящей точкой, и склеивать их нельзя.
   *
   * Поэтому ступени считаются и показываются ОТДЕЛЬНО. Ни одна из них не
   * применяется автоматически: сначала глаз, потом запись.
   */
  anchorless_name_candidates: {
    equal: number;
    subset: number;
    sample: Array<{ tier: 'equal' | 'subset'; route: string; place: string; lat: number; lng: number }>;
  };
  anchorless_evidence: {
    /** Ни координат, ни линии, ни путевых точек — маршрутность ничем не подтверждена. */
    nothing_at_all: number;
    /** Линия есть — место настоящее, потерялась только точка якоря. */
    has_geometry: number;
    /** Путевые точки есть. */
    has_waypoints: number;
    /** Заголовок записан латиницей: слаг из адреса вместо названия. */
    latin_title: number;
    /** Образцы самой безнадёжной группы — по ним человек и решает. */
    nothing_at_all_sample: string[];
    /** Образцы латинских заголовков: их надо переименовать, а не удалять. */
    latin_title_sample: string[];
  };
  thresholds: { same_spot_km: number; stem_len: number };
  worst: DuplicatePair[];
  duration_ms: number;
}

interface Row { id: string; title: string | null; lat: string | null; lng: string | null }

/**
 * Число из колонки, которой может не быть.
 *
 * `Number(null)` — это НОЛЬ, и в первом прогоне переписи 11.08 он стоил
 * ложного вывода. Маршруты без координат приходили нулевой широтой и нулевой
 * долготой, то есть все вставали в одну точку в Гвинейском заливе, — и
 * перепись отчиталась о 6188 парах «стоят рядом». Из этих пар был сделан
 * вывод, что якорь маршрута общий и потому бесполезен; на деле общей была
 * ПУСТОТА, а настоящих точек в справочнике 287 на 421 запись.
 *
 * Тот же класс дефекта, за которым эта перепись и охотилась, в самом
 * охотнике: отсутствие величины приняло вид величины. Отдельная функция —
 * чтобы `Number(` в этом файле больше не встречалось над данными из БД.
 */
function num(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function runDuplicateAudit(): Promise<DuplicateAudit> {
  const startedAt = Date.now();

  // Сколько РАЗЛИЧНЫХ точек обслуживают справочник. Округление до пятого
  // знака (~1 м) — чтобы «та же точка» не рассыпалась на шум последних цифр.
  const clusterRes = await pool.query<{ lat: string; lng: string; n: string; sample: string[] }>(
    `SELECT round(lat::numeric, 5)::text AS lat,
            round(lng::numeric, 5)::text AS lng,
            COUNT(*)::text AS n,
            (array_agg(title ORDER BY title))[1:4] AS sample
       FROM kamchatka_routes
      WHERE (is_visible = TRUE OR is_visible IS NULL)
        AND lat IS NOT NULL AND lng IS NOT NULL AND title IS NOT NULL
      GROUP BY 1, 2
      ORDER BY COUNT(*) DESC`,
  );
  const distinct_anchors = clusterRes.rows.length;
  const anchor_clusters: AnchorCluster[] = clusterRes.rows
    .filter((r) => parseInt(r.n, 10) > 1)
    .slice(0, 12)
    .map((r) => ({
      // Через ту же воронку, хотя запрос уже отсёк NULL: одно правило в одном
      // месте — иначе второе разойдётся с первым (за сутки это случилось дважды).
      lat: num(r.lat),
      lng: num(r.lng),
      routes: parseInt(r.n, 10),
      sample: r.sample ?? [],
    }))
    .filter((c): c is AnchorCluster => c.lat !== null && c.lng !== null);

  // Происхождение записей без якоря. Отдельным запросом, а не по строкам
  // ниже: источник нужен только здесь, и тащить его через всю попарную
  // развёртку значит носить с собой то, что нужно одной строке отчёта.
  const anchorlessRes = await pool.query<{
    source: string | null; category: string | null; n: string; sample: string[];
  }>(
    `SELECT source_name AS source, category, COUNT(*)::text AS n,
            (array_agg(title ORDER BY title))[1:3] AS sample
       FROM kamchatka_routes
      WHERE (is_visible = TRUE OR is_visible IS NULL)
        AND title IS NOT NULL
        AND (lat IS NULL OR lng IS NULL)
      GROUP BY 1, 2
      ORDER BY COUNT(*) DESC`,
  );
  // Что о безъякорной записи говорит АДРЕС её страницы у источника.
  //
  // Задача владельца 11.08 («статьи — из маршрутов в описание мест») упирается
  // в улику: по названию статья от маршрута не отличается, это доказала проба
  // 49. А сайт-источник раскладывает свои страницы по разделам сам, и раздел —
  // его собственное утверждение о том, что за страницу он опубликовал. Мы это
  // утверждение читаем, а не выводим из слов.
  const urlPathRes = await pool.query<{ path: string | null; n: string; sample: string[] }>(
    `SELECT substring(source_url from '^https?://[^/]+(/[^/?#]*)') AS path,
            COUNT(*)::text AS n,
            (array_agg(title ORDER BY title))[1:4] AS sample
       FROM kamchatka_routes
      WHERE (is_visible = TRUE OR is_visible IS NULL)
        AND title IS NOT NULL
        AND (lat IS NULL OR lng IS NULL)
      GROUP BY 1
      ORDER BY COUNT(*) DESC`,
  );
  const anchorless_by_url_path = urlPathRes.rows.map((r) => ({
    // «(адреса нет)», а не пустая строка: отсутствие адреса означает, что
    // сказать о записи нечего, и это надо видеть, а не принимать за раздел.
    path: r.path ?? '(адреса нет)',
    routes: parseInt(r.n, 10),
    sample: r.sample ?? [],
  }));

  const anchorless_by_source = anchorlessRes.rows.map((r) => ({
    // «(не указан)», а не пустая строка: отсутствие источника — это тоже
    // сведение о происхождении, и его надо видеть, а не принимать за пробел.
    source: r.source ?? '(не указан)',
    category: r.category ?? '(без категории)',
    routes: parseInt(r.n, 10),
    sample: r.sample ?? [],
  }));

  // Улики маршрутности у безъякорных. Спрашиваем данные, а не название:
  // «История Камчатки» — не маршрут по своей природе, но судить об этом по
  // словам значило бы гадать, а вот отсутствие линии И путевых точек —
  // проверяемый факт.
  const evidenceRes = await pool.query<{
    id: string; title: string; has_geometry: boolean; waypoints: string;
  }>(
    `SELECT r.id::text, r.title,
            (r.geometry IS NOT NULL) AS has_geometry,
            (SELECT COUNT(*) FROM route_waypoints w WHERE w.route_id = r.id)::text AS waypoints
       FROM kamchatka_routes r
      WHERE (r.is_visible = TRUE OR r.is_visible IS NULL)
        AND r.title IS NOT NULL
        AND (r.lat IS NULL OR r.lng IS NULL)`,
  );

  // Кандидаты «маршрут без якоря ⟷ место»: что дало бы ослабление равенства.
  // Только отчёт. Ослаблять правило ремонта по этим цифрам — отдельное
  // решение, и принимается оно, посмотрев на пары, а не на число.
  const nameCandidates: DuplicateAudit['anchorless_name_candidates'] = {
    equal: 0, subset: 0, sample: [],
  };
  {
    const { rows: placeRows } = await pool.query<{ name: string; lat: string; lng: string }>(
      `SELECT name, lat::text AS lat, lng::text AS lng
         FROM places
        WHERE name IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL`,
    );
    const places = placeRows
      // Имя может не прийти, хотя запрос его требует: строка без имени по
      // имени и не сопоставляется, а падать на ней незачем.
      .filter((p): p is { name: string; lat: string; lng: string } => typeof p.name === 'string' && p.name !== '')
      .map((p) => ({ name: p.name, lat: num(p.lat), lng: num(p.lng), core: stems(p.name) }))
      .filter((p): p is { name: string; lat: number; lng: number; core: Set<string> } =>
        p.core.size > 0 && p.lat !== null && p.lng !== null);

    const isSubset = (a: Set<string>, b: Set<string>) => {
      if (a.size === 0 || a.size >= b.size) return false;
      for (const s of a) if (!b.has(s)) return false;
      return true;
    };
    const sameSet = (a: Set<string>, b: Set<string>) => {
      if (a.size !== b.size) return false;
      for (const s of a) if (!b.has(s)) return false;
      return true;
    };

    for (const r of evidenceRes.rows) {
      if (typeof r.title !== 'string' || r.title === '') continue;
      const core = stems(r.title);
      if (core.size === 0) continue;
      for (const p of places) {
        const tier: 'equal' | 'subset' | null = sameSet(core, p.core) ? 'equal'
          : (isSubset(core, p.core) || isSubset(p.core, core)) ? 'subset' : null;
        if (!tier) continue;
        nameCandidates[tier] += 1;
        if (nameCandidates.sample.length < 20) {
          nameCandidates.sample.push({ tier, route: r.title, place: p.name, lat: p.lat, lng: p.lng });
        }
      }
    }
    // Сначала надёжная ступень: по ней и судить, стоит ли смотреть вторую.
    nameCandidates.sample.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'equal' ? -1 : 1));
  }

  const nothingAtAll: string[] = [];
  const latinTitles: string[] = [];
  let hasGeometry = 0, hasWaypoints = 0;
  for (const r of evidenceRes.rows) {
    const wps = parseInt(r.waypoints, 10) || 0;
    if (r.has_geometry) hasGeometry += 1;
    if (wps > 0) hasWaypoints += 1;
    if (!r.has_geometry && wps === 0) nothingAtAll.push(r.title);
    if (isLatinTitle(r.title)) latinTitles.push(r.title);
  }

  const res = await pool.query<Row>(
    `SELECT id::text, title, lat::text, lng::text
       FROM kamchatka_routes
      WHERE (is_visible = TRUE OR is_visible IS NULL)
        AND title IS NOT NULL`,
  );

  const routes = res.rows
    .map((r) => ({
      id: r.id,
      title: r.title as string,
      norm: normalizeTitle(r.title as string),
      lat: num(r.lat),
      lng: num(r.lng),
    }))
    .filter((r) => r.norm !== '');

  const by_kind: Record<DuplicateKind, number> = {
    same_name: 0, same_spot_same_subject: 0, same_spot_only: 0,
  };
  const pairs: DuplicatePair[] = [];
  const involved = new Set<string>();

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i], b = routes[j];
      const sameName = a.norm === b.norm;

      // Расстояние считается, только если обе координаты ЕСТЬ. Отсутствие
      // координат — не ноль километров и не нулевая широта: пара без
      // координат судится именем, а «рядом ли они» остаётся неизвестным.
      const haveCoords = a.lat !== null && a.lng !== null && b.lat !== null && b.lng !== null;
      const km = haveCoords ? haversineKm(a.lat!, a.lng!, b.lat!, b.lng!) : Infinity;
      const sameSpot = km <= SAME_SPOT_KM;

      let kind: DuplicateKind | null = null;
      if (sameName) kind = 'same_name';
      else if (sameSpot) kind = sameSubject(a.title, b.title) ? 'same_spot_same_subject' : 'same_spot_only';
      if (!kind) continue;

      by_kind[kind] += 1;
      if (kind !== 'same_spot_only') {
        involved.add(a.id);
        involved.add(b.id);
      }
      pairs.push({
        kind,
        a: { id: a.id, title: a.title },
        b: { id: b.id, title: b.title },
        anchorKm: haveCoords ? Math.round(km * 100) / 100 : -1,
      });
    }
  }

  // Сначала уверенные двойники, потом «одно место, один предмет».
  const order: Record<DuplicateKind, number> = {
    same_name: 0, same_spot_same_subject: 1, same_spot_only: 2,
  };
  pairs.sort((x, y) => order[x.kind] - order[y.kind] || x.anchorKm - y.anchorKm);

  return {
    routes_counted: routes.length,
    distinct_anchors,
    anchor_clusters,
    by_kind,
    routes_in_duplicates: involved.size,
    routes_without_anchor: routes.filter((r) => r.lat === null || r.lng === null).length,
    anchorless_by_source,
    anchorless_by_url_path,
    anchorless_name_candidates: nameCandidates,
    anchorless_evidence: {
      nothing_at_all: nothingAtAll.length,
      has_geometry: hasGeometry,
      has_waypoints: hasWaypoints,
      latin_title: latinTitles.length,
      nothing_at_all_sample: nothingAtAll.slice(0, 12),
      latin_title_sample: latinTitles.slice(0, 12),
    },
    thresholds: { same_spot_km: SAME_SPOT_KM, stem_len: STEM },
    worst: pairs.slice(0, 25),
    duration_ms: Date.now() - startedAt,
  };
}
