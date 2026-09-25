/**
 * Серверный data-слой Главной v8 «Воронка».
 * Все блоки, что выглядят как приборы, тянут РЕАЛЬНЫЕ данные — иначе блока нет.
 * Источники подтверждены по коду:
 *   - external_alerts        → лента безопасности (severity/title/type/expires)
 *   - volcano_status (KVERT) → ACC-статус вулканов (aviation_color_code)
 *   - location_real_time_status → открыто/закрыто зон + свежесть
 *   - operator_tours         → платы «Туры сезона» (реальные туры: фото, цена, оператор)
 *   - operator_bookings …    → живой журнал
 *   - places counts          → «Стихии» и «В цифрах»
 * Каждая выборка в своём try/catch: сбой одного блока не роняет страницу.
 */

import { query } from '@/lib/database';
import { FEED_ALERT_TYPES } from '@/lib/services/safety/feed-types';
import {
  FRESH_APPROVED_SQL,
  SIGHTING_WINDOW_DAYS,
  sightingAgeLabel,
} from '@/lib/safety/bear-sightings';
import { getSeismicFeed, type SeismicEvent } from '@/lib/services/safety/seismic-feed';
import { volcanoMarks, kfegsIsFresh, type KfegsReading, type ScaleColor } from '@/lib/services/safety/volcano-scales';
import { getPlatformCounts, type PlatformCounts } from '@/lib/stats/platform-counts';
import { groupPlacesByElement } from '@/lib/stats/element-groups';
import { plural } from '@/lib/home/data-freshness';
import { orderPlates } from '@/lib/home/plate-facts';
import { catalogAvailability, type CatalogAvailability } from '@/lib/tours/catalog-availability';
import { hasAvailabilitySql, LIVE_TOUR_CONDITIONS } from '@/lib/search/tour-search';
import { HOME_ALERTS_LIMIT } from '@/lib/home/radar-summary';
import { countRoutesWithoutGeometry, type RouteGeometryGap } from '@/lib/services/routes/routes-geometry-health';

export interface SafetyAlert {
  title: string;
  description: string | null;
  type: string | null;
  severity: number;
  at: string | null;
  /** До какой даты ограничение в силе (expires_at). Для дорожных важнее возраста новости. */
  until: string | null;
}
export interface ElevatedVolcano {
  name: string;
  acc: string; // yellow|orange|red
}
export interface SafetySnapshot {
  activeCount: number;
  maxSeverity: number;
  alerts: SafetyAlert[];
  volcanoes: ElevatedVolcano[];
  updatedAt: string | null;
  /**
   * Снимок получен со сбоем — цифрам верить нельзя.
   *
   * Раньше catch отдавал нули молча, и шапка главной писала «Спокойно» из
   * ничего: ноль предупреждений после упавшего запроса неотличим от нуля в
   * спокойный день. Тот же дефект чинили на /safety (#1090). Хуже того, он
   * мешал и разбору: 10.08 коды вулканов не дошли до главной, и понять — то ли
   * их нет, то ли запрос упал — было нельзя именно из-за этого молчания.
   */
  degraded?: boolean;
}
export interface ZonesSnapshot {
  /** Снимок получен со сбоем: «0 из 0 открыто» — это не обстановка. */
  degraded?: boolean;
  open: number;
  total: number;
  updatedAt: string | null;
}
export interface Plate {
  id: string;
  kind: string;
  title: string;
  description: string;
  imageUrl: string | null;
  priceFrom: number | null;
  category: string;
  locationType: string | null;
  volcanoStatus: string | null;
  /** operator_tours.price_unit; null — как в каталоге, за человека. */
  priceUnit: string | null;
  /** partners.name; null — имя не записано, и его не выдумываем. */
  operatorName: string | null;
  durationType: string | null;
  multiDayCount: number | null;
  durationHours: number | null;
  /** Дословно operator_tours.cancellation_policy; null — не записано. */
  cancellationPolicy: string | null;
  /** Исход по датам и сезону — тем же правилом, что карточка каталога. */
  availability: CatalogAvailability;
}
export interface FeedItem { text: string }
export interface Stat { value: string; label: string; href?: string }
export interface Element { key: string; label: string; count: number; href: string }
export interface Quake { magnitude: number; place: string; time: number; depth: number | null }
/**
 * Снимок сейсмики.
 *
 * `checkedAt` — когда мы В ПОСЛЕДНИЙ РАЗ спрашивали источник (прогон ingest
 * у КБГС, время запроса у USGS). Именно он годится в строку «обновлено»:
 * `updatedAt` — это момент сборки ответа, то есть всегда «только что», и
 * показывать его читателю значит обещать свежесть, которой мы не проверяли.
 */
export interface SeismicSnapshot { events: Quake[]; source: 'kbgsras' | 'usgs' | 'none'; updatedAt: string | null; checkedAt: string | null }

/** Один вулкан в «пульсе»: живая строка volcano_status, привязанная к месту. */
export interface VolcanoPulseItem {
  name: string;
  placeId: string;
  acc: string; // green|yellow|orange|red|unassigned
  ashHeightM: number | null;
  observedAt: string | null;
  summary: string | null;
}
/**
 * Пульс вулканов. Зелёные входят намеренно: пульс из одних повышенных
 * показывал бы пустоту в спокойный день, а пустота на слое безопасности
 * неотличима от «данные не дошли». Отсюда же `degraded`.
 */
export interface VolcanoSnapshot {
  items: VolcanoPulseItem[];
  /**
   * Когда КВЕРТ НАБЛЮДАЛ — самая свежая отметка `observed_at`.
   *
   * Это возраст самого факта, а не нашей осведомлённости о нём. В спокойный
   * период КВЕРТ неделю не выпускает новой сводки, и четыре дня здесь — не
   * поломка, а тишина на вулканах.
   */
  updatedAt: string | null;
  /**
   * Когда МЫ СПРАШИВАЛИ — самая свежая отметка `updated_at` (её ставит синк
   * на каждом прогоне, даже когда ничего не изменилось).
   *
   * Отдельным полем, потому что одна отметка на два разных факта — это уже
   * стоило нам разбора 07.09 (одна цифра на четыре источника). Владелец
   * 15.09 увидел на телефоне «КВЕРТ — обновлено 4 дн назад» и спросил, что
   * это значит. Ответа на экране не было: «источник молчит четвёртый день» и
   * «наш синк не работает четвёртый день» выглядели ОДИНАКОВО, а различать
   * их обязан именно safety-экран — под той же строкой стоит «Опасность:
   * Высокая». `null` — синк не отметился ни разу, и это тоже говорится.
   */
  checkedAt: string | null;
  degraded: boolean;
}

export type HazardLevel = 'critical' | 'danger' | 'warning';
export type HazardKind = 'volcano' | 'thermal' | 'quake' | 'bear' | 'fire' | 'report';
export interface Hazard {
  lat: number; lng: number;
  level: HazardLevel; kind: HazardKind;
  label: string; note: string;
}
export interface RadarSnapshot {
  hazards: Hazard[];
  center: { lat: number; lng: number; label: string };
  /**
   * Часть источников не ответила — на круге показано НЕ всё.
   *
   * Без этого флага пустой радар после упавшего запроса выглядит так же, как
   * пустой радар в спокойный день, и подпись «рядом нет» становится обещанием,
   * которого никто не давал.
   */
  degraded?: boolean;
}

export interface HomeV8Data {
  safety: SafetySnapshot;
  seismic: SeismicSnapshot;
  radar: RadarSnapshot;
  zones: ZonesSnapshot;
  plates: Plate[];
  feed: FeedItem[];
  stats: Stat[];
  elements: Element[];
  /**
   * Наличие линии у маршрутов для офлайн-карты (#1643). null — счётчик не
   * выполнился: главная скажет «не посчитано», а не нарисует зелёную точку.
   */
  geometry: RouteGeometryGap | null;
}

// Центр радара по умолчанию — Петропавловск-Камчатский (клиент заменит на геолокацию).
const PETROPAVLOVSK = { lat: 53.0444, lng: 158.6483, label: 'Петропавловск-Камчатский' };

const ACC_RANK: Record<string, number> = { red: 3, orange: 2, yellow: 1 };

async function fetchSafety(): Promise<SafetySnapshot> {
  try {
    const [alertsRes, volcRes, freshRes] = await Promise.all([
      query<{ title: string; description: string | null; alert_type: string | null; severity: number; created_at: string; expires_at: string | null }>(
        // Лента безопасности = только actionable-типы, меняющие решение
        // туриста сегодня (закрытия, вулканы, погода, стихии). Сам список —
        // lib/services/safety/feed-types: по нему же судит перепись
        // /api/cron/alerts-census, и своей копии здесь быть не должно —
        // разошлись бы, и перепись отвечала бы про другую ленту.
        // DISTINCT ON (заголовок) — ingest иногда заводит один алерт дважды
        // (RSS без дедупа); показываем по одной строке на тему, самую свежую.
        // description несёт важную деталь (объезд, окна проезда по пропускам).
        // expires_at — до какой даты ограничение в силе. Для дорожного закрытия
        // это и есть ответ туристу: не «новости 18 дней», а «действует до».
        `SELECT title, description, alert_type, severity, created_at::text, expires_at::text
           FROM (
             SELECT DISTINCT ON (lower(title))
                    title, description, alert_type, severity::int AS severity, created_at, expires_at
               FROM external_alerts
              WHERE expires_at > NOW()
                AND alert_type = ANY($1::text[])
              ORDER BY lower(title), severity DESC, created_at DESC
           ) t
          ORDER BY severity DESC, created_at DESC
          LIMIT ${HOME_ALERTS_LIMIT}`,
        [[...FEED_ALERT_TYPES]],
      ),
      query<{ name: string; acc: string }>(
        `SELECT p.name, vs.aviation_color_code AS acc
           FROM volcano_status vs
           JOIN places p ON vs.place_ark_id = p.ark_id
          WHERE vs.aviation_color_code IN ('yellow','orange','red')
            AND p.is_visible = TRUE
          LIMIT 12`,
      ),
      query<{ last_update: string | null }>(
        `SELECT MAX(updated_at)::text AS last_update FROM location_real_time_status`,
      ),
    ]);

    const alerts = alertsRes.rows.map((r) => ({
      title: r.title,
      description: r.description,
      type: r.alert_type,
      severity: r.severity ?? 0,
      at: r.created_at,
      until: r.expires_at,
    }));
    const volcanoes = volcRes.rows
      .map((r) => ({ name: r.name, acc: r.acc }))
      .sort((a, b) => (ACC_RANK[b.acc] ?? 0) - (ACC_RANK[a.acc] ?? 0));

    return {
      activeCount: alerts.length,
      maxSeverity: alerts.reduce((m, a) => Math.max(m, a.severity), 0),
      alerts,
      volcanoes,
      updatedAt: freshRes.rows[0]?.last_update ?? null,
    };
  } catch (err) {
    console.error('[home] fetchSafety failed:', err);
    return { activeCount: 0, maxSeverity: 0, alerts: [], volcanoes: [], updatedAt: null, degraded: true };
  }
}

async function fetchZones(): Promise<ZonesSnapshot> {
  try {
    const r = await query<{ open: string; total: string; last_update: string | null }>(
      `SELECT COUNT(*) FILTER (WHERE is_open IS TRUE)::text AS open,
              COUNT(*)::text                          AS total,
              MAX(updated_at)::text                   AS last_update
         FROM location_real_time_status`,
    );
    const row = r.rows[0];
    return {
      open: parseInt(row?.open ?? '0'),
      total: parseInt(row?.total ?? '0'),
      updatedAt: row?.last_update ?? null,
    };
  } catch (err) {
    console.error('[home] fetchZones failed:', err);
    return { open: 0, total: 0, updatedAt: null, degraded: true };
  }
}

/** Витрина туров — один источник для обоих деревьев главной (десктоп читает её в app/page.tsx, П8). */
export async function fetchPlates(): Promise<Plate[]> {
  // «Туры сезона» — РЕАЛЬНЫЕ туры операторов (operator_tours), а не
  // места/маршруты. Прежде тянули из agent_route_knowledge (места+маршруты,
  // туров там нет) и добивали маршрутами — на телефоне коммерция была спрятана.
  // Теперь только коммерция: опубликованные туры, сначала с фото. Нет туров →
  // пустой массив (блок честно не рисуется), никаких мест-заглушек.
  //
  // Аудит 24.09 (#39/#120/#122): карточка знала только цену. Теперь выборка
  // несёт то, что карточка обещает словами — имя оператора, длительность,
  // единицу цены и условия отмены (дословно из поля тура, решение владельца
  // 24.09 п.3), — и то, чем решается порядок: даты и сезон. Тур с кончившимся
  // сезоном не прячется, а уходит в конец — тем же правилом, что в каталоге
  // (lib/tours/catalog-availability), без своей копии порогов. LIMIT шире
  // витрины: сортировка по сезону идёт после выборки, и закрытый тур не
  // должен занимать место открытого.
  //
  // «Живой тур» и «даты есть» — не свои копии, а фрагменты каталога
  // (lib/search/tour-search: LIVE_TOUR_CONDITIONS, hasAvailabilitySql): та же
  // витрина, тот же ответ для того же тура. JOIN partners — как в каталоге и
  // его сводке: тур без оператора каталог не показывает, и главная не должна.
  try {
    const { rows } = await query<{
      id: string; title: string; description: string | null;
      image_url: string | null; base_price: string | null; activity_type: string | null;
      price_unit: string | null; operator_name: string | null;
      duration_hours: string | null; duration_type: string | null; multi_day_count: number | null;
      season_start: string | null; season_end: string | null;
      cancellation_policy: string | null; has_availability: boolean;
    }>(`
      SELECT ot.id::text, ot.title,
             COALESCE(NULLIF(ot.short_description, ''), LEFT(ot.description, 140)) AS description,
             COALESCE(ot.tour_image, (ot.photos)[1])                              AS image_url,
             ot.base_price::text,
             ot.activity_type,
             ot.price_unit,
             p.name AS operator_name,
             ot.duration_hours::text, ot.duration_type, ot.multi_day_count,
             ot.season_start::text, ot.season_end::text,
             NULLIF(btrim(ot.cancellation_policy), '') AS cancellation_policy,
             ${hasAvailabilitySql()} AS has_availability
        FROM operator_tours ot
        JOIN partners p ON ot.operator_id = p.id
       WHERE ${LIVE_TOUR_CONDITIONS.join(' AND ')}
       ORDER BY (ot.tour_image IS NOT NULL
                 OR (ot.photos IS NOT NULL AND array_length(ot.photos, 1) > 0)) DESC,
                ot.created_at DESC
       LIMIT 24
    `);
    const plates: Plate[] = rows.map((r) => {
      const multi = r.multi_day_count == null ? null : Number(r.multi_day_count);
      const hours = r.duration_hours == null ? null : Number(r.duration_hours);
      return {
        id: r.id,
        kind: 'tour',
        title: r.title,
        description: (r.description || '').slice(0, 140),
        imageUrl: r.image_url,
        priceFrom: r.base_price != null ? Number(r.base_price) : null,
        category: r.activity_type ?? 'tour',
        locationType: null,
        volcanoStatus: null,
        priceUnit: r.price_unit,
        operatorName: r.operator_name,
        durationType: r.duration_type,
        multiDayCount: multi,
        durationHours: hours,
        cancellationPolicy: r.cancellation_policy,
        availability: catalogAvailability({
          has_availability: r.has_availability,
          season_start: r.season_start,
          season_end: r.season_end,
          duration_type: r.duration_type,
          multi_day_count: multi,
          duration_hours: hours,
        }),
      };
    });
    // Порядок и потолок витрины — чистая функция (lib/home/plate-facts), со сторожем.
    return orderPlates(plates);
  } catch (err) {
    // Пустой массив — блок не рисуется, но отказ обязан быть виден в логе:
    // «туров нет» и «запрос упал» снаружи иначе неотличимы (§4.0).
    const e = err as { code?: string; message?: string } | undefined;
    console.error('[home] fetchPlates не выполнен', { sqlstate: e?.code, message: e?.message });
    return [];
  }
}

async function fetchFeed(): Promise<FeedItem[]> {
  try {
    const res = await query<{ tour_title: string; operator_name: string; created_at: string }>(
      `SELECT ot.title AS tour_title, p.name AS operator_name, ob.created_at::text
         FROM operator_bookings ob
         JOIN operator_tours ot ON ob.operator_tour_id = ot.id
         JOIN partners p ON ot.operator_id = p.id
        WHERE ob.booking_status IN ('confirmed','new')
          AND ob.created_at > NOW() - '72 hours'::interval
        ORDER BY ob.created_at DESC
        LIMIT 6`,
    );
    return res.rows.map((r) => ({
      text: `Заявка на «${r.tour_title}» · ${r.operator_name}`,
    }));
  } catch {
    return [];
  }
}

// «В цифрах» и «Стихии» — из ЕДИНОГО источника (lib/stats/platform-counts),
// того же, что кормит StatsBand и /routes-листинг. Чистые деривации.
// Подписи склоняются по числу («5 маршрутов», «421 локация», «1 маршрут»),
// а не стоят одной формой на все числа; «рег. МЧС» и «SAR» раскрыты словами —
// прогулка 10.09 (#1780) не смогла понять, что это.
function deriveStats(counts: PlatformCounts): Stat[] {
  return [
    { value: counts.routes.toLocaleString('ru-RU'),     label: plural(counts.routes, 'маршрут', 'маршрута', 'маршрутов'), href: '/routes' },
    { value: counts.places.toLocaleString('ru-RU'),     label: plural(counts.places, 'локация', 'локации', 'локаций'),  href: '/routes?kind=place' },
    { value: counts.mchsRoutes.toLocaleString('ru-RU'), label: `${plural(counts.mchsRoutes, 'маршрут', 'маршрута', 'маршрутов')} с регистрацией МЧС` },
    { value: '24/7', label: 'мониторинг угроз' },
  ];
}

function deriveElements(counts: PlatformCounts): Element[] {
  return groupPlacesByElement(counts.placesByType).elements;
}

function seismicSnapshot(
  events: SeismicEvent[],
  source: SeismicSnapshot['source'],
  updatedAt: string,
  checkedAt: string | null,
): SeismicSnapshot {
  const list: Quake[] = events
    .filter((e) => Number.isFinite(e.magnitude) && e.magnitude > 0)
    .slice(0, 14) // для «пульса» нужно больше событий, чем для списка
    .map((e) => ({ magnitude: e.magnitude, place: e.place, time: e.time, depth: e.depth }));
  return { events: list, source, updatedAt, checkedAt };
}

function quakeLevel(m: number): HazardLevel {
  return m >= 5 ? 'critical' : m >= 4 ? 'danger' : 'warning';
}

// Радар — только ОСТРЫЕ, настоящие опасности: активные вулканы (KVERT).
// Сейсмика добавляется отдельно (события с координатами). Термальные источники
// и гейзеры НЕ помечаем опасностью: большинство — купальные/тёплые, это
// достопримечательность, а не угроза; блиц «до 95°C» на каждом источнике — и
// неправда, и «крик волка», обесценивающий настоящую опасность (trust-first).
// Температурная осторожность источника — контекст на карточке места, не радар.
async function fetchRadarBase(): Promise<{ hazards: Hazard[]; degraded: boolean }> {
  const hazards: Hazard[] = [];
  let degraded = false;
  try {
    // ── Вулканы по ДВУМ шкалам (решение владельца 24.09) ────────────────────
    //
    // До этой правки радар знал вулкан только по коду KVERT — авиационному,
    // про пепел для самолётов. 22.09 Мутновский и Горелый стояли жёлтыми по
    // шкале КФ ЕГС (сейсмичность выше фона: 255 и 221 событие за сутки), а
    // KVERT держал их зелёными — и на радаре их не было вовсе. Шкалы разные,
    // победителя нет: метка ставится, если вулкан повышен хотя бы по одной,
    // и в подписи стоят обе. Сборка — lib/services/safety/volcano-scales.
    const kvertRows = await query<{ ark: string; acc: string }>(
      `SELECT place_ark_id::text AS ark, aviation_color_code AS acc
         FROM volcano_status
        WHERE place_ark_id IS NOT NULL`,
    );
    const kvert = new Map(kvertRows.rows.map((r) => [r.ark, r.acc]));

    // Вторая шкала — своим try: её отказ (таблицы ещё нет, сводка не пришла)
    // не должен гасить первую. Нет свежей сводки — на круге показано не всё,
    // и это `degraded`, а не молчаливое «вулканы спокойны».
    const kfegs = new Map<string, KfegsReading>();
    try {
      const latest = await query<{ d: string | null }>(
        `SELECT MAX(observed_date)::text AS d FROM volcano_bulletin_kfegs`,
      );
      const d = latest.rows[0]?.d ?? null;
      if (!d || !kfegsIsFresh(d)) {
        degraded = true;
      } else {
        const b = await query<{ ark: string | null; color: ScaleColor | null; raw: string; seismicity: string | null }>(
          `SELECT place_ark_id::text AS ark, color, color_raw AS raw, seismicity
             FROM volcano_bulletin_kfegs
            WHERE observed_date = $1::date`,
          [d],
        );
        for (const r of b.rows) {
          if (r.ark) {
            kfegs.set(r.ark, { color: r.color, raw: r.raw, seismicity: r.seismicity, date: d });
          } else if (r.color && r.color !== 'green') {
            // Повышенный вулкан без места в каталоге — метку ставить некуда.
            // Это «показано не всё», а не «рядом чисто».
            degraded = true;
          }
        }
      }
    } catch (err) {
      console.error('[home] радар: сводка КФ ЕГС не выбралась:', err);
      degraded = true;
    }

    const ids = [...new Set([...kvert.keys(), ...kfegs.keys()])];
    const placeRows = ids.length === 0 ? { rows: [] as Array<{ ark: string; name: string; lat: string; lng: string }> } :
      await query<{ ark: string; name: string; lat: string; lng: string }>(
        `SELECT ark_id::text AS ark, name, lat::text, lng::text
           FROM places
          WHERE ark_id = ANY($1::uuid[])
            AND is_visible = TRUE AND lat IS NOT NULL AND lng IS NOT NULL`,
        [ids],
      );
    const places = new Map(placeRows.rows.map((r) => [r.ark, { name: r.name, lat: parseFloat(r.lat), lng: parseFloat(r.lng) }]));
    for (const m of volcanoMarks(kvert, kfegs, places)) {
      hazards.push({ ...m, kind: 'volcano' });
    }
    // Опасный код БЕЗ привязки к точке — знание, которое некуда положить.
    //
    // 02.09: KVERT отдавал 68 вулканов, сопоставлялось 8. Ключевской с
    // выбросом до 6 км лежал в volcano_status без place_ark_id, а радар
    // соединяет статус с местом именно через него — и показывал пустой круг
    // под надписью «обновляется автоматически».
    //
    // Сопоставление починено (lib/services/safety/volcano-match), но одной
    // починки мало: если завтра KVERT назовёт новый вулкан, которого нет в
    // каталоге, круг снова промолчит. Поэтому непривязанный опасный код —
    // это `degraded`: «показано не всё», а не «рядом чисто».
    try {
      const orphan = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM volcano_status
          WHERE aviation_color_code IN ('yellow','orange','red')
            AND place_ark_id IS NULL`,
      );
      if (Number(orphan.rows[0]?.n ?? 0) > 0) degraded = true;
    } catch (err) {
      // Не смогли сосчитать непривязанные — значит не знаем, полон ли круг.
      console.error('[home] радар: непривязанные коды не сосчитались:', err);
      degraded = true;
    }
  } catch (err) {
    console.error('[home] радар: вулканы не выбрались:', err);
    degraded = true;
  }

  // Всё остальное, у чего есть координаты: сейсмособытия и предупреждения
  // источников. Раньше радар знал ТОЛЬКО volcano_status, а подпись под ним
  // обещала «сейсмики и тревог вулканов рядом нет» — то есть говорила за два
  // источника, зная один.
  //
  // Полевой случай 10.08: у владельца в 70 км Мутновский с активным
  // предупреждением МЧС («сохраняется риск схода оползней, не приближаться»),
  // а радар показывал пустой круг. Формально честно — код KVERT у Мутновского
  // зелёный, извержения нет, опасность другого рода. Но человек читает не про
  // источники, он читает «рядом чисто», и пустой круг на первом экране раздела
  // безопасности звучит как разрешение идти.
  try {
    const alerts = await query<{
      title: string; description: string | null; alert_type: string | null;
      severity: number | null; lat: string; lng: string; magnitude: string | null;
    }>(
      `SELECT title, description, alert_type, severity::int AS severity,
              lat::text, lng::text, magnitude::text
         FROM external_alerts
        WHERE expires_at > NOW()
          AND lat IS NOT NULL AND lng IS NOT NULL
        ORDER BY severity DESC NULLS LAST, created_at DESC
        LIMIT 60`,
    );
    for (const a of alerts.rows) {
      const lat = parseFloat(a.lat), lng = parseFloat(a.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const type = (a.alert_type ?? '').toLowerCase();
      const mag = a.magnitude ? parseFloat(a.magnitude) : NaN;
      // 'fire' — своя ветка (03.09, владелец: «на радаре есть пожары, отметь
      // другим значком»). До этой правки термоточки NASA FIRMS (реальные
      // координаты, не декларация) падали в общий 'report' — тот же вид, что
      // у медведя, погоды и камнепада, — и различить пожар среди них на
      // радаре можно было только тапом. alert_type у них 'fire_danger'
      // (wildfire-firms.ts и МЧС-классы в seismic-parser.ts).
      const kind: HazardKind = /volcan|ash/.test(type) ? 'volcano'
        : /quake|seismic|earth/.test(type) ? 'quake'
        : /fire/.test(type) ? 'fire'
        : 'report';
      // Магнитуда — точнее декларированной важности там, где она есть.
      const level: HazardLevel = Number.isFinite(mag) ? quakeLevel(mag)
        : (a.severity ?? 0) >= 3 ? 'critical'
        : (a.severity ?? 0) >= 2 ? 'danger'
        : 'warning';
      hazards.push({
        lat, lng, level, kind,
        label: a.title,
        note: a.description?.slice(0, 200) ?? a.title,
      });
    }
  } catch (err) {
    console.error('[home] радар: предупреждения не выбрались:', err);
    degraded = true;
  }

  return { hazards, degraded };
}

const ACC_LABEL_SHORT: Record<string, string> = { red: 'красный', orange: 'оранжевый', yellow: 'жёлтый' };

const REPORT_HAZARD_LABEL: Record<string, string> = {
  bear: 'Медведь', rockfall: 'Камнепад', weather: 'Опасная погода', other: 'Наблюдение',
};

// Наблюдения туристов на радаре. API /api/safety/reports при отправке обещает
// «появится в радаре после модерации» — здесь это обещание выполняется.
// Только approved (ручная модерация владельцем) и только свежие: медведь,
// замеченный неделю назад, — уже не точка на радаре, а свойство района.
//
// Окно и предикат — из lib/safety/bear-sightings: с 19.09 те же строки судят
// медвежьи зоны геофенса (#1957). Две копии семёрки разошлись бы молча, и
// карта с полевым предупреждением говорили бы о разной Камчатке.
async function fetchReportHazards(): Promise<Hazard[]> {
  try {
    const res = await query<{ report_type: string; text: string; lat: number; lng: number; hours_ago: number }>(
      `SELECT report_type, text, lat, lng,
              EXTRACT(EPOCH FROM (NOW() - created_at))::float8 / 3600 AS hours_ago
         FROM trail_reports
        WHERE lat IS NOT NULL AND lng IS NOT NULL
          AND ${FRESH_APPROVED_SQL}
        ORDER BY created_at DESC
        LIMIT 12`,
      [SIGHTING_WINDOW_DAYS],
    );
    return res.rows.map((r) => {
      const ago = sightingAgeLabel(r.hours_ago);
      return {
        lat: r.lat, lng: r.lng,
        level: (r.report_type === 'bear' ? 'danger' : 'warning') as HazardLevel,
        kind: (r.report_type === 'bear' ? 'bear' : 'report') as HazardKind,
        label: REPORT_HAZARD_LABEL[r.report_type] ?? 'Наблюдение',
        note: `${r.text.slice(0, 90)} · ${ago} · наблюдение туриста, прошло модерацию.`,
      };
    });
  } catch (e) {
    // Пустой радар читается как «на полуострове спокойно». Отказ, который
    // молчит, превращает поломку в отсутствие опасностей — дословно случай
    // 19.08 из §4.0 (панель тревог, пустая при падающих запросах).
    const why = e instanceof Error ? e.message : String(e);
    const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : '—';
    console.error('[home-radar] наблюдения туристов не загружены:', code, why);
    return [];
  }
}

/**
 * Живая обстановка (радар + алерты + сейсмика) отдельным срезом: после P0-3b
 * её рендерит страница /safety, а главная показывает только пилюлю статуса и
 * плитку-ссылку. Один построитель на обоих потребителей — данные не двоятся.
 */
export interface SafetyLiveData {
  safety: SafetySnapshot;
  seismic: SeismicSnapshot;
  radar: RadarSnapshot;
  volcanoes: VolcanoSnapshot;
}

/**
 * «Пульс вулканов» — как сейсмический, но по кодам KVERT (владелец 02.09:
 * «нужен график вулканов как у сейсмики»). Истории кодов в volcano_status
 * нет — одна строка на вулкан, — поэтому ось не время, а активность:
 * столбик на каждый вулкан, привязанный к месту, высота и цвет по коду.
 * Берутся ВСЕ коды, включая зелёные: пульс из одних повышенных в спокойный
 * день показывал бы пустоту, а пустота здесь неотличима от «не дошло».
 */
async function fetchVolcanoPulse(): Promise<VolcanoSnapshot> {
  try {
    const { rows } = await query<{
      name: string; place_id: string; acc: string; ash: number | null;
      observed_at: string | null; checked_at: string | null; summary: string | null;
    }>(
      `SELECT p.name, p.id::text AS place_id, vs.aviation_color_code AS acc,
              vs.ash_height_m AS ash, vs.observed_at::text AS observed_at,
              -- Когда синк последний раз отметился по ЭТОЙ записи. Отдельно от
              -- observed_at: первое — время нашего опроса, второе — время
              -- наблюдения КВЕРТ, и путать их на safety-экране нельзя.
              vs.updated_at::text AS checked_at,
              LEFT(vs.summary, 300) AS summary
         FROM volcano_status vs
         JOIN places p ON vs.place_ark_id = p.ark_id
        WHERE p.is_visible = TRUE
          AND vs.aviation_color_code <> 'unassigned'
        ORDER BY vs.observed_at DESC NULLS LAST
        LIMIT 24`,
    );
    const items: VolcanoPulseItem[] = rows.map((r) => ({
      name: r.name, placeId: r.place_id, acc: r.acc,
      ashHeightM: r.ash, observedAt: r.observed_at, summary: r.summary,
    }));
    const updatedAt = rows.reduce<string | null>(
      (m, r) => (r.observed_at && (!m || r.observed_at > m) ? r.observed_at : m), null,
    );
    const checkedAt = rows.reduce<string | null>(
      (m, r) => (r.checked_at && (!m || r.checked_at > m) ? r.checked_at : m), null,
    );
    return { items, updatedAt, checkedAt, degraded: false };
  } catch (err) {
    console.error('[home] пульс вулканов не выбрался:', err);
    return { items: [], updatedAt: null, checkedAt: null, degraded: true };
  }
}

export async function getSafetyLiveData(): Promise<SafetyLiveData> {
  const [safety, feedResult, radarBase, reportHazards, volcanoes] = await Promise.all([
    fetchSafety(),
    // `checkedAt: null` в откате — «не знаем, когда спрашивали»: лента не
    // ответила вовсе, и ставить сюда время сборки значило бы обещать проверку,
    // которой не было.
    getSeismicFeed().catch(() => ({
      events: [] as SeismicEvent[], source: 'none' as const,
      updatedAt: new Date().toISOString(), checkedAt: null,
    })),
    fetchRadarBase(),
    fetchReportHazards(),
    fetchVolcanoPulse(),
  ]);

  const seismic = seismicSnapshot(feedResult.events, feedResult.source, feedResult.updatedAt, feedResult.checkedAt);

  const quakeHazards: Hazard[] = feedResult.events
    .filter((e) => e.lat != null && e.lng != null && Number.isFinite(e.magnitude) && e.magnitude > 0)
    .slice(0, 8)
    .map((e) => ({
      lat: e.lat as number, lng: e.lng as number,
      level: quakeLevel(e.magnitude), kind: 'quake' as const,
      label: `M${e.magnitude.toFixed(1)} · ${e.place}`,
      note: `Землетрясение${e.depth != null ? `, глубина ${Math.round(e.depth)} км` : ''}.`,
    }));

  // Дубли по координате: одно и то же событие приходит и предупреждением с
  // координатами, и строкой сейсмофида. Ключ — округлённая точка плюс вид: без
  // этого на круге появлялись бы две метки в одном месте.
  const seen = new Set<string>();
  const hazards = [...radarBase.hazards, ...quakeHazards, ...reportHazards].filter((h) => {
    const key = `${h.kind}:${h.lat.toFixed(3)}:${h.lng.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const radar: RadarSnapshot = { hazards, center: PETROPAVLOVSK, degraded: radarBase.degraded };
  return { safety, seismic, radar, volcanoes };
}

export async function getHomeV8Data(): Promise<HomeV8Data> {
  const [live, zones, plates, feedItems, counts, geometry] = await Promise.all([
    getSafetyLiveData(),
    fetchZones(), fetchPlates(), fetchFeed(),
    getPlatformCounts().catch(() => null),
    // Сам пишет в лог и отдаёт null при отказе — своего catch здесь не нужно.
    countRoutesWithoutGeometry(),
  ]);

  const stats: Stat[] = counts ? deriveStats(counts) : [{ value: '24/7', label: 'мониторинг угроз' }];
  const elements: Element[] = counts ? deriveElements(counts) : [];

  return { ...live, zones, plates, feed: feedItems, stats, elements, geometry };
}
