/**
 * Серверный data-слой Главной v8 «Воронка».
 * Все блоки, что выглядят как приборы, тянут РЕАЛЬНЫЕ данные — иначе блока нет.
 * Источники подтверждены по коду:
 *   - external_alerts        → лента безопасности (severity/title/type/expires)
 *   - volcano_status (KVERT) → ACC-статус вулканов (aviation_color_code)
 *   - location_real_time_status → открыто/закрыто зон + свежесть
 *   - operator_tours         → платы «Подходит вам сейчас» (реальные туры: фото, цена)
 *   - operator_bookings …    → живой журнал
 *   - places counts          → «Стихии» и «В цифрах»
 * Каждая выборка в своём try/catch: сбой одного блока не роняет страницу.
 */

import { query } from '@/lib/database';
import { getSeismicFeed, type SeismicEvent } from '@/lib/services/safety/seismic-feed';
import { getPlatformCounts, type PlatformCounts } from '@/lib/stats/platform-counts';
import { groupPlacesByElement } from '@/lib/stats/element-groups';

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
}
export interface FeedItem { text: string }
export interface Stat { value: string; label: string; href?: string }
export interface Element { key: string; label: string; count: number; href: string }
export interface Quake { magnitude: number; place: string; time: number; depth: number | null }
export interface SeismicSnapshot { events: Quake[]; source: 'kbgsras' | 'usgs' | 'none'; updatedAt: string | null }

export type HazardLevel = 'critical' | 'danger' | 'warning';
export type HazardKind = 'volcano' | 'thermal' | 'quake' | 'bear' | 'report';
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
}

// Центр радара по умолчанию — Петропавловск-Камчатский (клиент заменит на геолокацию).
const PETROPAVLOVSK = { lat: 53.0444, lng: 158.6483, label: 'Петропавловск-Камчатский' };

const ACC_RANK: Record<string, number> = { red: 3, orange: 2, yellow: 1 };

async function fetchSafety(): Promise<SafetySnapshot> {
  try {
    const [alertsRes, volcRes, freshRes] = await Promise.all([
      query<{ title: string; description: string | null; alert_type: string | null; severity: number; created_at: string; expires_at: string | null }>(
        // Лента безопасности = только actionable-типы, меняющие решение
        // туриста сегодня (закрытия, вулканы, погода, стихии). Общие новости
        // (статистика пожаров, пресс-релизы МЧС) в external_alerts не пускаем —
        // им место в новостном блоке, не в сводке безопасности. Землетрясения
        // тоже вне ленты: они отдельным блоком «Пульс полуострова».
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
                AND alert_type IN (
                  'road_closure', 'volcano', 'volcanic_eruption', 'ash_cloud',
                  'tsunami_warning', 'flood', 'avalanche', 'landslide', 'weather'
                )
              ORDER BY lower(title), severity DESC, created_at DESC
           ) t
          ORDER BY severity DESC, created_at DESC
          LIMIT 5`,
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

async function fetchPlates(): Promise<Plate[]> {
  // «Подходит вам сейчас» — РЕАЛЬНЫЕ туры операторов (operator_tours), а не
  // места/маршруты. Прежде тянули из agent_route_knowledge (места+маршруты,
  // туров там нет) и добивали маршрутами — на телефоне коммерция была спрятана.
  // Теперь только коммерция: опубликованные туры, сначала с фото. Нет туров →
  // пустой массив (блок честно не рисуется), никаких мест-заглушек.
  try {
    const { rows } = await query<{
      id: string; title: string; description: string | null;
      image_url: string | null; base_price: string | null; activity_type: string | null;
    }>(`
      SELECT ot.id::text, ot.title,
             COALESCE(NULLIF(ot.short_description, ''), LEFT(ot.description, 140)) AS description,
             COALESCE(ot.tour_image, (ot.photos)[1])                              AS image_url,
             ot.base_price::text,
             ot.activity_type
        FROM operator_tours ot
       WHERE ot.is_active = true AND ot.is_published = true AND ot.deleted_at IS NULL
       ORDER BY (ot.tour_image IS NOT NULL
                 OR (ot.photos IS NOT NULL AND array_length(ot.photos, 1) > 0)) DESC,
                ot.created_at DESC
       LIMIT 8
    `);
    return rows.map((r) => ({
      id: r.id,
      kind: 'tour',
      title: r.title,
      description: (r.description || '').slice(0, 140),
      imageUrl: r.image_url,
      priceFrom: r.base_price != null ? Number(r.base_price) : null,
      category: r.activity_type ?? 'tour',
      locationType: null,
      volcanoStatus: null,
    }));
  } catch {
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
function deriveStats(counts: PlatformCounts): Stat[] {
  return [
    { value: counts.routes.toLocaleString('ru-RU'),     label: 'маршрута', href: '/routes' },
    { value: counts.places.toLocaleString('ru-RU'),     label: 'локация',  href: '/routes?kind=place' },
    { value: counts.mchsRoutes.toLocaleString('ru-RU'), label: 'рег. МЧС' },
    { value: '24/7', label: 'SAR' },
  ];
}

function deriveElements(counts: PlatformCounts): Element[] {
  return groupPlacesByElement(counts.placesByType).elements;
}

function seismicSnapshot(events: SeismicEvent[], source: SeismicSnapshot['source'], updatedAt: string): SeismicSnapshot {
  const list: Quake[] = events
    .filter((e) => Number.isFinite(e.magnitude) && e.magnitude > 0)
    .slice(0, 14) // для «пульса» нужно больше событий, чем для списка
    .map((e) => ({ magnitude: e.magnitude, place: e.place, time: e.time, depth: e.depth }));
  return { events: list, source, updatedAt };
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
    const volc = await query<{ name: string; lat: string; lng: string; acc: string }>(
      `SELECT p.name, p.lat::text, p.lng::text, vs.aviation_color_code AS acc
         FROM places p JOIN volcano_status vs ON vs.place_ark_id = p.ark_id
        WHERE vs.aviation_color_code IN ('yellow','orange','red')
          AND p.is_visible = TRUE AND p.lat IS NOT NULL AND p.lng IS NOT NULL`,
    );
    for (const v of volc.rows) {
      hazards.push({
        lat: parseFloat(v.lat), lng: parseFloat(v.lng),
        level: v.acc === 'yellow' ? 'danger' : 'critical',
        kind: 'volcano', label: v.name,
        note: `Вулкан, KVERT ${ACC_LABEL_SHORT[v.acc] ?? v.acc}. Держитесь вне закрытой зоны.`,
      });
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
      const kind: HazardKind = /volcan|ash/.test(type) ? 'volcano'
        : /quake|seismic|earth/.test(type) ? 'quake'
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
async function fetchReportHazards(): Promise<Hazard[]> {
  try {
    const res = await query<{ report_type: string; text: string; lat: number; lng: number; hours_ago: number }>(
      `SELECT report_type, text, lat, lng,
              EXTRACT(EPOCH FROM (NOW() - created_at))::float8 / 3600 AS hours_ago
         FROM trail_reports
        WHERE status = 'approved' AND lat IS NOT NULL AND lng IS NOT NULL
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC
        LIMIT 12`,
    );
    return res.rows.map((r) => {
      const ago = r.hours_ago < 24
        ? `${Math.max(1, Math.round(r.hours_ago))} ч назад`
        : `${Math.round(r.hours_ago / 24)} дн назад`;
      return {
        lat: r.lat, lng: r.lng,
        level: (r.report_type === 'bear' ? 'danger' : 'warning') as HazardLevel,
        kind: (r.report_type === 'bear' ? 'bear' : 'report') as HazardKind,
        label: REPORT_HAZARD_LABEL[r.report_type] ?? 'Наблюдение',
        note: `${r.text.slice(0, 90)} · ${ago} · наблюдение туриста, прошло модерацию.`,
      };
    });
  } catch { return []; }
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
}

export async function getSafetyLiveData(): Promise<SafetyLiveData> {
  const [safety, feedResult, radarBase, reportHazards] = await Promise.all([
    fetchSafety(),
    getSeismicFeed().catch(() => ({ events: [] as SeismicEvent[], source: 'none' as const, updatedAt: new Date().toISOString() })),
    fetchRadarBase(),
    fetchReportHazards(),
  ]);

  const seismic = seismicSnapshot(feedResult.events, feedResult.source, feedResult.updatedAt);

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
  return { safety, seismic, radar };
}

export async function getHomeV8Data(): Promise<HomeV8Data> {
  const [live, zones, plates, feedItems, counts] = await Promise.all([
    getSafetyLiveData(),
    fetchZones(), fetchPlates(), fetchFeed(),
    getPlatformCounts().catch(() => null),
  ]);

  const stats: Stat[] = counts ? deriveStats(counts) : [{ value: '24/7', label: 'SAR' }];
  const elements: Element[] = counts ? deriveElements(counts) : [];

  return { ...live, zones, plates, feed: feedItems, stats, elements };
}
