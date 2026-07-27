/**
 * Seismic Parser — парсит данные КБГС РАН из публичных каналов
 * Источники: t.me/s/kbgsras, t.me/s/eqkam
 *
 * Формат external_alerts:
 *   alert_type: 'volcanic_eruption' | 'earthquake' | 'seismic_bulletin' | 'ash_cloud'
 *   severity:   0=info, 1=warning, 2=critical, 3=emergency
 *   affected_zones: ['avachinsky','northern','eastern','western']
 */

import { query } from '@/lib/database';

// ── Типы ─────────────────────────────────────────────────────────────────

export interface SeismicEvent {
  source_id: string;        // t.me/kbgsras/6680
  source_url: string;
  published_at: Date;
  alert_type: 'volcanic_eruption' | 'earthquake' | 'seismic_bulletin' | 'ash_cloud' | 'info' | 'tsunami_warning' | 'flood' | 'fire_danger' | 'road_closure';
  severity: 0 | 1 | 2 | 3;
  title: string;
  description: string;
  affected_zones: string[];
  // Для землетрясений
  magnitude?: number;
  depth_km?: number;
  epicenter?: string;
  lat?: number;
  lng?: number;
  // Для вулканов
  volcano_name?: string;
  ash_height_m?: number;
  ash_direction?: string;
  expires_hours: number;
}

export interface ParseResult {
  events: SeismicEvent[];
  inserted: number;
  skipped: number;
  errors: string[];
  /**
   * Сколько СЫРЫХ постов дал источник до классификации (для сторожа здоровья
   * источников: канал жив, если прислал хоть что-то, даже если ни один пост не
   * оказался угрозой). Заполняют VK/MAX; у остальных может быть undefined.
   */
  rawItems?: number;
}

// ── Карта вулканов → зоны Камчатки ───────────────────────────────────────

const VOLCANO_ZONES: Record<string, string[]> = {
  'шивелуч':    ['northern'],
  'ключевской': ['northern'],
  'безымянный': ['northern'],
  'камень':     ['northern'],
  'толбачик':   ['northern'],
  'авачинский': ['avachinsky'],
  'корякский':  ['avachinsky'],
  'козельский': ['avachinsky'],
  'мутновский': ['avachinsky'],
  'горелый':    ['avachinsky'],
  'вилючинский':['avachinsky'],
  'карымский':  ['eastern'],
  'малый семячик': ['eastern'],
  'кроноцкий':  ['eastern'],
  'узон':       ['eastern'],
  'жупановский':['eastern'],
  'ичинский':   ['western'],
  'алаид':      ['northern'],
  'эбеко':      ['northern'],
};

// ── Парсер Telegram-канала ────────────────────────────────────────────────

async function fetchTelegramChannel(channel: string): Promise<string> {
  const url = `https://t.me/s/${channel}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KamchatourBot/1.0)',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractMessages(html: string): Array<{ id: string; text: string; datetime: string }> {
  const messages: Array<{ id: string; text: string; datetime: string }> = [];

  // Извлекаем блоки сообщений
  const msgRegex = /<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  const textRegex = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;
  const dateRegex = /href="https:\/\/t\.me\/([^/]+)\/(\d+)"[^>]*><time[^>]+datetime="([^"]+)"/;

  const html2 = html;
  // Ищем все message_date для ID и времени
  const allDates = [...html.matchAll(/href="https:\/\/t\.me\/([^/]+)\/(\d+)"[^>]*><time[^>]+datetime="([^"]+)"/g)];
  const allTexts = [...html.matchAll(/class="tgme_widget_message_text js-message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<a class)/g)];

  for (let i = 0; i < Math.min(allDates.length, 50); i++) {
    const dateMatch = allDates[i];
    const textMatch = allTexts[i];

    if (!dateMatch || !textMatch) continue;

    const channel = dateMatch[1];
    const msgId   = dateMatch[2];
    const datetime = dateMatch[3];
    const rawHtml  = textMatch[1];

    // Стрипаем HTML теги
    const text = rawHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#33;/g, '!')
      .trim();

    if (!text || text.length < 20) continue;

    messages.push({
      id: `t.me/${channel}/${msgId}`,
      text,
      datetime,
    });
  }

  return messages;
}

// ── Дорожные ограничения ──────────────────────────────────────────────────
// Закрытие проезда / пропускной режим / перекрытие дорог к туристическим
// местам. Категория появилась после пропущенной новости о пропусках к
// Вилючинскому перевалу и закрытии проезда к Вачкажцу (июль 2026): все
// прежние категории были природными, дорожные ограничения отбрасывались.
// Последняя альтернатива ловит естественный русский порядок «глагол→предмет»
// («Временно ограничено движение...» из суточной сводки ГУ МЧС в ВК/МАХ) —
// прежний паттерн требовал «предмет→глагол» и такую формулировку пропускал.

const ROAD_RESTRICTION_RE =
  /закрыт[а-яё]*\s+(?:проезд|дорог|движени)|(?:проезд|движени|дорог|доступ)[а-яё]*[\s\S]{0,120}?(?:закрыт|ограничен|перекрыт)|проезд[а-яё]*[\s\S]{0,120}?по\s+пропуск|пропускн[а-яё]+\s+режим|перекрыт[а-яё]*\s+(?:дорог|проезд|движени)|(?:ограничен|закрыт|перекрыт)[а-яё]*\s+(?:проезд|движени)/i;

export function detectRoadRestriction(text: string): { severity: 1 | 2 } | null {
  if (!ROAD_RESTRICTION_RE.test(text)) return null;
  // Полное закрытие — красный уровень, ограничение/пропуска — жёлтый
  const severity: 1 | 2 = /закрыт|перекрыт/i.test(text) ? 2 : 1;
  return { severity };
}

// ── Классификатор событий ─────────────────────────────────────────────────

function classifyMessage(id: string, text: string, datetime: string): SeismicEvent | null {
  const t = text.toLowerCase();
  const publishedAt = new Date(datetime);

  // ── Вулканический выброс ───────────────────────────────────────────────

  const eruptionPatterns = [
    /(?:на )?вулкан[е]?\s+([\wА-Яа-яЁё-]+).*(?:пепловый выброс|пепловое облако|извержение)/i,
    /(?:пепловый выброс|извержение).*вулкан[а]?\s+([\wА-Яа-яЁё-]+)/i,
    /вулкан\s+([\wА-Яа-яЁё-]+)\s*\.?\s*\d/i,
  ];

  for (const pattern of eruptionPatterns) {
    const match = text.match(pattern);
    if (match) {
      const volcanoRaw = match[1].toLowerCase().trim();
      const volcanoName = volcanoRaw.charAt(0).toUpperCase() + volcanoRaw.slice(1);

      // Высота пепла
      const heightMatch = text.match(/(\d[\d\s]*)\s*м\s*над\s+уровнем\s+моря/i);
      const ashHeightM = heightMatch ? parseInt(heightMatch[1].replace(/\s/g, '')) : undefined;

      // Направление пепла
      const dirMatch = text.match(/(?:ушло|пепловое облако)[^.]*?(северо-[а-яё]+|юго-[а-яё]+|северо[а-яё]+|юго[а-яё]+|север|юг|восток|запад)/i);
      const ashDirection = dirMatch ? dirMatch[1] : undefined;

      const zones = VOLCANO_ZONES[volcanoRaw] ?? ['avachinsky'];
      const severity: 0 | 1 | 2 | 3 = ashHeightM !== undefined
        ? ashHeightM >= 10000 ? 3
          : ashHeightM >= 7000 ? 2
          : ashHeightM >= 4000 ? 1 : 0
        : 1;

      return {
        source_id: id,
        source_url: `https://${id}`,
        published_at: publishedAt,
        alert_type: 'volcanic_eruption',
        severity,
        title: `Извержение вулкана ${volcanoName}${ashHeightM ? ` — высота ${(ashHeightM / 1000).toFixed(1)} км` : ''}`,
        description: text.slice(0, 600),
        affected_zones: zones,
        volcano_name: volcanoName,
        ash_height_m: ashHeightM,
        ash_direction: ashDirection,
        expires_hours: severity >= 2 ? 48 : 24,
      };
    }
  }

  // ── Официальное предупреждение о цунами ──────────────────────────────
  // КБГС публикует "Угроза цунами объявлена" / "Отбой цунами-угрозы"
  // Проверяется ДО парсинга магнитуды — официальный статус важнее порога M6+.
  // Реальный случай: M5.8 + M5.3 → официальное предупреждение МЧС/112 → цунами-угроза.

  if (/угроза\s+цунами|предупреждение\s+о\s+цунами|tsunami\s+warning|цунами\s+объявлен/i.test(t)) {
    const isAllClear = /отбой|снята\s+угроза|all\s+clear/i.test(t);
    return {
      source_id: id,
      source_url: `https://${id}`,
      published_at: publishedAt,
      alert_type: isAllClear ? 'info' : 'tsunami_warning',
      severity: isAllClear ? 0 : 3,
      title: isAllClear
        ? 'Отбой угрозы цунами — Камчатка'
        : 'УГРОЗА ЦУНАМИ — официальное предупреждение КБГС',
      description: text.slice(0, 600),
      affected_zones: ['avachinsky', 'eastern', 'western', 'northern'],
      expires_hours: isAllClear ? 1 : 48,
    };
  }

  // ── Землетрясение ─────────────────────────────────────────────────────

  const eqPatterns = [
    /землетрясение[^.]*(?:с\s+)?(?:максимальной\s+)?магнитуд[оуы][йей]?\s*(?:ML\s*[=]?\s*|M\s*[=]?\s*|MW\s*=\s*)?(\d+\.?\d*)/i,
    /ML\s*=?\s*(\d+\.?\d*)/i,
    /MW\s*=?\s*(\d+\.?\d*)/i,
    /M\s*=?\s*(\d+\.?\d*)\s/i,
  ];

  for (const pattern of eqPatterns) {
    const match = text.match(pattern);
    if (match) {
      const mag = parseFloat(match[1]);
      if (isNaN(mag) || mag < 1) continue;

      // Эпицентр
      const epicenterMatch = text.match(
        /(?:на\s+юге|на\s+севере|к\s+востоку|к\s+западу|восточнее|южнее|севернее|западнее)[^,.]{0,80}/i
      ) || text.match(/г\.\s*Петропавловск-Камчатский/i);
      const epicenter = epicenterMatch ? epicenterMatch[0].trim().slice(0, 100) : 'Камчатка';

      // Зоны
      const zones = ['avachinsky'];
      if (/северо?|ключевск|парамушир/i.test(text)) zones.push('northern');
      if (/восток|кроноцк|карымск/i.test(text)) zones.push('eastern');

      // Бюллетень (не одиночное событие) — severity всегда 0 (информация, не угроза)
      const isBulletin = /за неделю|сейсмическая обстановка|по состоянию на/i.test(text);
      const severity: 0 | 1 | 2 | 3 = isBulletin ? 0 : mag >= 7 ? 3 : mag >= 6 ? 2 : mag >= 5 ? 1 : 0;

      return {
        source_id: id,
        source_url: `https://${id}`,
        published_at: publishedAt,
        alert_type: isBulletin ? 'seismic_bulletin' : 'earthquake',
        severity,
        title: isBulletin
          ? `Сейсмобюллетень КБГС — до ML ${mag}`
          : `Землетрясение ML ${mag} — ${epicenter.slice(0, 50)}`,
        description: text.slice(0, 600),
        affected_zones: [...new Set(zones)],
        magnitude: mag,
        epicenter,
        expires_hours: isBulletin ? 24 * 7 : severity >= 2 ? 48 : 24,
      };
    }
  }

  // ── Дорожные ограничения (закрытие проезда, пропускной режим) ─────────
  const road = detectRoadRestriction(t);
  if (road) {
    return {
      source_id: id,
      source_url: `https://${id}`,
      published_at: publishedAt,
      alert_type: 'road_closure',
      severity: road.severity,
      title: text.split('\n')[0].slice(0, 200) || 'Ограничение проезда',
      description: text.slice(0, 800),
      affected_zones: mchs_zones(text),
      expires_hours: 24 * 7,
    };
  }

  return null;
}

// ── Парсер формата eqkam (структурированные сообщения) ───────────────────
// Пример: «Время UTC: 15 MAR 2026  12:07:52\nКоординаты: 51.27, 159.73\n...Магнитуда (Ml): 4.8»

function classifyEqkam(id: string, text: string, datetime: string): SeismicEvent | null {
  const magMatch = text.match(/Магнитуда\s*\(Ml\):\s*(\d+\.?\d*)/i);
  if (!magMatch) return null;

  const mag = parseFloat(magMatch[1]);
  if (isNaN(mag) || mag < 1) return null;

  // Координаты для определения зоны
  const coordMatch = text.match(/Координаты:\s*([\d.]+),\s*([\d.]+)/);
  const lat = coordMatch ? parseFloat(coordMatch[1]) : 52;
  const lon = coordMatch ? parseFloat(coordMatch[2]) : 158;

  // Глубина
  const depthMatch = text.match(/Глубина\s*\(КМ\):\s*([\d.]+)/i);
  const depthKm = depthMatch ? parseFloat(depthMatch[1]) : undefined;

  // Расстояние от ПК
  const distMatch = text.match(/Расстояние\s+от\s+ПК:\s*(\d+)/i);
  const distKm = distMatch ? parseInt(distMatch[1]) : undefined;

  // Зона по координатам
  const zones: string[] = [];
  if (lat >= 55.5) zones.push('northern');
  else if (lat >= 52 && lon >= 161) zones.push('eastern');
  else zones.push('avachinsky');

  const severity: 0 | 1 | 2 | 3 = mag >= 7 ? 3 : mag >= 6 ? 2 : mag >= 5 ? 1 : 0;
  const epicenter = distKm !== undefined
    ? `${distKm} км от Петропавловска-Камчатского`
    : `${lat.toFixed(2)}°N ${lon.toFixed(2)}°E`;

  return {
    source_id: id,
    source_url: `https://${id}`,
    published_at: new Date(datetime),
    alert_type: 'earthquake',
    severity,
    title: `Землетрясение ML ${mag} — ${epicenter.slice(0, 50)}`,
    description: text.slice(0, 600),
    affected_zones: zones,
    magnitude: mag,
    depth_km: depthKm,
    epicenter,
    expires_hours: severity >= 2 ? 48 : 24,
  };
}

// ── Сохранение в БД ───────────────────────────────────────────────────────

// export — переиспользует wildfire-firms.ts (пожарный слой пишет в те же
// external_alerts тем же путём, а не дублирует INSERT со своими нюансами).
export async function saveEvent(event: SeismicEvent): Promise<'inserted' | 'skipped'> {
  try {
    const expiresAt = new Date(event.published_at);
    expiresAt.setHours(expiresAt.getHours() + event.expires_hours);

    const result = await query(
      `INSERT INTO external_alerts (
        alert_type, severity, title, description,
        affected_zones, created_at, expires_at,
        source_url, external_id,
        magnitude, lat, lng
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (external_id) DO NOTHING
      RETURNING id`,
      [
        event.alert_type,
        event.severity,
        event.title,
        event.description,
        event.affected_zones,
        event.published_at,
        expiresAt,
        event.source_url,
        event.source_id,
        event.magnitude ?? null,
        event.lat ?? null,
        event.lng ?? null,
      ]
    );

    return (result.rowCount ?? 0) > 0 ? 'inserted' : 'skipped';
  } catch (e) {
    throw new Error(`DB save failed for ${event.source_id}: ${(e as Error).message}`);
  }
}

// ── Публичный API ─────────────────────────────────────────────────────────

export async function ingestKbgsras(): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };

  try {
    const html = await fetchTelegramChannel('kbgsras');
    const messages = extractMessages(html);
    result.rawItems = messages.length;

    for (const msg of messages) {
      const event = classifyMessage(msg.id, msg.text, msg.datetime);
      if (!event) continue;

      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }
  } catch (e) {
    result.errors.push(`kbgsras fetch failed: ${(e as Error).message}`);
  }

  return result;
}

export async function ingestEqkam(): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };

  try {
    const html = await fetchTelegramChannel('eqkam');
    const messages = extractMessages(html);
    result.rawItems = messages.length;

    for (const msg of messages) {
      // eqkam использует структурированный формат «Магнитуда (Ml): X»
      const event = classifyEqkam(msg.id, msg.text, msg.datetime)
                 ?? classifyMessage(msg.id, msg.text, msg.datetime);
      if (!event) continue;

      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }
  } catch (e) {
    result.errors.push(`eqkam fetch failed: ${(e as Error).message}`);
  }

  return result;
}

interface UsgsFeature {
  id: string;
  properties: { mag: number; place: string; time: number };
  geometry: { coordinates: [number, number, number] };
}

export async function ingestUsgs(): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };
  // USGS FDSN: M5.0+ в радиусе 500 км от ПКО (53.01°N, 158.65°E)
  const url =
    'https://earthquake.usgs.gov/fdsnws/event/1/query' +
    '?format=geojson&minmagnitude=5.0&latitude=53.01&longitude=158.65' +
    '&maxradiuskm=500&orderby=time&limit=20';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
    const data = await res.json() as { features?: UsgsFeature[] };

    for (const f of data.features ?? []) {
      const mag = f.properties.mag;
      if (!mag || mag < 1) continue;
      const place = f.properties.place ?? 'Камчатка';
      const [lng, lat] = f.geometry.coordinates;
      const publishedAt = new Date(f.properties.time);
      const severity: 0 | 1 | 2 | 3 = mag >= 7 ? 3 : mag >= 6 ? 2 : mag >= 5 ? 1 : 0;

      const zones: string[] = lat >= 55.5
        ? ['northern']
        : lng >= 161
          ? ['eastern']
          : ['avachinsky'];

      const event: SeismicEvent = {
        source_id: `usgs/${f.id}`,
        source_url: `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`,
        published_at: publishedAt,
        alert_type: 'earthquake',
        severity,
        title: `Землетрясение M${mag.toFixed(1)} — ${place.slice(0, 80)}`,
        description: `M${mag.toFixed(1)}, ${place}. Источник: USGS.`,
        affected_zones: zones,
        magnitude: mag,
        epicenter: place,
        lat,
        lng,
        expires_hours: severity >= 2 ? 48 : 24,
      };

      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }
  } catch (e) {
    result.errors.push(`usgs fetch: ${(e as Error).message}`);
  }
  return result;
}

// ── МЧС Камчатка ─────────────────────────────────────────────────────────────

const MCHS_DISTRICT_ZONES: Array<[RegExp, string[]]> = [
  // Вачкажец/Сокоч/Начики — трасса на западное побережье, задевает обе зоны
  [/вачкажец|сокоч|начикинск/i, ['western', 'avachinsky']],
  [/елизов/i,       ['avachinsky']],
  [/петропавловск/i,['avachinsky']],
  [/быстринск/i,    ['western']],
  [/тигильск/i,     ['western']],
  [/усть-камчатск/i,['northern']],
  [/алеутск/i,      ['northern']],
  [/карагинск/i,    ['eastern']],
  [/пенжинск/i,     ['northern']],
  [/олюторск/i,     ['eastern']],
];

export function mchs_zones(text: string): string[] {
  // Название вулкана в тексте — точнее административного района (переиспользуем
  // ту же карту, что и для КБГС РАН, а не только 9 паттернов по районам).
  const lower = text.toLowerCase();
  for (const [volcano, zones] of Object.entries(VOLCANO_ZONES)) {
    if (lower.includes(volcano)) return zones;
  }
  for (const [re, zones] of MCHS_DISTRICT_ZONES) {
    if (re.test(text)) return zones;
  }
  return ['avachinsky'];
}

/** Стабильный отпечаток заголовка (djb2 по нормализованному тексту). */
export function titleFingerprint(title: string): string {
  const norm = title.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
  let h = 5381;
  for (let i = 0; i < norm.length; i++) {
    h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function classifyMchsItem(
  id: string,
  title: string,
  description: string,
  pubDate: string,
  link: string,
  sourcePrefix: string = 'mchs',
): SeismicEvent | null {
  const text = `${title} ${description}`.toLowerCase();

  // Пресс-центр МЧС публикует не только бюллетени опасности, но и медиа-анонсы —
  // напр. «Эксперименты сотрудников испытательной пожарной лаборатории — в новом
  // выпуске программы «МЧС. Экстренный вызов»» ложно классифицировался как
  // fire_danger: слово «пожарной» там про телепрограмму, не про реальную опасность.
  // Такие анонсы отбрасываем до проверки категорий (баг замечен владельцем на
  // проде — активный алерт с текстом телеанонса вместо угрозы).
  if (/выпуск[а-я]*\s+программы|телепередач|телепрограмм/.test(text)) {
    return null;
  }

  // Учения и тренировки — не угроза: «пожарно-тактическое учение в школе № 40»
  // висело неделю как fire_danger на карточках маршрутов (скрины владельца
  // 2026-07-17). Алерт = действующая опасность, не отчёт о тренировке.
  // Граница слова руками ((^|не-буква)): JS \b не знает кириллицу, а без неё
  // «учени» матчит «полУЧЕНИе пропусков» — реальный алерт был бы отброшен.
  if (/(^|[^а-яё])(учени[еяй]|тренировк)|пожарно-тактическ/.test(text)) {
    return null;
  }

  let alert_type: SeismicEvent['alert_type'] = 'info';
  let severity: 0 | 1 | 2 | 3 = 0;
  let expires_hours = 24;

  if (/цунами/.test(text)) {
    alert_type = 'tsunami_warning'; severity = 3; expires_hours = 12;
  } else if (/ураган|смерч|шторм.{0,20}(балл|ветер)|сильный ветер/i.test(text)) {
    alert_type = 'info'; severity = 2; expires_hours = 24;
  } else if (/паводок|половодье|подтопление|уровень воды|реках.*ожидается/i.test(text)) {
    alert_type = 'flood'; severity = 1; expires_hours = 120;
  } else if (/класс[а-я]*\s+пожарной опасности|противопожарный режим|особый.*режим|угроза (лесных )?пожар/i.test(text)) {
    // Только ДЕЙСТВУЮЩАЯ пожарная опасность. Голое «пожар» ловило новости-итоги
    // («по вине курильщиков за год произошло 4 пожара») и держало их алертом
    // 168 часов на всех точках без зоны (скрины владельца 2026-07-17).
    alert_type = 'fire_danger'; severity = 1; expires_hours = 168;
  } else if (/оперативн[а-я]* сводк/.test(text) && /доступност[а-я]* туристическ/.test(text)) {
    // Оперативные сводки Минтура Камчатки о доступности туристических
    // объектов (kamgov.ru/mintur/news/...) — официальный «открыто/закрыто»
    // по объектам. Ссылку на такую сводку прислал владелец 2026-07-18.
    // Пока сохраняем как info-сводку (текст объектов — в description);
    // построчный разбор статусов — следующий шаг, когда накопятся образцы.
    alert_type = 'info'; severity = 0; expires_hours = 48;
  } else if (detectRoadRestriction(text)) {
    // Дорожные ограничения: пропускной режим, закрытие/перекрытие проезда
    // к туристическим местам (пропущенный кейс: Вилючинский перевал/Вачкажец)
    alert_type = 'road_closure';
    severity = detectRoadRestriction(text)!.severity;
    expires_hours = 24 * 7;
  } else if (
    /вулкан/.test(text) &&
    /газопепловый выброс|пепловый выброс|пепловое облако|извержени|оползн|обвал|восхождени|сейсмическ|землетрясен/.test(text)
  ) {
    // Раньше такие бюллетени (напр. "воздержаться от восхождения на Мутновский —
    // газопепловый выброс, землетрясения в постройке, оползни/обвалы") молча
    // отбрасывались — из 4 категорий (цунами/шторм/паводок/пожар) ни одна не
    // покрывала вулканическую опасность конкретной горы. Явная рекомендация
    // МЧС избегать места — severity 2 (red в recommender_status), иначе 1.
    alert_type = 'volcanic_eruption';
    severity = /воздержаться|не рекомендует|не совершать|избегать|опасн/.test(text) ? 2 : 1;
    expires_hours = severity >= 2 ? 48 : 24;
  } else {
    return null; // не интересно
  }

  const publishedAt = new Date(pubDate);
  if (isNaN(publishedAt.getTime())) return null;

  return {
    // Дедуп по СОДЕРЖАНИЮ, не по guid: RSS перепубликует одно предупреждение
    // с новыми id, и «Экстренное предупреждение на 16-20 июля» вставлялось
    // шестью строками (скрины владельца 2026-07-17). Одинаковый нормализованный
    // заголовок → одинаковый external_id → ON CONFLICT DO NOTHING.
    source_id:     `${sourcePrefix}/t${titleFingerprint(title)}`,
    source_url:    link || 'https://41.mchs.gov.ru',
    published_at:  publishedAt,
    alert_type,
    severity,
    title:         title.slice(0, 200),
    description:   description.slice(0, 800),
    affected_zones: mchs_zones(`${title} ${description}`),
    expires_hours,
  };
}

// https://41.mchs.gov.ru/rss (старый, зашитый годами ранее) на практике не
// отдаёт RSS — подтверждено вживую. Реальные работающие пути (подтверждены
// пользователем открытием в браузере 2026-07-02), по убыванию целевой точности:
//  1. .../shtormovye-i-ekstrennye-preduprezhdeniya/rss — экстренные
//     предупреждения, официальное название раздела для подписки — самое
//     целевое под "воздержаться от восхождения на Мутновский".
//  2. .../operativnaya-informaciya/prognozy/rss — прогнозы опасности.
//  3. .../operativnaya-informaciya/rss — общий раздел оперативной информации.
// .../novosti/rss (используется отдельно в lib/kuzmich/core.ts fetchMchsAlerts
// для общих новостей) и старый /rss — фоллбэки на случай, если сайт снова
// переедет. Берём первый, что реально отдаёт RSS (HTTP ok И есть хотя бы
// один <item> — гос-сайты любят отдавать 200 с HTML страницей ошибки вместо
// ожидаемого фида). Дубли между источниками не страшны — saveEvent
// дедуплицирует по external_id (ON CONFLICT DO NOTHING).
const MCHS_FEED_CANDIDATES = [
  'https://41.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/shtormovye-i-ekstrennye-preduprezhdeniya/rss',
  'https://41.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/prognozy/rss',
  'https://41.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/rss',
  'https://41.mchs.gov.ru/deyatelnost/press-centr/novosti/rss',
  'https://41.mchs.gov.ru/rss',
];

async function fetchOneMchsFeed(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KamchatourBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    return /<item[\s>]/i.test(xml) ? xml : null;
  } catch {
    return null;
  }
}

/**
 * Раньше брали первый рабочий URL и останавливались — но экстренные
 * предупреждения/прогнозы/общая оперативная информация оказались РАЗНЫМИ
 * разделами сайта, не зеркалами друг друга. Останавливаться на первом
 * означало молча терять содержимое остальных. Собираем со всех валидных
 * фидов; отдельные упавшие (сеть/404/не-RSS) не блокируют остальные.
 */
export async function fetchMchsFeedXml(): Promise<string[]> {
  const results = await Promise.all(MCHS_FEED_CANDIDATES.map(fetchOneMchsFeed));
  return results.filter((xml): xml is string => xml !== null);
}

function parseMchsItems(xml: string): Array<{ id: string; title: string; link: string; pubDate: string; desc: string }> {
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  const tagRe  = (t: string) => new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${t}>|<${t}[^>]*>([^<]*)<\\/${t}>`, 'i');
  const items: Array<{ id: string; title: string; link: string; pubDate: string; desc: string }> = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = itemRe.exec(xml)) !== null) {
    const chunk = m[1];
    const get = (tag: string) => {
      const r = tagRe(tag).exec(chunk);
      return (r?.[1] ?? r?.[2] ?? '').trim();
    };
    const title   = get('title');
    const link    = get('link');
    const pubDate = get('pubDate');
    const desc    = get('description');
    const guid    = get('guid') || `${pubDate}-${idx++}`;
    items.push({ id: guid, title, link, pubDate, desc });
  }
  return items;
}

export async function ingestMchsAlerts(): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };
  try {
    const feeds = await fetchMchsFeedXml();
    if (feeds.length === 0) {
      throw new Error(`none of ${MCHS_FEED_CANDIDATES.length} MChS feed URLs returned valid RSS`);
    }

    result.rawItems = 0;
    for (const xml of feeds) {
      const items = parseMchsItems(xml);
      result.rawItems += items.length; // фид жив = отдал items (даже если ни один не ЧП)
      for (const it of items) {
        const event = classifyMchsItem(it.id, it.title, it.desc, it.pubDate, it.link);
        if (!event) continue;
        result.events.push(event);
        try {
          // Один и тот же бюллетень может попасть в несколько разделов сайта —
          // saveEvent дедуплицирует по external_id (ON CONFLICT DO NOTHING).
          const status = await saveEvent(event);
          if (status === 'inserted') result.inserted++;
          else result.skipped++;
        } catch (e) { result.errors.push((e as Error).message); }
      }
    }
  } catch (e) {
    result.errors.push(`mchs fetch failed: ${(e as Error).message}`);
  }
  return result;
}

// ── Новостные источники (kamgov, visitkamchatka) ─────────────────────────
// Появились после пропущенной дорожной новости (пропуска к Вилючинскому
// перевалу): kamgov RSS читался только суточным Scout Digest — в
// Telegram-дайджест, мимо external_alerts; visitkamchatka не читался вообще.
// Классификация — той же classifyMchsItem: природные категории + road_closure.

const NEWS_FEED_SOURCES: Array<{ prefix: string; candidates: string[]; optional?: boolean }> = [
  {
    prefix: 'kamgov',
    candidates: [
      'https://www.kamgov.ru/rss',
      // Раздел Минтура (оперативные сводки доступности туробъектов) может
      // не попадать в общий фид. Если пути не существует — гос-сайт отдаст
      // HTML, fetchOneMchsFeed его отбросит; дубли снимает saveEvent.
      'https://www.kamgov.ru/mintur/rss',
      'https://www.kamgov.ru/mintur/news/rss',
    ],
  },
  // WordPress-фиды турпортала; из среды разработки сеть к нему закрыта,
  // работоспособность не проверена — источник optional: недоступность
  // не считается ошибкой конвейера, fetchOneMchsFeed отбрасывает не-RSS.
  {
    prefix: 'visitkamchatka',
    optional: true,
    candidates: [
      'https://visitkamchatka.ru/security/feed/',
      'https://visitkamchatka.ru/feed/',
    ],
  },
];

export async function ingestNewsFeeds(): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };

  for (const source of NEWS_FEED_SOURCES) {
    // Дедуп одинакового содержимого: разные пути могут быть алиасами одного
    // фида (например /rss и /mintur/rss) — не обрабатывать дважды
    const xmls = [...new Set(
      (await Promise.all(source.candidates.map(fetchOneMchsFeed)))
        .filter((xml): xml is string => xml !== null),
    )];

    if (xmls.length === 0) {
      if (!source.optional) result.errors.push(`news feed unavailable: ${source.prefix}`);
      continue;
    }

    for (const xml of xmls) {
      for (const it of parseMchsItems(xml)) {
        const event = classifyMchsItem(it.id, it.title, it.desc, it.pubDate, it.link, source.prefix);
        if (!event) continue;
        result.events.push(event);
        try {
          const status = await saveEvent(event);
          if (status === 'inserted') result.inserted++;
          else result.skipped++;
        } catch (e) {
          result.errors.push((e as Error).message);
        }
      }
    }
  }

  return result;
}

// ── Telegram-каналы с новостями (minec_tourism) ───────────────────────────
// HTML канала скачивает GitHub Actions (t.me заблокирован для хостинга)
// и передаёт в POST /api/cron/safety-ingest — как для kbgsras/eqkam.

export async function ingestTelegramNewsHtml(html: string): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };
  for (const msg of extractMessages(html)) {
    const event = classifyMessage(msg.id, msg.text, msg.datetime);
    if (!event) continue;
    result.events.push(event);
    try {
      const status = await saveEvent(event);
      if (status === 'inserted') result.inserted++;
      else result.skipped++;
    } catch (e) {
      result.errors.push((e as Error).message);
    }
  }
  return result;
}

// ── Официальное сообщество ГУ МЧС Камчатки во ВКонтакте ──────────────────────
// vk.com/mchs_kamchatka — суточные оперативные сводки (пожары, ДТП, дороги,
// подъём рек, активность вулканов). Website-RSS 41.mchs.gov.ru несёт только
// формальные предупреждения; сводки живут в соцканалах. VK API (api.vk.com)
// доступен из РФ (Timeweb) напрямую — в отличие от t.me/OSM. Опционален: без
// VK_SERVICE_TOKEN молча ничего не делает. Классификация — той же
// classifyMchsItem (природные категории + road_closure, с отсевом телеанонсов/учений).
const VK_MCHS_DOMAIN = 'mchs_kamchatka';

export async function ingestVkMchs(): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };
  const token = process.env.VK_SERVICE_TOKEN;
  if (!token) return result; // опциональный источник: токена нет — тихо выходим
  try {
    const url = `https://api.vk.com/method/wall.get?domain=${VK_MCHS_DOMAIN}`
      + `&count=25&access_token=${encodeURIComponent(token)}&v=5.199`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { result.errors.push(`vk http ${res.status}`); return result; }
    const data = await res.json() as {
      error?: { error_msg?: string };
      response?: { items?: Array<{ id: number; owner_id: number; date: number; text?: string }> };
    };
    if (data.error) { result.errors.push(`vk: ${data.error.error_msg ?? 'api error'}`); return result; }
    result.rawItems = data.response?.items?.length ?? 0;
    for (const post of data.response?.items ?? []) {
      const text = (post.text ?? '').trim();
      if (!text) continue;
      const id = `vk.com/${VK_MCHS_DOMAIN}/${post.id}`;
      const pubDate = new Date(post.date * 1000).toISOString();
      const link = `https://vk.com/wall${post.owner_id}_${post.id}`;
      // title пустой — у VK-постов нет заголовка, весь текст в description.
      const event = classifyMchsItem(id, '', text, pubDate, link, 'vk_mchs');
      if (!event) continue;
      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }
  } catch (e) {
    result.errors.push((e as Error).message);
  }
  return result;
}

// ── Официальный канал ГУ МЧС Камчатки в MAX ─────────────────────────────────
// max.ru/id4101120929_gos — тот же поток оперативных сводок, что и VK, но в
// госмессенджере MAX. В отличие от VK (api.vk.com/wall.get доступен из РФ),
// у MAX нет открытого read-API для чтения канала. Поэтому посты приходят
// СНАРУЖИ: GitHub Actions читает канал и POST'ит массив items на сервер
// (тот же паттерн, что t.me/kbgsras через ingestFromHtml — обход того, что
// хостинг может не достучаться до источника). Сервер каждый item прогоняет
// через classifyMchsItem — она же и фильтр мусора: приветствия, телеанонсы,
// учения, статистика → null → выброшены; в БД попадают только реальные
// категории опасности (цунами/паводок/пожар/дорога/вулкан).
export async function ingestMaxItems(
  items: Array<{ id: string; text: string; date?: string; link?: string }>,
): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [], rawItems: items.length };
  for (const item of items) {
    const text = (item.text ?? '').trim();
    if (!text) continue;
    const id = item.id || `max/${titleFingerprint(text)}`;
    const pubDate = item.date && !isNaN(new Date(item.date).getTime())
      ? new Date(item.date).toISOString()
      : new Date().toISOString();
    const link = item.link || 'https://max.ru/id4101120929_gos';
    // title пустой — у MAX-постов нет заголовка, весь текст в description.
    // classifyMchsItem вернёт null для мусора — это и есть сортировка.
    const event = classifyMchsItem(id, '', text, pubDate, link, 'max_mchs');
    if (!event) continue;
    result.events.push(event);
    try {
      const status = await saveEvent(event);
      if (status === 'inserted') result.inserted++;
      else result.skipped++;
    } catch (e) {
      result.errors.push((e as Error).message);
    }
  }
  return result;
}

export async function ingestAll(): Promise<{
  kbgsras: ParseResult;
  eqkam: ParseResult;
  usgs: ParseResult;
  mchs: ParseResult;
  news: ParseResult;
  vk: ParseResult;
  total_inserted: number;
}> {
  const [kbgsras, eqkam, usgs, mchs, news, vk] = await Promise.all([
    ingestKbgsras(), ingestEqkam(), ingestUsgs(), ingestMchsAlerts(), ingestNewsFeeds(), ingestVkMchs(),
  ]);
  return {
    kbgsras,
    eqkam,
    usgs,
    mchs,
    news,
    vk,
    total_inserted: kbgsras.inserted + eqkam.inserted + usgs.inserted + mchs.inserted + news.inserted + vk.inserted,
  };
}

// Вариант без внутреннего fetch — HTML передаётся снаружи (GitHub Actions).
// Используется когда сервер не может достучаться до t.me (российский хостинг).
export async function ingestFromHtml(
  kbgsrasHtml: string,
  eqkamHtml: string,
): Promise<{ kbgsras: ParseResult; eqkam: ParseResult; total_inserted: number }> {
  async function processHtml(
    html: string,
    classify: (id: string, text: string, datetime: string) => SeismicEvent | null,
  ): Promise<ParseResult> {
    const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };
    const msgs = extractMessages(html);
    result.rawItems = msgs.length; // канал жив = прислал посты (даже если ни один не ЧП)
    for (const msg of msgs) {
      const event = classify(msg.id, msg.text, msg.datetime);
      if (!event) continue;
      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }
    return result;
  }

  const [kbgsras, eqkam] = await Promise.all([
    processHtml(kbgsrasHtml, classifyMessage),
    processHtml(eqkamHtml, (id, text, datetime) =>
      classifyEqkam(id, text, datetime) ?? classifyMessage(id, text, datetime),
    ),
  ]);

  return { kbgsras, eqkam, total_inserted: kbgsras.inserted + eqkam.inserted };
}
