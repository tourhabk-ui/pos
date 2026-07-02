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
  alert_type: 'volcanic_eruption' | 'earthquake' | 'seismic_bulletin' | 'ash_cloud' | 'info' | 'tsunami_warning' | 'flood' | 'fire_danger';
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

async function saveEvent(event: SeismicEvent): Promise<'inserted' | 'skipped'> {
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

export function classifyMchsItem(
  id: string,
  title: string,
  description: string,
  pubDate: string,
  link: string,
): SeismicEvent | null {
  const text = `${title} ${description}`.toLowerCase();

  let alert_type: SeismicEvent['alert_type'] = 'info';
  let severity: 0 | 1 | 2 | 3 = 0;
  let expires_hours = 24;

  if (/цунами/.test(text)) {
    alert_type = 'tsunami_warning'; severity = 3; expires_hours = 12;
  } else if (/ураган|смерч|шторм.{0,20}(балл|ветер)|сильный ветер/i.test(text)) {
    alert_type = 'info'; severity = 2; expires_hours = 24;
  } else if (/паводок|половодье|подтопление|уровень воды|реках.*ожидается/i.test(text)) {
    alert_type = 'flood'; severity = 1; expires_hours = 120;
  } else if (/пожар|противопожарный режим|особый.*режим/i.test(text)) {
    alert_type = 'fire_danger'; severity = 1; expires_hours = 168;
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
    source_id:     `mchs/${id}`,
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

export async function ingestMchsAlerts(): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };
  try {
    const res = await fetch('https://41.mchs.gov.ru/rss', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KamchatourBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    // Простой regex-парсер RSS 2.0 (без xml2js)
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    const tagRe  = (t: string) => new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${t}>|<${t}[^>]*>([^<]*)<\\/${t}>`, 'i');
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

      const event = classifyMchsItem(guid, title, desc, pubDate, link);
      if (!event) continue;
      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) { result.errors.push((e as Error).message); }
    }
  } catch (e) {
    result.errors.push(`mchs fetch failed: ${(e as Error).message}`);
  }
  return result;
}

export async function ingestAll(): Promise<{
  kbgsras: ParseResult;
  eqkam: ParseResult;
  usgs: ParseResult;
  mchs: ParseResult;
  total_inserted: number;
}> {
  const [kbgsras, eqkam, usgs, mchs] = await Promise.all([
    ingestKbgsras(), ingestEqkam(), ingestUsgs(), ingestMchsAlerts(),
  ]);
  return {
    kbgsras,
    eqkam,
    usgs,
    mchs,
    total_inserted: kbgsras.inserted + eqkam.inserted + usgs.inserted + mchs.inserted,
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
    for (const msg of extractMessages(html)) {
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
