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
import { textFromEscapedHtml } from '@/lib/services/safety/kvert-vona';
import { zonesForEpicenter, distanceKm, PETROPAVLOVSK } from '@/lib/services/safety/seismic-zones';
import { parseEmsdQuakes, EMSD_HOME_URL, type EmsdQuakeTable } from '@/lib/services/safety/emsd-quakes';
import { decodeHtmlEntities } from '@/lib/html/entities';
import { stripTags } from '@/lib/html/text';
import { appendSafetyEvent, hashPayload } from '@/lib/safety/ledger';

// ── Типы ─────────────────────────────────────────────────────────────────

export interface SeismicEvent {
  source_id: string;        // t.me/kbgsras/6680
  source_url: string;
  published_at: Date;
  alert_type: 'volcanic_eruption' | 'earthquake' | 'seismic_bulletin' | 'ash_cloud' | 'info' | 'tsunami_warning' | 'flood' | 'fire_danger' | 'road_closure' | 'weather' | 'avalanche' | 'landslide' | 'bear';
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

/** Все четыре тревожные зоны — для предупреждений, которые сами говорят «по краю». */
const ALL_ZONES = ['avachinsky', 'eastern', 'western', 'northern'] as const;

/**
 * Текст, который САМ объявляет себя общекраевым. Это данные, а не умолчание:
 * «по Камчатскому краю ожидается штормовой ветер» накрывает и город, и
 * вулканы — по слову источника, не по нашей догадке. Проверяется ПОСЛЕ
 * вулканов и округов: «по краю… в Соболевском округе» — про Соболевский.
 */
// `\b` здесь нельзя: в JS без флага u граница слова считается по [A-Za-z0-9_],
// и после кириллицы её нет никогда — `/краю\b/` не совпадёт с «по краю».
const KRAI_WIDE_RE = /по\s+(?:всему\s+)?камчатскому\s+краю|по\s+всему\s+краю|по\s+краю(?![а-яё])|на\s+(?:всей\s+)?территории\s+(?:всего\s+)?края/i;

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
  // Кроноцкий заповедник: сводка Минтура 06.08 не рекомендовала «район вулкана
  // Крашенинникова» — имени не было в карте, зона терялась.
  'крашенинникова': ['eastern'],
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
    // Разворот — один проход (lib/html/entities). Текст сейсмосводки уходит
    // туристу; цепочка разворачивала его дважды.
    const text = decodeHtmlEntities(
      stripTags(rawHtml.replace(/<br\s*\/?>/gi, '\n')),
    ).trim();

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
// Предпоследняя альтернатива ловит естественный русский порядок «глагол→предмет»
// («Временно ограничено движение...» из суточной сводки ГУ МЧС в ВК/МАХ) —
// прежний паттерн требовал «предмет→глагол» и такую формулировку пропускал.
// Последняя — отглагольное существительное: «Остаются ОГРАНИЧЕНИЯ для
// пассажирского транспорта на ДОРОГЕ мыс Левашова — посёлок Октябрьский»
// (сводка 29.07). Ни один прежний вариант её не брал: между «ограничениями» и
// «дорогой» стоит предмет ограничения, а слова «проезд»/«движение» в строке нет
// вовсе. Проверено на живой сводке — до правки detectRoadRestriction отдавал null.

const ROAD_RESTRICTION_RE =
  /закрыт[а-яё]*\s+(?:проезд|дорог|движени)|(?:проезд|движени|дорог|доступ)[а-яё]*[\s\S]{0,120}?(?:закрыт|ограничен|перекрыт)|проезд[а-яё]*[\s\S]{0,120}?по\s+пропуск|пропускн[а-яё]+\s+режим|перекрыт[а-яё]*\s+(?:дорог|проезд|движени)|(?:ограничен|закрыт|перекрыт)[а-яё]*\s+(?:проезд|движени)|ограничени[а-яё]*[\s\S]{0,80}?(?:автодорог|дорог|проезд|движени)|(?:закрыт|перекрыт)[а-яё]*[\s\S]{0,40}?маршрут|маршрут[а-яё]*[\s\S]{0,60}?(?:закрыт|перекрыт)|перекрыти[а-яё]*[\s\S]{0,40}?маршрут/i;

export function detectRoadRestriction(text: string): { severity: 1 | 2 } | null {
  if (!ROAD_RESTRICTION_RE.test(text)) return null;
  // Полное закрытие — красный уровень, ограничение/пропуска — жёлтый
  const severity: 1 | 2 = /закрыт|перекрыт/i.test(text) ? 2 : 1;
  return { severity };
}

// ── Классификатор событий ─────────────────────────────────────────────────

export function classifyMessage(id: string, text: string, datetime: string): SeismicEvent | null {
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

  // «Угрозы нет» (tsunamiStatus → no_threat) — не предупреждение: ветка
  // пропускается, и пост идёт дальше, к разбору магнитуды, — обычно это
  // сообщение о самом толчке.
  const tsunami = /угроза\s+цунами|предупреждение\s+о\s+цунами|tsunami\s+warning|цунами\s+объявлен/i.test(t)
    ? tsunamiStatus(text)
    : null;
  if (tsunami === 'warning' || tsunami === 'all_clear') {
    const isAllClear = tsunami === 'all_clear';
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
      const severity: 0 | 1 | 2 | 3 = isBulletin ? 0 : severityForMagnitude(mag);

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

// ── Цунами: угроза, отбой или «угрозы нет» (24.09) ─────────────────────────
//
// Два классификатора (КБГС и МЧС) решали это по-разному, и оба ошибались в
// сторону ТРЕВОГИ:
//
//   МЧС  — любое слово «цунами» давало tsunami_warning с важностью 3. После
//          каждого заметного толчка МЧС Камчатки пишет «угрозы цунами нет»,
//          и такой пост становился у нас тревогой цунами для всех туристов;
//   КБГС — отбоем считались только «отбой», «снята угроза» и «all clear».
//          «Угроза цунами отменена», «угроза цунами снята» (другой порядок
//          слов) и «угроза цунами не ожидается» давали важность 3.
//
// Ложная тревога цунами — не безобидная перестраховка. Это эвакуация без
// причины у тех, кто поверил, и выученное недоверие у тех, кто нет: второй
// раз настоящую тревогу прочтут как очередную ошибку.
//
// Правило одно на оба источника (§12) и работает ПО ПРЕДЛОЖЕНИЯМ: отрицание и
// отбой снимают тревогу, только если стоят в том же предложении, что и
// «цунами», и рядом с ним. Иначе пост «Объявлена угроза цунами. Если нет
// возможности эвакуироваться, поднимитесь выше» потерял бы тревогу из-за
// постороннего «нет».
//
// Если хоть одно предложение про цунами — без отрицания и без отбоя, исход
// «угроза». При сомнении правило ошибается в сторону тревоги: пропущенное
// цунами дороже ложного.

export type TsunamiStatus = 'warning' | 'all_clear' | 'no_threat';

const NEG_VERB = 'не\\s+(?:ожида|прогноз|угрожа|зарегистр|зафиксир|предвид|возник|объявл|будет)';

/** «Угрозы нет»: отрицание рядом со словом «цунами». */
const TSUNAMI_NO_THREAT = new RegExp(
  `цунами[^.]{0,40}?${NEG_VERB}` +
  `|${NEG_VERB}[^.]{0,25}?цунами` +
  '|(?:угроз[аыу]?|опасност[иь])\\s+(?:возникновения\\s+)?цунами\\s+(?:для\\s+[^.]{0,40}?)?(?:нет|отсутств)' +
  '|без\\s+угрозы\\s+(?:возникновения\\s+)?цунами' +
  '|цунами\\s+нет',
);

/** Отбой. «Не отменена» и «не снята» — не отбой. */
const TSUNAMI_ALL_CLEAR = /отбой|all\s+clear|(?<!не\s)(?:отмен|снят|сняли|миновал)/;

/**
 * Обещание отбоя в будущем — это ещё угроза: «Отбой угрозы цунами будет
 * объявлен дополнительно» стоит в тексте ДЕЙСТВУЮЩЕГО предупреждения.
 */
const TSUNAMI_ALL_CLEAR_LATER = /(?:будет|последует|дополнительно|позже)/;

/**
 * Вето на понижение: в предложении есть отрицание при слове отбоя или
 * признак того, что угроза продолжается. Разбор 24.09 нашёл девять живых
 * формулировок, которые правило понижало при действующей угрозе:
 * «не была снята» (просмотр назад видит «не» только вплотную), «не  отменена»
 * с двумя пробелами, «отбой пока не объявлен», «объявлен не был», «отмена не
 * планируется», «снятие не ожидается», «сохраняется, отмены пока нет»,
 * частичная отмена «для островов отменено, для побережья сохраняется» и
 * «волны не зарегистрированы, но угроза сохраняется». У всех девяти верный
 * исход — предупреждение; пропущенное цунами дороже ложного.
 *
 * Отрицание связывается со словом отбоя только в пределах пары слов без
 * запятой: «Отбой угрозы цунами, волна не зафиксирована» остаётся отбоем.
 */
const TSUNAMI_DOWNGRADE_VETO = new RegExp(
  '(?:^|[^а-я])(?:не|нет)\\s+(?:[а-я]+\\s+){0,2}(?:отмен|отбо|снят|сняли|сним|миновал|объявл)' +
  '|(?:отбо[йя]|отмен[а-я]*|снят[а-я]*|сняти[а-я]*|миновал[а-я]*|объявл[а-я]*)(?:\\s+[а-я]+){0,3}\\s+(?:не|нет)(?![а-я])' +
  '|сохраня|продолжа|остается|действует|действующ',
);

export function tsunamiStatus(text: string): TsunamiStatus | null {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  if (!/цунами|tsunami/.test(t)) return null;

  const sentences = t.split(/[.!?;\n]+/).filter((s) => /цунами|tsunami/.test(s));
  let sawAllClear = false;
  let sawNoThreat = false;
  for (const s of sentences) {
    // Понижать нельзя, если в том же предложении угроза продолжается или
    // слово отбоя отрицается: такое предложение — предупреждение.
    if (TSUNAMI_DOWNGRADE_VETO.test(s)) return 'warning';
    if (TSUNAMI_ALL_CLEAR.test(s) && !TSUNAMI_ALL_CLEAR_LATER.test(s)) {
      sawAllClear = true;
      continue;
    }
    if (TSUNAMI_NO_THREAT.test(s)) {
      sawNoThreat = true;
      continue;
    }
    return 'warning';
  }
  if (sawAllClear) return 'all_clear';
  if (sawNoThreat) return 'no_threat';
  return 'warning';
}

/**
 * Важность землетрясения по магнитуде. ОДНО правило на все источники.
 *
 * До 24.09 это выражение стояло в трёх местах буквально (КБГС, EQKam, USGS),
 * и четвёртый источник — таблица emsd.ru — завёл бы четвёртую копию. Копии
 * одного правила расходятся молча: стоит кому-то поднять порог у одного
 * источника, и одинаковый толчок станет у нас двумя разными угрозами (§12).
 *
 * Пороги прежние, ни одно значение не изменилось.
 */
export function severityForMagnitude(mag: number): 0 | 1 | 2 | 3 {
  return mag >= 7 ? 3 : mag >= 6 ? 2 : mag >= 5 ? 1 : 0;
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

  const severity: 0 | 1 | 2 | 3 = severityForMagnitude(mag);
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
    // Координаты пишутся, только когда они РАЗОБРАНЫ. Выше для зоны стоит
    // запас 52/158, если строки «Координаты:» нет, — для зоны это грубо, но
    // терпимо, а на карте и в сверке с другими источниками это была бы
    // выдуманная точка. До 24.09 координаты EQKam не писались вовсе, и сверка
    // «тот же толчок уже пришёл от emsd.ru/USGS» его бы не увидела.
    ...(coordMatch ? { lat, lng: lon } : {}),
    expires_hours: severity >= 2 ? 48 : 24,
  };
}

// ── Сохранение в БД ───────────────────────────────────────────────────────

// export — переиспользует wildfire-firms.ts (пожарный слой пишет в те же
// external_alerts тем же путём, а не дублирует INSERT со своими нюансами).
//
// Safety Decision Ledger (925): единственный choke-point записи в
// external_alerts (8 вызовов саму saveEvent из этого файла + wildfire-firms.ts)
// — поэтому события ledger эмитятся здесь, а не внутри classifyMchsItem/
// mchs_zones/zonesForEpicenter. Те — чистые синхронные функции с множеством
// вызывающих; делать их async ради инструментирования сломало бы больше, чем
// дало бы точности. Цена: signal_normalized/risk_classified/geo_matched
// пишутся ТРЕМЯ строками из ОДНОЙ точки времени (классификация уже прошла до
// вызова saveEvent) — не три момента, а три ФАКТА об одном вычислении,
// разделённые ради queryability (искать «все risk_classified severity>=2»
// проще по своей строке, чем по JSON внутри signal_normalized.details).
//
// geo_unmatched эмитится с 17.09. До того mchs_zones() при пустом совпадении
// молча возвращала fallback ['avachinsky'], и снаружи «настоящий Авачинский»
// и «дефолт» были неразличимы — журнал честно не претендовал на «unmatched».
// Теперь пустое совпадение возвращает [], различие есть в данных, и оно
// записывается: пустые affected_zones → geo_unmatched, иначе geo_matched.
//
// ЖУРНАЛ ПИШЕТСЯ О СОБЫТИЯХ, А ПЕРЕЧИТАННАЯ ЛЕНТА — НЕ СОБЫТИЕ (09.09).
//
// Первая редакция эмитила всю цепочку ДО того, как узнавала, новый ли item:
// четыре строки на каждый разобранный пост, каждый прогон. Ингест идёт раз в
// пять минут, ленты отдают одни и те же посты сутками — и замер темпа
// (`db-size-census`, prod-check run 43) показал цену: 60 251 строка и 28,0 МБ
// в сутки, 274 МБ за десять дней, треть всей базы. Записывалось при этом
// одно и то же: «мы снова посмотрели, и снова ничего не изменилось».
//
// Теперь цепочка пишется только для НОВОГО сигнала, а повтор — только если
// он что-то изменил (сдвинул `expires_at`). Порядок: контентный дедуп →
// сверка по `external_id` → и лишь потом события.
//
// Что при этом НЕ потеряно: «мы смотрели» по-прежнему записывается —
// `source_observed` в safety-ingest, одна строка на источник на прогон
// (route.ts:54). Живость конвейера видна там, где ей место, и стоит
// двухсотой доли прежнего объёма.
export async function saveEvent(event: SeismicEvent): Promise<'inserted' | 'skipped'> {
  const payloadHash = hashPayload({
    alert_type: event.alert_type,
    title: event.title,
    description: event.description,
    source_id: event.source_id,
  });
  try {
    const expiresAt = new Date(event.published_at);
    expiresAt.setHours(expiresAt.getHours() + event.expires_hours);

    // Контент-дедуп ПЕРЕД вставкой. ON CONFLICT (external_id) ловит только
    // повтор ТОГО ЖЕ поста, а суточная сводка МЧС публикуется каждый день
    // новым постом с тем же текстом («Сохраняется риск схода оползней…») —
    // и каждый день рождала новую строку при живой старой. На /safety это
    // выглядело трёхкратным одинаковым предупреждением, а счётчик пилюли
    // главной честно считал дубли за отдельные угрозы. Повтор того же текста
    // при активном оригинале — это ПОДТВЕРЖДЕНИЕ угрозы: продлеваем срок
    // действия оригинала, строку не плодим.
    //
    // Сравнение НОРМАЛИЗОВАННОЕ, не дословное (06.09): одно и то же событие
    // (дорожное ограничение, пожарная опасность) приходит сразу с нескольких
    // источников — kamgov, раздел Минтура, ВК МЧС — и каждый чуть иначе
    // форматирует один и тот же текст (лишний пробел, другой регистр). Точное
    // `title = $2` эти пары не ловило: 5-6 источников об одном и том же —
    // 5-6 отдельных строк и 5-6 push. lower+trim+схлопнутые пробелы ловит
    // разницу в оформлении, но не путает РАЗНЫЕ события: заголовок остаётся
    // единственным ключом, полное текстовое совпадение по-прежнему не требуется.
    // Подзапрос `prev` читает строку ДО записи (снимок транзакции), поэтому
    // `prev.expires_at` — старое значение, а `external_alerts.expires_at` в
    // RETURNING — новое. Без этой пары «продлили» и «перечитали то же самое»
    // неразличимы, а различать их обязательно: второе не событие.
    //
    // `external_alerts.expires_at` в SET КВАЛИФИЦИРОВАН, и это не стиль.
    // 09.09 в 02:37 сюда уехала редакция с голым `GREATEST(expires_at, $4)`:
    // при `FROM (...) prev` в области видимости ДВЕ колонки с этим именем, и
    // PostgreSQL отвечает 42702 «column reference is ambiguous» — на КАЖДЫЙ
    // пост каждого источника. Двадцать часов конвейер безопасности не
    // сохранил ни одного алерта; ошибка лежала в журнале (fetch_failed, 1031
    // строка), но читать его пришли только на следующий вечер. Моки этого не
    // ловят — вывод имён делает сервер; сторож — tests/integration/
    // alert-dedup.pg.test.ts на настоящем PostgreSQL.
    // Severity ПЕРЕОЦЕНИВАЕТСЯ — и только вверх, как и срок.
    //
    // До 13.09 дедуп двигал один `expires_at`, и это делало любую починку
    // классификатора задним числом бесполезной для уже идущего события. Случай
    // того же дня: сводка УГМС о паводке ОЯ на Большой Воровской принимается в
    // 12:00 с severity 1, в 13:00 выходит правка, поднимающая ОЯ до двойки, — и
    // строка живёт единицей все свои 120 часов, потому что каждый следующий
    // опрос ленты попадает в дедуп и трогает только срок. Правка есть, до
    // туриста она не доходит: ровно тот разрыв «я же починил», что уже был с
    // координатами мест и статичными пакетами карты.
    //
    // GREATEST, а не присваивание: понижать нельзя. Иначе переформулированная
    // МЧС сводка (тот же заголовок, мягче текст) молча сняла бы красный статус
    // и отменила бы ещё не отправленный пуш — починка, работающая в сторону
    // тишины, опаснее её отсутствия.
    //
    // Пуш при этом не дублируется: выборка рассылки берёт `push_sent_at IS
    // NULL`, поэтому поднятый до двойки алерт уедет ровно один раз — тот, что
    // раньше не уезжал вовсе.
    // Зоны — лечение уже сохранённых строк (17.09). До этого дня mchs_zones
    // при пустом совпадении писала ['avachinsky'], и строки с этой подписью
    // живут в базе, пока лента их републикует (GREATEST выше держит срок).
    // Правка парсера сама по себе их не касается: INSERT гасит ON CONFLICT,
    // а этот UPDATE трогал только срок и разряд — «я же починил» не доходило
    // бы до сопок ещё пять суток паводковой сводки.
    //
    // Переписывается ТОЛЬКО строка с подписью старого дефолта, и только если
    // классификатор сегодня даёт другое. Легитимная Авачинская (Елизово,
    // Петропавловск, Мутновский названы) даёт ['avachinsky'] снова — не
    // трогается. Общее «всегда перезаписывать зоны» здесь нельзя по той же
    // причине, что и понижение разряда: сломанный регэксп сузил бы зону
    // молча, в сторону тишины.
    const dup = await query(
      `UPDATE external_alerts
       SET expires_at = GREATEST(external_alerts.expires_at, $4),
           severity = GREATEST(external_alerts.severity, $5),
           affected_zones = CASE
             WHEN external_alerts.affected_zones = ARRAY['avachinsky']::text[]
              AND external_alerts.affected_zones IS DISTINCT FROM $6::text[]
             THEN $6::text[]
             ELSE external_alerts.affected_zones
           END
       FROM (
         SELECT id, expires_at, severity, affected_zones
           FROM external_alerts
          WHERE alert_type = $1
            AND regexp_replace(lower(trim(title)), '\\s+', ' ', 'g') = regexp_replace(lower(trim($2)), '\\s+', ' ', 'g')
            AND regexp_replace(lower(trim(COALESCE(description, ''))), '\\s+', ' ', 'g') = regexp_replace(lower(trim(COALESCE($3, ''))), '\\s+', ' ', 'g')
            AND expires_at > NOW()
       ) prev
       WHERE external_alerts.id = prev.id
       RETURNING external_alerts.id,
                 (external_alerts.expires_at IS DISTINCT FROM prev.expires_at) AS extended,
                 (external_alerts.severity IS DISTINCT FROM prev.severity) AS regraded,
                 (external_alerts.affected_zones IS DISTINCT FROM prev.affected_zones) AS rezoned`,
      [event.alert_type, event.title, event.description, expiresAt, event.severity, event.affected_zones]
    );
    if ((dup.rowCount ?? 0) > 0) {
      // Запись только если срок ДЕЙСТВИТЕЛЬНО сдвинулся. Лента отдаёт один и
      // тот же пост каждые пять минут, и `GREATEST` в 287 случаях из 288
      // возвращает прежнее значение: ничего не произошло, писать нечего.
      // Переоценка разряда — событие само по себе, и молчать о нём нельзя:
      // алерт внезапно становится громче (красный статус, пуш), и в журнале
      // должно остаться, ПОЧЕМУ. Пишется даже когда срок не двигался: смена
      // severity — это не «перечитали ленту».
      const regraded = dup.rows[0]?.regraded === true;
      // Смена зон — тоже событие, и громче двух других: алерт перестаёт
      // (или начинает) красить места. В журнале обязано остаться, откуда и
      // куда: без этого «почему сопка позеленела» не находится никогда.
      const rezoned = dup.rows[0]?.rezoned === true;
      if (dup.rows[0]?.extended || regraded || rezoned) {
        await appendSafetyEvent({
          entityId: dup.rows[0]?.id != null ? String(dup.rows[0].id) : null,
          eventType: 'dedup_skipped',
          actorType: 'system',
          actorId: 'seismic-parser.saveEvent',
          payloadHash,
          decisionReason: rezoned
            ? 'контент совпал с активным алертом — зоны старого дефолта avachinsky заменены текущей оценкой классификатора'
            : regraded
              ? 'контент совпал с активным алертом — разряд опасности поднят до текущей оценки классификатора'
              : 'контент совпал с активным алертом — срок действия продлён, новая строка не заведена',
          details: {
            extended_expires_at: expiresAt.toISOString(),
            ...(regraded ? { regraded_to_severity: event.severity } : {}),
            ...(rezoned ? { rezoned_from: ['avachinsky'], rezoned_to: event.affected_zones } : {}),
          },
        });
      }
      return 'skipped';
    }

    // Тот же САМЫЙ пост, виденный раньше (сверка по external_id, а не по
    // тексту). Сюда попадает всё, чей алерт уже истёк: контентный дедуп выше
    // требует `expires_at > NOW()`, а пост в ленте живёт дольше алерта — и
    // каждые пять минут доходил до INSERT, где его гасил ON CONFLICT.
    // Проверка нужна не ради вставки (её и так держит ON CONFLICT), а ради
    // журнала: перечитать известный пост — не событие.
    const known = await query(
      `SELECT 1 FROM external_alerts WHERE external_id = $1 LIMIT 1`,
      [event.source_id]
    );
    if ((known.rowCount ?? 0) > 0) return 'skipped';

    // Дальше — только НОВЫЙ сигнал, и цепочка пишется целиком.
    const normalized = await appendSafetyEvent({
      entityId: null,
      eventType: 'signal_normalized',
      actorType: 'source',
      actorId: event.source_id,
      sourceUrl: event.source_url,
      sourcePublishedAt: event.published_at,
      payloadHash,
      details: { title: event.title },
    });
    await appendSafetyEvent({
      entityId: null,
      eventType: 'risk_classified',
      actorType: 'system',
      actorId: 'seismic-parser.saveEvent',
      payloadHash,
      priorEventId: normalized.id,
      details: { alert_type: event.alert_type, severity: event.severity, expires_hours: event.expires_hours },
    });
    await appendSafetyEvent({
      entityId: null,
      // Пустые зоны с 17.09 — честный исход mchs_zones/zonesForEpicenter
      // («не установлено»), а не замаскированный дефолт, поэтому его можно
      // и нужно называть своим именем: geo_unmatched. Строка в журнале —
      // единственный след того, что предупреждение никого не красит.
      eventType: event.affected_zones.length > 0 ? 'geo_matched' : 'geo_unmatched',
      actorType: 'system',
      actorId: 'seismic-parser.saveEvent',
      payloadHash,
      priorEventId: normalized.id,
      details: { affected_zones: event.affected_zones },
    });

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

    const inserted = (result.rowCount ?? 0) > 0;
    await appendSafetyEvent({
      entityId: inserted && result.rows[0]?.id != null ? String(result.rows[0].id) : null,
      eventType: inserted ? 'published' : 'dedup_skipped',
      actorType: 'system',
      actorId: 'seismic-parser.saveEvent',
      payloadHash,
      priorEventId: normalized.id,
      decisionReason: inserted ? undefined : 'external_id уже существует (ON CONFLICT DO NOTHING)',
      details: {},
    });

    return inserted ? 'inserted' : 'skipped';
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
        const status = await saveQuakeOnce(event);
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
  // USGS FDSN: M4.0+ в радиусе 500 км от ПКО (53.01°N, 158.65°E).
  //
  // Порог был 5.0, пока диапазон M4–4.9 давал канал EQKam. Канал замолчал,
  // а таблица emsd.ru, поставленная ему на смену, на проде не разобралась
  // (проба 573, 24.09: страница пришла, заголовка таблицы в ней нет). Итог —
  // радар без единой точки при живой ленте: три толчка за двое суток, все без
  // координат. USGS отдаёт координаты всегда, и M4 у Камчатки он видит.
  // Пересечение с emsd.ru, когда тот заработает, гасит saveQuakeOnce по
  // физике толчка — второго предупреждения не будет.
  const url =
    'https://earthquake.usgs.gov/fdsnws/event/1/query' +
    `?format=geojson&minmagnitude=4.0&latitude=${PETROPAVLOVSK.lat}&longitude=${PETROPAVLOVSK.lng}` +
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
      const severity: 0 | 1 | 2 | 3 = severityForMagnitude(mag);

      // Зона по РАССТОЯНИЮ, а не по делению координат пополам. Прежний код
      // привязывал событие в 450 км от ближайшего маршрута так же уверенно,
      // как в двадцати, и пустого исхода не имел вовсе. Разбор — в
      // lib/services/safety/seismic-zones.
      const zones: string[] = zonesForEpicenter(lat, lng);

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
      // Тот же толчок уже мог прийти от emsd.ru (с 24.09 он покрывает и M5+).
      // saveQuakeOnce сверяет по физике: кто пришёл вторым — не пишет.
      try {
        const status = await saveQuakeOnce(event);
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

// ── Один толчок — одно предупреждение, сколько бы агентств о нём ни сообщили ─
//
// Контент-дедуп saveEvent сравнивает ЗАГОЛОВКИ. Для сводок МЧС это верно, для
// землетрясений — нет: USGS пишет «M5.1 — 94 km SE of Petropavlovsk», КФ ЕГС —
// «ML 5.2 — 88 км от Петропавловска-Камчатского», и это один толчок, у которого
// разные агентства дали разные решения. По заголовку — два предупреждения и,
// с M5, два пуша туристу.
//
// Пока сейсмика шла из EQKam (M<5) и USGS (M5+), диапазоны не пересекались и
// дубль был невозможен. С 24.09 таблица emsd.ru покрывает всё от Ml 4 — и
// пересечение с USGS появилось в тот же день, что и источник.
//
// Сверка — по физике события: время очага, место, магнитуда.
//
//  ±30 с — разные агентства дают время очага с расхождением в секунды;
//          30 — с запасом на разные решения, но не на следующий толчок.
//  60 км — разброс эпицентров у разных сетей для одного события: 10–30 км
//          (оперативное и уточнённое решение самого emsd.ru для толчка 21.09
//          стоят в ~10 км друг от друга).
//  Δ ≤ 1 — магнитуды разных шкал (Ml, Mw, mb) у одного события расходятся на
//          доли единицы. Без этого условия афтершок через 20 с после главного
//          толчка в 40 км слился бы с ним и пропал из ленты: сильный афтершок
//          обычно на единицу и больше слабее главного.

/** Окно сверки по времени очага, секунд. */
export const SAME_QUAKE_SECONDS = 30;
/** Окно сверки по расстоянию между эпицентрами, км. */
export const SAME_QUAKE_KM = 60;
/** Наибольшее расхождение магнитуд одного события у разных агентств. */
export const SAME_QUAKE_MAG_DELTA = 1;

/**
 * Найти уже записанное предупреждение о ТОМ ЖЕ толчке от другого источника.
 *
 * Три исхода, и третий отдельный (§4.0):
 *   строка    — нашли: external_id совпавшей записи;
 *   null      — точно нет такого;
 *   'unknown' — проверить не смогли (нет координат, отказ БД).
 *
 * На 'unknown' вызывающий ПИШЕТ. Цена несимметрична, как у аренды окна:
 * лишний дубль стоит второго сообщения, пропущенное землетрясение — того, что
 * турист на склоне о нём не узнает.
 */
export async function findSameQuake(event: SeismicEvent): Promise<string | null | 'unknown'> {
  if (event.lat === undefined || event.lng === undefined || event.magnitude === undefined) {
    return 'unknown';
  }
  try {
    const { rows } = await query<{ external_id: string; lat: number; lng: number; magnitude: number | null }>(
      `SELECT external_id, lat::float8 AS lat, lng::float8 AS lng, magnitude::float8 AS magnitude
         FROM external_alerts
        WHERE alert_type = 'earthquake'
          AND lat IS NOT NULL
          AND lng IS NOT NULL
          AND created_at BETWEEN $1::timestamptz - ($3::int * INTERVAL '1 second')
                             AND $1::timestamptz + ($3::int * INTERVAL '1 second')
          AND external_id IS DISTINCT FROM $2`,
      [event.published_at, event.source_id, SAME_QUAKE_SECONDS],
    );
    for (const r of rows) {
      if (distanceKm(event.lat, event.lng, r.lat, r.lng) > SAME_QUAKE_KM) continue;
      if (r.magnitude !== null && Math.abs(r.magnitude - event.magnitude) > SAME_QUAKE_MAG_DELTA) continue;
      return r.external_id;
    }
    return null;
  } catch (e) {
    // Отказ не глушится: имя проверки и причина — в лог (§4.0).
    console.error('[seismic-parser] findSameQuake: сверка не выполнилась:', (e as Error).message);
    return 'unknown';
  }
}

/**
 * Записать событие, если о ТОМ ЖЕ толчке ещё никто не сообщил. Единственный
 * путь записи землетрясений из источников, которые могут перекрываться.
 *
 * Отдельной функцией, а не строкой в каждом приёме: путей записи землетрясений
 * четыре (USGS, EQKam с сервера, EQKam от раннера, emsd.ru), и сверка, стоящая
 * в трёх из четырёх, работала бы в одну сторону — кто пришёл вторым через
 * четвёртый путь, тот и писал бы дубль. Первая редакция 24.09 так и вышла:
 * EQKam сверки не имел, и толчок, записанный emsd.ru, он повторил бы.
 *
 * Не землетрясения идут в saveEvent напрямую: у сводок МЧС свой, контентный
 * дедуп, и физическая сверка им не нужна.
 */
export async function saveQuakeOnce(event: SeismicEvent): Promise<'inserted' | 'skipped' | 'same_quake'> {
  if (event.alert_type === 'earthquake') {
    const same = await findSameQuake(event);
    if (typeof same === 'string') return 'same_quake';
  }
  return saveEvent(event);
}

// ── КФ ФИЦ ЕГС РАН: таблица землетрясений с главной emsd.ru (24.09) ────────
//
// Решение владельца: «нам нужно переключиться на этот ресурс, tg не активен у
// них». Разбор таблицы — lib/services/safety/emsd-quakes.ts, скачивание —
// emsd-fetch.ts. Здесь — превращение строки в предупреждение ленты по ТЕМ ЖЕ
// правилам, что у остальных источников: важность — severityForMagnitude,
// зоны — zonesForEpicenter, запись — saveEvent.

export interface EmsdIngestResult extends ParseResult {
  /** Что разобралось из таблицы — для ответа heartbeat и разбора. */
  table: EmsdQuakeTable;
  /** Событие уже истекло бы к моменту записи — это история, а не угроза. */
  skippedExpired: number;
  /** Тот же толчок уже записан от другого источника. */
  skippedSameQuake: number;
}

/**
 * Внешний id: время очага до секунды. Уточнённое решение того же события
 * (магнитуда 4.1 → 4.2, время 03:09:36 → 03:09:35.9) попадает на тот же id и
 * гасится ON CONFLICT, а не становится вторым толчком. Дробные секунды
 * отброшены намеренно: они у источника разной длины и меняются при уточнении.
 */
export function emsdQuakeId(timeUtc: string): string {
  return `www.emsd.ru/eq/${timeUtc.replace(/\.\d+Z$/, 'Z')}`;
}

export async function ingestEmsdQuakes(html: string, nowMs: number = Date.now()): Promise<EmsdIngestResult> {
  const table = parseEmsdQuakes(html);
  const result: EmsdIngestResult = {
    events: [],
    inserted: 0,
    skipped: 0,
    // Жалобы разбора — это ОТКАЗЫ источника, и они обязаны сделать прогон
    // частичным, а не раствориться в «вставлено ноль».
    errors: [...table.problems],
    rawItems: table.rows.length,
    table,
    skippedExpired: 0,
    skippedSameQuake: 0,
  };

  for (const q of table.rows) {
    const severity = severityForMagnitude(q.ml);
    const expiresHours = severity >= 2 ? 48 : 24;
    const publishedAt = new Date(q.timeUtc);
    // В таблице десять последних событий, и при спокойной сейсмике они
    // растягиваются на дни. Истёкшее предупреждение — история: писать его
    // значило бы в первый же прогон выпустить в ленту толчки недельной
    // давности как свежие.
    if (publishedAt.getTime() + expiresHours * 3_600_000 < nowMs) {
      result.skippedExpired++;
      continue;
    }

    const distKm = Math.round(distanceKm(PETROPAVLOVSK.lat, PETROPAVLOVSK.lng, q.lat, q.lng));
    const epicenter = `${distKm} км от Петропавловска-Камчатского`;
    const ml = q.ml.toFixed(1);
    const event: SeismicEvent = {
      source_id: emsdQuakeId(q.timeUtc),
      source_url: EMSD_HOME_URL,
      published_at: publishedAt,
      alert_type: 'earthquake',
      severity,
      title: `Землетрясение ML ${ml} — ${epicenter}`,
      description:
        `Ml ${ml}, глубина ${q.depthKm} км, эпицентр ${q.lat}, ${q.lng} — ${epicenter}. ` +
        `Время очага ${q.timeUtc.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC. ` +
        'Источник: КФ ФИЦ ЕГС РАН (emsd.ru).',
      affected_zones: zonesForEpicenter(q.lat, q.lng),
      magnitude: q.ml,
      depth_km: q.depthKm,
      epicenter,
      lat: q.lat,
      lng: q.lng,
      expires_hours: expiresHours,
    };

    result.events.push(event);
    try {
      const status = await saveQuakeOnce(event);
      if (status === 'inserted') result.inserted++;
      else if (status === 'same_quake') result.skippedSameQuake++;
      else result.skipped++;
    } catch (e) {
      result.errors.push((e as Error).message);
    }
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
  // Мильковский округ — центральная долина реки Камчатки, дорога на север.
  // Своей зоны у центра в нашей четвёрке нет; ближайшая по географии и по
  // маршрутам — northern. Появился по циклону 10.08: округ был назван в
  // предупреждении, но в карте отсутствовал, и часть предупреждения уезжала
  // в дефолт `avachinsky` — то есть на чужие маршруты.
  [/мильков/i,      ['northern']],
  // Усть-Большерецкий округ — западное побережье (Охотское море). Появился по
  // сводке 29.07 «дорога мыс Левашова — посёлок Октябрьский в Усть-Большерецком
  // округе»: без строки округ уходил в дефолт `avachinsky`, то есть ограничение
  // на западном берегу вешалось на маршруты Авачинской группы.
  [/усть-большерецк/i,['western']],
  [/алеутск/i,      ['northern']],
  [/карагинск/i,    ['eastern']],
  [/пенжинск/i,     ['northern']],
  [/олюторск/i,     ['eastern']],
  // Соболево — западное побережье. Сводка Минтура 06.08: режим повышенной
  // готовности из-за выхода медведей в село; без строки алерт уезжал в дефолт.
  [/соболев/i,      ['western']],
  // Природные парки: сводки Минтура называют объекты парками, не районами.
  [/налычев/i,      ['avachinsky']],
  // Реки. Паводковые пункты сводок называют реку, а не округ: «разливы на
  // реках Начилова и Большая Быстрая, на Амчигаче …, на Большой Воровской …»
  // (Минтур, 25.09). Без реки в карте такой пункт оставался без зоны и не
  // доходил ни до одного маршрута.
  //
  // Река вносится только с источником её места. Большая Воровская — сводка
  // УГМС 13.09: «на реке Большой Воровской, в районе села Соболево»
  // (tests/unit/hazard-grade.test.ts). Амчигача (в сводках и «Амчагача») и
  // Начилова — слово владельца 25.09: притоки Большой, Усть-Большерецкий
  // район, то есть та же западная зона, что у округа выше. По памяти я
  // относил Амчигачу к Соболевскому — зона совпала бы, а район нет; поэтому
  // река без источника в карту не идёт. Большая Быстрая — слово владельца
  // 25.09 следом: у реки Большой, Усть-Большерецкий район. Вносится ТОЛЬКО
  // полным именем: просто «Быстрая» называют и реку у Эссо (Быстринский
  // округ), и одноимённый шаблон увёл бы её предупреждение не туда.
  // Невнесённая река не ломает ничего: пункт остаётся в ленте без зоны.
  [/воровск/i,      ['western']],
  [/амч[иа]гач/i,   ['western']],
  [/начилов/i,      ['western']],
  [/больш[а-яё]*\s+быстр/i, ['western']],
];

/**
 * Ключи VOLCANO_ZONES стоят в именительном падеже, а в сводках вулкан почти
 * всегда склонён: «к вулкану Мутновскому», «опасность Мутновского»,
 * «на Авачинском». До 17.09 сравнение шло `includes(ключ)` и склонённую форму
 * не видело НИКОГДА — этого не замечали, потому что промах уходил в дефолт
 * `['avachinsky']`, и для Авачинской группы ответ случайно совпадал с верным.
 * Когда дефолт сняли, промах стал виден: тест «matches a volcano name» был
 * зелёным по стечению обстоятельств, а не по работе сопоставителя.
 *
 * Прилагательные (-ий/-ый/-ой) ловятся по основе с любым падежным окончанием;
 * существительные (Шивелуч, Толбачик, Узон) — по вхождению, их косвенные
 * формы содержат именительную. «Крашенинникова» в карте уже в родительном —
 * так пишут сводки.
 */
const VOLCANO_MATCHERS: Array<[RegExp, string[]]> = Object.entries(VOLCANO_ZONES).map(([name, z]) => {
  const adj = name.match(/^(.+?)(ий|ый|ой)$/);
  const src = adj
    ? `${adj[1]}(?:ий|ый|ой|ого|ому|им|ым|ом|ем|ая|ую|ие|ых|их)`
    : name;
  return [new RegExp(src, 'i'), z];
});

export function mchs_zones(text: string): string[] {
  // Название вулкана в тексте — точнее административного района (переиспользуем
  // ту же карту, что и для КБГС РАН, а не только 9 паттернов по районам).
  //
  // ОБЪЕДИНЕНИЕ, а не первый матч: сводка Минтура 06.08 одной строкой не
  // рекомендовала Ключевской, Безымянный, Мутновский, Шивелуч и Крашенинникова —
  // это три зоны (northern, avachinsky, eastern). Первый матч оставлял только
  // northern, и предупреждение о Мутновском не доходило до карточек Авачинской
  // группы.
  const lower = text.toLowerCase();
  const zones = new Set<string>();
  for (const [re, vZones] of VOLCANO_MATCHERS) {
    if (re.test(lower)) vZones.forEach((z) => zones.add(z));
  }
  if (zones.size > 0) return [...zones];
  for (const [re, dZones] of MCHS_DISTRICT_ZONES) {
    if (re.test(text)) dZones.forEach((z) => zones.add(z));
  }
  if (zones.size > 0) return [...zones];
  if (KRAI_WIDE_RE.test(text)) return [...ALL_ZONES];
  // Ни вулкана, ни округа, ни слова «по краю» — зона НЕ УСТАНОВЛЕНА, и это
  // возвращается как есть. До 17.09 здесь стояло `['avachinsky']`: паводок в
  // Соболевском округе (западное побережье, ~300 км) красил в красный
  // смотровые в центре Петропавловска, потому что Соболевского не было в
  // списке округов и «не знаю где» превращалось в «Авачинская». Дважды до
  // того чинили по округу за раз (Усть-Большерецкий 29.07, Мильковский
  // 10.08) — дефолт оставался. Пустой массив — третий исход §4.0: событие
  // сохраняется, видно в общекраевой ленте, в журнал уходит geo_unmatched,
  // но места не красит. Так же с 11.08 живут далёкие землетрясения USGS
  // (seismic-zones.ts); SQL-предикаты в safety-ingest и collect-signals с
  // 17.09 читают пустоту как «никого», а не «всех».
  return [];
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

/**
 * Заголовок для поста без заголовка (ВК, МАХ: весь текст приходит в description).
 *
 * До этого title оставался пустым и уезжал в external_alerts как есть — на
 * карточке маршрута турист видел пустую строку в списке предупреждений. Берём
 * первую фразу: у сводок она и есть суть пункта («На вулкане Шивелуч произошел
 * пепловый выброс»).
 */
export function titleFromText(text: string): string {
  // Ведущие не-буквы снимаем: в постах МЧС строка начинается с булавки или
  // другого значка, и он уезжал в заголовок алерта на главную. Эмодзи в
  // интерфейсе запрещены (CLAUDE.md §4), а «📌К тушению…» именно так и
  // выглядело на экране владельца 07.09. Та же чистка, что у splitSummaryItems.
  const clean = text.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const first = /^[^.!?]{10,200}/.exec(clean)?.[0] ?? clean;
  return first.trim().slice(0, 200);
}

/**
 * Разбор суточной сводки на самостоятельные пункты.
 *
 * Сводка ГУ МЧС — многотемный документ: в одном посте пеплопад на севере,
 * оползни на юге и дорожное ограничение на западе. Классификатор же однотемный
 * (цепочка if/else даёт ОДИН тип, ОДИН severity, ОДНУ зону), и на живой сводке
 * 29.07 это проверено: весь пост схлопывался в `volcanic_eruption` severity 1
 * с зоной первого встреченного вулкана — предупреждение о Мутновском уезжало
 * на северные маршруты, а дорога терялась совсем.
 *
 * Маркер пункта не зашиваем (в коде эмодзи запрещены) — режем по строкам и
 * снимаем любую ведущую не-букву. Строки короче 25 знаков — подписи и период
 * сводки, не темы.
 */
export function splitSummaryItems(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^[^\p{L}\p{N}]+/u, '').trim())
    .filter((l) => l.length >= 25);
}

/**
 * Классификация поста целиком: одна тема — одно событие, сводка — несколько.
 *
 * Разбор включается только для постов БЕЗ заголовка (соцканалы ВК/МАХ, где
 * сводки и живут) и только если пунктов набралось хотя бы три, а разных тем —
 * хотя бы две. Item ленты RSS с заголовком остаётся одним событием: там правило
 * «одно предупреждение — один item» верно, и дробить его — значит вернуть ту
 * самую шестикратную россыпь одного предупреждения, от которой уходили.
 */
/** Сводка Минтура о доступности туристических объектов (kamgov.ru/mintur). */
export function isMinturBulletin(text: string): boolean {
  return /оперативн[а-я]* сводк/i.test(text) && /доступност[а-я]* туристическ/i.test(text);
}

export function classifyMchsItems(
  id: string,
  title: string,
  description: string,
  pubDate: string,
  link: string,
  sourcePrefix: string = MCHS_FEED_PREFIX,
): SeismicEvent[] {
  const whole = classifyMchsItem(id, title, description, pubDate, link, sourcePrefix);

  // Сводка Минтура — многотемный документ С ЗАГОЛОВКОМ: до 06.08 она целиком
  // схлопывалась в одно info-событие severity 0, и «закрыты два маршрута»,
  // «не рекомендуется посещать вулканы …», «медведи в Соболево» до карточек
  // не доходили вовсе (плоское сохранение стояло с пометкой «построчный разбор
  // — следующий шаг, когда накопятся образцы»; второй образец принёс владелец).
  const mintur = isMinturBulletin(`${title} ${description}`);
  if (title.trim() !== '' && !mintur) return whole ? [whole] : [];

  const items = splitSummaryItems(description);
  if (items.length < (mintur ? 2 : 3)) return whole ? [whole] : [];

  // Тема = тип + зоны. Совпали — оставляем строгую: пеплопад с рекомендацией
  // «не приближаться» не должен теряться за нейтральным упоминанием той же горы.
  const byTopic = new Map<string, SeismicEvent>();
  for (const item of items) {
    const ev = classifyMchsItem(id, '', item, pubDate, link, sourcePrefix);
    if (!ev) continue;
    const key = `${ev.alert_type}|${[...ev.affected_zones].sort().join(',')}`;
    const prev = byTopic.get(key);
    if (!prev || ev.severity > prev.severity) byTopic.set(key, ev);
  }

  // У сводки Минтура и ОДНА распознанная угроза ценнее плоского info: пункты
  // «открыто» законно не классифицируются, порог «≥2 темы» здесь не о том.
  if (byTopic.size < (mintur ? 1 : 2)) return whole ? [whole] : [];
  const out = [...byTopic.values()];
  if (mintur) attachRiverBan(items, out);
  return out;
}

/** Запрет сплава по рекам: «сплавы на рафтах … необходимо исключить». */
const RIVER_BAN = /сплав|рафт/;

/**
 * Запрет сплава в сводке Минтура — отдельный пункт, который говорит о реках
 * «зоны предупреждения», то есть о тех, что названы в паводковых пунктах выше.
 * Сам по себе он не называет ни реки, ни явления, и поодиночке ложился бы
 * либо никуда, либо без зоны. Поэтому он прикладывается к паводковым событиям
 * той же сводки: они получают severity 2 и текст запрета в описании — ровно
 * там, где их увидит оператор сплава на карточке маршрута у этой реки.
 *
 * Запрет говорит о реках «зоны предупреждения» — то есть о названных. Поэтому
 * он ложится на паводковые пункты С ЗОНОЙ; пункт без зоны («на отдельных
 * территориях края ожидаются осадки») его получает, только если реки с зоной
 * в сводке нет вовсе — иначе запрет потерялся бы, а так он хотя бы в ленте.
 * Красить все паводковые пункты разом нельзя: красный уровень рассылается
 * пушем, и одна сводка будила бы человека дважды об одном и том же.
 *
 * Паводка в сводке нет — запрету не к чему прикладываться, и события не
 * меняются: выдумывать ему реку нельзя.
 */
function attachRiverBan(items: string[], events: SeismicEvent[]): void {
  const ban = items.find((it) => {
    const t = it.toLowerCase();
    return RIVER_BAN.test(t) && addressesTouristsWithBan(t);
  });
  if (!ban) return;
  const floods = events.filter((ev) => ev.alert_type === 'flood');
  const zoned = floods.filter((ev) => ev.affected_zones.length > 0);
  for (const ev of zoned.length > 0 ? zoned : floods) {
    ev.severity = Math.max(ev.severity, 2) as SeismicEvent['severity'];
    if (!ev.description.includes(ban)) {
      // Обрезается описание, а не запрет: без него весь смысл приложения пропал бы.
      ev.description = `${ev.description.slice(0, Math.max(0, 799 - ban.length))} ${ban}`.trim();
    }
  }
}

/**
 * МЧС обращается прямо к нашей аудитории и велит ей никуда не идти.
 *
 * Это не признак стихии, это признак адресата. «Тургруппам и охотникам —
 * воздержаться от выхода на маршруты» — та самая фраза, ради которой у нас
 * вообще есть слой безопасности, и она одинаково весома под циклоном, под
 * пеплопадом и под паводком. Поэтому проверка живёт отдельно от категорий и
 * поднимает порог любой из них, а не дублируется списком слов внутри каждой.
 *
 * Нужны обе половины — адресат И запрет. Просьба «зарегистрироваться в МЧС»
 * тоже обращена к тургруппам, но угрозой не является и красного статуса не
 * заслуживает.
 */
// Сплав — тоже адресат: «сплавы на рафтах и резиновых лодках по рекам зоны
// предупреждения необходимо исключить» (сводка Минтура 25.09) обращён к тем,
// кого мы возим по рекам, хотя слова «турист» в нём нет.
const BAN_AUDIENCE = /тургрупп|турист|охотник|маломерн|рыбак|восходител|сплав|рафт/;
// Основа, а не словарная форма: список ловил «воздержаться», но не
// «воздержитесь» — то есть прямое повеление МЧС проходило мимо запрета.
// «Не рекомендуется выход на маршруты» — самая частая формула МЧС, и её в
// списке не было: она жила только внутри вулканической ветки. Проверка
// формулировок владельцем 10.08 вскрыла дыру — «выход тургрупп не
// рекомендуется» проходил мимо порога и красным не становился.
// «Исключить» — только инфинитив-повеление той же сводки 25.09. Основа
// «исключ» поймала бы «не исключается сход лавин» (это «возможно», а не
// запрет) и «за исключением».
const BAN_VERB = /воздерж|не рекоменду|не выходить|не выезжать|не выход[аи]|не совершать|не планировать|отказаться от|не подниматься|не приближ|запрещ|не выпускать|не выходите|(?<!не\s)исключить(?![а-яё])/;

/**
 * Разбивка на фразы. Точка внутри «06.00 (кмч)» и «11.08.2026» границей не
 * считается: делим только там, где за знаком идёт пробел или перенос.
 */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;:])\s+|\n+/).filter((s) => s.trim() !== '');
}

/**
 * Источник сам объявил ВЫСШУЮ категорию опасности — «опасное явление» (ОЯ).
 *
 * У Росгидромета две ступени, и они не синонимы: НЯ — неблагоприятное явление,
 * ОЯ — опасное, верхняя, та, что «по интенсивности, продолжительности или
 * времени возникновения может нанести значительный ущерб или угрожать жизни».
 * Когда УГМС пишет «уровень воды может достигнуть опасного явления», это не
 * оборот речи, а термин: агентство назвало свой же высший разряд.
 *
 * Платформа этого термина не знала ВООБЩЕ. Поводом стала сводка 13.09: на реке
 * Большой Воровской у Соболева ожидалось ОЯ с «размывом устоев и опор мостовых
 * переходов» — то есть дорога назад могла исчезнуть. Классификатор разбирал её
 * верно (`flood`, зона `western`) и ставил severity 1, потому что единица
 * прошита в ветку паводка для ВСЕХ паводков сразу — и для весеннего половодья,
 * и для ОЯ. А ниже двойки нет ни пуша, ни красного статуса: предупреждение о
 * смытом мосте уходило тише, чем «сильный ветер», у которого severity 2.
 *
 * Проверка живёт ОТДЕЛЬНО от категорий и поднимает порог любой из них — так же,
 * как соседний запрет тургруппам. Разряд источника одинаково весом под
 * паводком, под циклоном и под пеплопадом, и дублировать его списком слов
 * внутри каждой ветки значило бы завести столько же расходящихся правил.
 *
 * Порог НЕ выдуман мной: он взят из словаря самого источника. Поднимать
 * severity «потому что звучит страшно» здесь нельзя — тогда красным станет
 * всё, и красное перестанет значить что-либо.
 */
/**
 * Границы слова — руками, а не через `\b`.
 *
 * JS `\b` определён на латинице и цифрах, кириллицу за слово не считает, и
 * `\bоя\b` не совпадает НИ С ЧЕМ. В этом файле ловушка описана трижды — на
 * «сел», на «учени», на «паводок», — и я всё равно написал сперва `\bоя\b`,
 * получив молча ложный отрицательный ответ. Молчащая проверка читается как
 * «нарушений нет», и здесь это стоило бы пуша.
 *
 * Левая граница у полной формы нужна не для красоты: без неё `опасного
 * явления` совпадает внутри «неОПАСНОГО ЯВЛЕНИЯ» и «малоопасного», то есть
 * отрицание поднимало бы severity вместо того, чтобы её не трогать.
 *
 * НЯ отдельной проверки не требует, и это следует из самих слов: аббревиатура
 * другая, а «неблагоприятное явление» и «опасное явление» — разные
 * прилагательные, пересечься им негде. Заводить под НЯ исключение значило бы
 * завести код, которому нечего ловить.
 */
//
// Между «опасного» и «явления» допускается одно слово: сводка Минтура 25.09
// писала «уровень, близкий к критерию опасного ГИДРОЛОГИЧЕСКОГО явления», и
// смежная форма разряд не видела. «Неблагоприятного гидрологического явления»
// сюда не попадает: прилагательное другое, левая граница та же.
const HAZARD_GRADE = /(^|[^а-яё])опасн(ое|ого|ым|ом)\s+(?:[а-яё]+\s+)?явлени|(^|[^а-яё])оя(?![а-яё])/;

export function declaresHazardGrade(text: string): boolean {
  for (const phrase of sentences(text.toLowerCase())) {
    // Объяснение термина — не объявление опасности. «Что такое опасное
    // явление» в памятке МЧС не должно красить маршруты в красный.
    if (/что так(ое|ими)|называ(ют|ется)|расшифров|памятк/.test(phrase)) continue;
    if (HAZARD_GRADE.test(phrase)) return true;
  }
  return false;
}

export function addressesTouristsWithBan(text: string): boolean {
  const parts = sentences(text.toLowerCase());
  // Окно в две соседние фразы, а не весь документ.
  //
  // Проверка на весь текст стоила нам 10.08 трети справочника: суточная сводка
  // ЦУКС и репортаж «спасатели окажут помощь тургруппе в наведении переправы»
  // получали severity 2, потому что где-то в длинном теле находилось слово
  // «тургруппе», а совсем в другом месте — «воздержаться». Ловушка задумана под
  // одну фразу — «тургруппам и охотникам воздержаться от выхода на маршруты», —
  // и проверять её надо там же, где она произносится.
  //
  // Окно именно в две фразы, а не в одну: МЧС нередко разносит адресата и
  // запрет по соседним предложениям («Убедительная просьба к тургруппам.
  // Воздержитесь от выхода на маршруты»), и сузить до одной значило бы
  // потерять настоящий запрет — ошибка в опасную сторону.
  for (let i = 0; i < parts.length; i++) {
    const window = i + 1 < parts.length ? `${parts[i]} ${parts[i + 1]}` : parts[i];
    if (BAN_AUDIENCE.test(window) && BAN_VERB.test(window)) return true;
  }
  return false;
}

/**
 * Суточный бюллетень: сводка ЦУКС и ежедневный прогноз ЧС.
 *
 * Оба приходят КАЖДЫЙ ДЕНЬ и оба — многотемные документы, пересказывающие то,
 * что МЧС в тот же день публикует отдельными item'ами. Проба 10.08 это
 * показала прямо: на маршруте висели и «На контроле ЦУКС … по состоянию на
 * 06.00», и по отдельности всё, о чём эта сводка говорит — экстренное
 * метеопредупреждение, риск оползней с Мутновского, классы пожарной опасности,
 * подъём уровней воды. То есть бюллетень не добавляет знания, зато добавляет
 * запрет: он получал severity 2 и делал «Не сегодня» на 144 маршрутах из 421.
 *
 * Ежедневный документ, дающий запрет, — это вечно красный вердикт, а вердикт
 * одного цвета перестают читать. Жанр, а не тема: та же дверь, через которую
 * заходили телеанонс, школьное учение и памятка «при угрозе подтопления».
 */
export function isDailyBulletin(text: string): boolean {
  const lower = text.toLowerCase();
  return /на контроле цукс|оперативн[а-яё]*\s+ежедневн[а-яё]*\s+прогноз|ежедневн[а-яё]*\s+оперативн[а-яё]*\s+прогноз/.test(lower);
}

/**
 * Репортаж о спасательной работе — не предупреждение.
 *
 * «Сводная группировка спасателей окажет помощь тургруппе в наведении
 * верёвочной переправы» — это новость о том, что людям помогают, и она
 * получала severity 2 через ловушку запрета. Опасность в таком тексте уже
 * НАСТУПИЛА и ею уже занимаются; туристу, который завтра идёт в другое место,
 * она ничего не запрещает.
 *
 * Ключ — глагол операции, а не слово «спасатели»: «спасатели рекомендуют
 * соблюдать меры предосторожности» под циклоном — настоящее предупреждение,
 * и оно должно проходить. Поэтому при явном предупреждении или прогнозе
 * рядом текст не отбрасывается.
 */
export function isRescueOperationReport(text: string): boolean {
  const lower = text.toLowerCase();
  const operation = /(окаж[еу]т|оказал[аи]?|оказана|оказыва[ею]т)\s+помощь|(обеспечил[аи]?|обеспечи[тл]и?)\s+безопасност|сопроводил|вывел[аи]?\s+(из|к)\s|спасл[аи]?\s|эвакуирова|деблокирова|(вед[уёе]тся|ведут|ведётся|проводят|организован[аы]?)\s+поиск|подняли на борт|транспортирован|сняли с маршрута/.test(lower);
  if (!operation) return false;
  const alsoWarning = /экстренное предупреждение|штормовое предупреждение|прогнозирует|ожидается|приближает/.test(lower);
  return !alsoWarning;
}

/**
 * Выезд спасателей ВО ВРЕМЯ идущего события — сведение, не отчёт и не тревога.
 *
 * Разбор трёх push о паводке 14.09 (#1861): третьим уведомлением пришло
 * «Камчатские спасатели МЧС России выдвинулись в Соболево…» с заголовком
 * push «Паводок — Камчатка» — хотя из текста не следует никакого действия
 * для туриста, и инструкция под ним («Не пересекайте реки вброд») к этому
 * посту не относится вовсе. `isServiceStatistics` такие посты не ловит:
 * глагол «выдвинулись» не входит в список отчётных (там «привлекался»,
 * «ликвидирован» и т.п. — про СВЕРШИВШЕЕСЯ), и счёта в посте тоже нет.
 *
 * Развилка была за владельцем: жанр можно было либо полностью отбросить, как
 * `isServiceStatistics` (Reading А), либо оставить в ленте /safety, но снять
 * с него тревогу (Reading Б). Решение 14.09 (карт-бланш) — Reading Б: факт о
 * реальности события жальче терять, чем не звонить о нём. Поэтому эта
 * проверка НЕ встаёт в один ряд с `isDailyBulletin`/`isRescueOperationReport`/
 * `isServiceStatistics` в общем `if (...) return null` — она не отбрасывает
 * пост, а обнуляет ему severity уже ПОСЛЕ обычной классификации (см. вызов
 * ниже, после обоих порогов повышения). Обнулённая severity не проходит порог
 * push (`severity >= 2`, app/api/cron/safety-ingest/route.ts) и не поднимает
 * `MAX(severity)` в `getCurrentSafetyStatus` — но строка остаётся в
 * `external_alerts` и видна в полном списке `/api/safety/alerts`.
 *
 * `alsoWarning` — тот же приём, что у `isRescueOperationReport`: если В ТОМ
 * ЖЕ посте есть собственный прогноз/запрет, это уже не просто сведение о
 * выезде, и обнулять тревогу нельзя.
 */
const RESCUER_SUBJECT = /спасател|сводн[а-яё]*\s+группировк|мчс|цукс/;
// Граница слова руками, не через `\b` — он не видит кириллицу (урок этого
// файла повторён трижды выше на «сел», «оя», «дважды»).
const DISPATCH_VERB = /(^|[^а-яё])(выдвин[а-яё]*|направлен[а-яё]*|прибыл[а-яё]*|разв[её]рнут[а-яё]*)(?![а-яё])/;

export function isRescuerDispatchUpdate(text: string): boolean {
  const lower = text.toLowerCase();
  if (!RESCUER_SUBJECT.test(lower)) return false;
  if (!DISPATCH_VERB.test(lower)) return false;
  const alsoWarning = /экстренное предупреждение|штормовое предупреждение|прогнозирует|ожидает|приближает|не рекоменду|воздерж|запрещ|не выходить|не выезжать/.test(lower);
  return !alsoWarning;
}

/**
 * Отчётная статистика службы — не предупреждение.
 *
 * Экран владельца 07.09: на главной, в блоке тревог, висели две строки —
 * «К тушению техногенных пожаров сотрудники МЧС России привлекались один раз»
 * (5 сентября) и «…два раза» (4 сентября). Это отчёт ведомства о собственной
 * работе за прошедшие сутки: он не называет ни места, ни времени впереди, ни
 * действия для человека. Турист читает его как угрозу — потому что стоит он
 * там, где стоят угрозы.
 *
 * Прежние жанровые фильтры (телеанонс, учение, памятка, суточный бюллетень,
 * репортаж о спасработах) эту форму не ловили: пост целиком отбрасывался как
 * бюллетень, но разбор сводки на пункты классифицирует КАЖДУЮ строку заново,
 * и статистическая строка проходила все проверки.
 *
 * Признак жанра — сочетание: глагол о свершившемся + СЧЁТ. «Привлекались один
 * раз», «зарегистрировано 3 пожара», «совершено 12 выездов». Настоящее
 * событие счёта не несёт: «произошёл пожар на базе отдыха» проходит дальше,
 * как и должно. И если рядом стоит взгляд вперёд или обращение к людям
 * («ожидается», «не рекомендуется», «закрыт»), текст не отбрасывается: это уже
 * не отчёт.
 */
const COUNT_WORD = '(?:\\d+|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)';

/**
 * Границу слова здесь пишем руками, а `\b` не используем ВОВСЕ.
 *
 * `\w` в JavaScript — это `[A-Za-z0-9_]`, кириллица в него не входит. Значит
 * между пробелом и «н» границы слова НЕТ, и `/\bне\s/` не совпадает никогда:
 * выражение выглядит рабочим, читается как рабочее и молча не срабатывает.
 * Здесь это уже стоило прогона — `/\bдважды\b/` в счётчике не совпал ни разу
 * с самого написания.
 *
 * Отсюда идиома `(?:^|[^\p{L}])` … `(?![\p{L}])` с флагом `u`: буква любого
 * алфавита, а не латиница.
 */
const WORD_TWICE = /(?:^|[^\p{L}])(?:дважды|трижды)(?![\p{L}])/u;

/** Отрицание при том же глаголе отчёта: «не привлекались», «не выявлено». */
const NEGATED_COUNT = /(?:^|[^\p{L}])не\s+(?:привлекал|зарегистрирован|выявлен|допущен|произошл|пострадал|обнаружен|потребовал)/u;

export function isServiceStatistics(text: string): boolean {
  const lower = text.toLowerCase();

  // Глаголы отрицаемой формы входят сюда же: «не выявлено» — такой же отчёт,
  // как «выявлено 3 нарушения», и список прошедшего времени обязан покрывать
  // оба, иначе отрицание проверялось бы там, куда его не пускает первый шаг.
  const past = /привлекал[аиось]+|совершен[оы]|зарегистрирован[оы]?|ликвидирован[оы]?|потушен[оы]?|произошл[ои]|выполнен[оы]|спасен[оы]|обследован[оы]|выявлен[оы]?|допущен[оы]?|обнаружен[оы]?|пострадал[аио]*|потребовал[аось]*/.test(lower);
  if (!past) return false;

  const counted = new RegExp(
    `(?:${COUNT_WORD})\\s*раз|раз[а]?\\s*(?:${COUNT_WORD})|(?:${COUNT_WORD})\\s*(?:пожар|происшеств|выезд|дтп|человек|очаг)`,
    'i',
  ).test(lower) || WORD_TWICE.test(lower);

  // Ноль тоже счёт. 07.09 владелец прислал снимок главной, где рядом со
  // строкой «привлекались один раз» стояла её близнец «…сотрудники МЧС
  // России НЕ привлекались»: та же сводка, тот же жанр, тот же день — и
  // мимо стража, потому что числа в ней нет вовсе.
  //
  // Требовать число значило бы ловить отчёт о работе и пропускать отчёт о
  // её отсутствии, хотя второй ещё дальше от предупреждения, чем первый:
  // он сообщает, что не случилось НИЧЕГО. Отрицание при том же глаголе —
  // такой же счёт, просто нулевой.
  const negatedCount = NEGATED_COUNT.test(lower);
  if (!counted && !negatedCount) return false;

  // Взгляд вперёд или обращение к человеку — это уже не отчёт.
  const forward = /ожидает|прогнозирует|объявлен[оы]?\s+(штормовое|экстренное)|не рекомендуется|запрещ|закрыт|ограничен|соблюдайте|воздержитесь|эвакуируйтесь/.test(lower);
  return !forward;
}

/**
 * Гидрометеорологическое предупреждение: циклон, ливень, метель, гололёд.
 *
 * Категории у этой опасности не было вовсе — из четырёх погодных веток
 * классификатора существовала одна, про ветер. Циклон 10.08 с «очень сильным
 * дождём» и прямой командой тургруппам не выходить на маршруты не подошёл ни
 * под одну ветку и был отброшен молча: `classifyMchsItems` вернул пустой
 * список, и предупреждение не доехало ни до ленты, ни до пуша, ни до Кузьмича.
 *
 * Прогноз, а не отчёт: требуется либо глагол ожидания, либо обращение к людям.
 * Иначе «циклон покинул полуостров, последствия устранены» повесило бы
 * предупреждение на сутки после того, как всё кончилось.
 */
export function isHydrometWarning(text: string): boolean {
  const lower = text.toLowerCase();
  const phenomenon =
    /циклон|ливн|очень сильн|сильн[а-яё]*\s+(дожд|снег|метел|осадк)|шквал|метел|гололёд|гололед|гололедиц|снегопад|налипани[ея] (мокрого )?снега|штормово[а-яё]* предупрежд|неблагоприятн[а-яё]* (метео|погодн)/.test(lower);
  if (!phenomenon) return false;
  const forecast = /прогнозирует|ожидает|приближает|сохранит|продолжит|усилит|объявлен|предупрежда/.test(lower);
  return forecast || addressesTouristsWithBan(lower);
}

export function classifyMchsItem(
  id: string,
  title: string,
  description: string,
  pubDate: string,
  link: string,
  sourcePrefix: string = MCHS_FEED_PREFIX,
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

  // Памятка — не тревога. МЧС регулярно публикует инструкции «что делать при
  // угрозе X»: собрать аварийный комплект, поднять вещи на верхние этажи,
  // вывести скот. Пост владельца 10.08 ровно такой.
  //
  // Отличает памятку не тема, а наклонение: она про гипотезу («ПРИ угрозе
  // подтопления»), а тревога — про случай, у которого есть время и место.
  // Поэтому проверяется начало текста: условный зачин стоит в первой фразе,
  // тогда как в настоящем предупреждении там стоит явление.
  //
  // Без этой ветки памятка про подтопление уехала бы категорией `flood` на
  // 120 часов и пять суток висела бы активной угрозой на карточках маршрутов —
  // ровно как когда-то висел телеанонс и школьное учение.
  if (/^[\s\S]{0,80}?(при\s+(угрозе|получении|объявлении|обнаружении)|что делать (при|если|в случае)|как действовать|памятка)/.test(text)) {
    return null;
  }

  // Суточный бюллетень и репортаж о спасработах — тоже жанры, а не угрозы.
  // Найдены переписью вердиктов 10.08: вместе они давали «Не сегодня» на 144
  // маршрутах из 421, причём всё содержательное из бюллетеня приходит тем же
  // фидом отдельными предупреждениями. Подробности — у функций.
  if (isDailyBulletin(text) || isRescueOperationReport(text) || isServiceStatistics(text)) {
    return null;
  }

  let alert_type: SeismicEvent['alert_type'] = 'info';
  let severity: 0 | 1 | 2 | 3 = 0;
  let expires_hours = 24;

  // Статус цунами — общим правилом (tsunamiStatus), а не «есть слово —
  // тревога»: иначе «угрозы цунами нет» становилось тревогой цунами. «Угрозы
  // нет» проходит дальше по веткам — у такого поста обычно нет другой
  // категории, и он отбрасывается как неинтересный.
  const tsunami = tsunamiStatus(text);
  if (tsunami === 'warning') {
    alert_type = 'tsunami_warning'; severity = 3; expires_hours = 12;
  } else if (tsunami === 'all_clear') {
    alert_type = 'info'; severity = 0; expires_hours = 1;
  } else if (/лавин/.test(text)) {
    // Лавины — ДО погодной ветки, а не после: лавинное предупреждение МЧС
    // почти всегда идёт вместе с метелью и сильным ветром, и ветка «ураган |
    // сильный ветер» забрала бы его себе как `weather` с инструкцией про
    // ветер. Человеку на склоне нужна другая: «не выходите на склоны и под
    // них» — она давно написана в push-copy.ts, но до 10.09 не срабатывала
    // ни разу, потому что тип `avalanche` был объявлен в feed-types и в
    // push-copy, а производил его никто. Разведданная #1428 «лавинные
    // предупреждения» оказалась не идеей, а проводом, который никуда не
    // подключён (§4.0: объявленный исход без источника).
    //
    // Severity 2 без оговорок: лавинная опасность объявляется ровно для тех,
    // кто идёт по склонам, то есть для нашего туриста, и ниже двойки нет ни
    // пуша, ни красного статуса. 72 часа — лавиноопасный период МЧС
    // объявляет на несколько суток и переиздаёт; сутки, как у погоды, дали
    // бы дыру между переизданиями.
    alert_type = 'avalanche'; severity = 2; expires_hours = 72;
  } else if (/ураган|смерч|шторм.{0,20}(балл|ветер)|сильный ветер/i.test(text)) {
    // Тип был `info` — а лента безопасности на главной пускает только
    // actionable-типы, и `info` в белый список не входит. То есть штормовое
    // предупреждение классифицировалось, сохранялось и не показывалось никому.
    alert_type = 'weather'; severity = 2; expires_hours = 24;
    // Основы слов, а не словарные формы. МЧС пишет «возможны подтоплениЯ
    // дорог» и «ожидается паводОК», а список ловил ровно одну форму каждого
    // слова: памятка владельца 10.08 про подтопление дворов не подошла ни под
    // одну ветку именно из-за окончания. Беглая «о» в паводке — отдельным
    // вариантом, основы «паводк» ей мало.
    //
    // Сводка Минтура 25.09 говорила о воде тремя оборотами, и ни один не
    // подходил: «подъём уровнЕЙ воды» (список знал только «уровень»),
    // «разливы на реках» и «неблагоприятное / опасное гидрологическое
    // явление». Из пяти пунктов сводки до ленты доехали одни медведи, а
    // паводок на четырёх реках и запрет сплавов потерялись целиком. «Разлив»
    // — только при реке: «разлив нефтепродуктов» к паводку отношения не имеет.
  } else if (/павод(ок|к)|половодь|подтоплен|уровн[а-яё]*\s+вод[ыа]|реках.*ожидается|разлив[а-яё]*\s+(?:на\s+)?(?:рек|р\.)|гидрологическ[а-яё]*\s+явлени/i.test(text)) {
    alert_type = 'flood'; severity = 1; expires_hours = 120;
  } else if (isHydrometWarning(text)) {
    // Погодное окно короткое по своей природе: МЧС даёт предупреждение на
    // ночь или на сутки и переиздаёт его, если явление затянулось. Держать
    // такое трое суток — значит показывать туристу вчерашний циклон.
    alert_type = 'weather'; severity = 1; expires_hours = 24;
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
  } else if (/медвед/.test(text) && /выход|вышел|вышли|замечен|населённ|населен|повышенн[а-яё]* готовност/.test(text)) {
    // Медведи у людей — камчатская опасность номер один. До 10.09 ветка
    // отдавала `info` со severity 1: сводка Минтура 06.08 («в с. Соболево
    // режим повышенной готовности в связи с выходом медведей») доезжала до
    // карточек маршрутов — и больше никуда. `info` не входит в ленту
    // безопасности, пуша ниже двойки нет, а инструкция для медведей, давно
    // написанная в lib/safety/alert-guidance.ts (`bear:`), по типу `info`
    // не подключалась. Потребители были, производитель отдавал не тот тип —
    // тот же провод в никуда, что у лавин (#1763). Живой случай — дайджест
    // 10.09: режим повышенной готовности в Петропавловске (#1792).
    //
    // Severity: официальный РЕЖИМ повышенной готовности — 2 (это решение
    // властей о территории, а не одиночная встреча; ниже двойки нет ни пуша,
    // ни красного статуса). Одиночный выход или «замечен» — 1: карточка
    // предупредит, будить пушем весь район из-за одного зверя не надо.
    alert_type = 'bear';
    severity = /повышенн[а-яё]* готовност/.test(text) ? 2 : 1;
    expires_hours = 72;
  } else if (
    /вулкан/.test(text) &&
    // «не рекомендуется посещать вулканы …» и «передвижение в районах вулканов
    // крайне небезопасно» (сводка Минтура 06.08) — прямые предостережения без
    // слова про извержение; раньше такие строки отбрасывались.
    /газопепловый выброс|пепловый выброс|пепловое облако|извержени|оползн|обвал|восхождени|сейсмическ|землетрясен|не рекоменду|небезопасн|воздержаться/.test(text)
  ) {
    // Раньше такие бюллетени (напр. "воздержаться от восхождения на Мутновский —
    // газопепловый выброс, землетрясения в постройке, оползни/обвалы") молча
    // отбрасывались — из 4 категорий (цунами/шторм/паводок/пожар) ни одна не
    // покрывала вулканическую опасность конкретной горы. Явная рекомендация
    // МЧС избегать места — severity 2 (red в recommender_status), иначе 1.
    alert_type = 'volcanic_eruption';
    // «не приближаться» добавлено по сводке 29.07: «Сохраняется риск схода
    // оползней и обвалов с вулкана Мутновского. Спасатели настоятельно
    // рекомендуют не приближаться к исполину» давало severity 1 — то есть ни
    // красного статуса в recommender_status, ни пуша (порог 2). Прямее
    // сформулировать запрет невозможно, а список ловил только «не рекомендует».
    severity = /воздержаться|не рекомендует|не совершать|избегать|не приближ|не подход|опасн/.test(text) ? 2 : 1;
    // Запрет из недельной сводки Минтура (kamgov) живёт до следующего выпуска —
    // 168ч, как соседняя пожарная ветка того же документа, а не 48. Иначе
    // «не рекомендуется посещать» гаснет через двое суток и статус места
    // возвращается в зелёный посреди недели, хотя рекомендация не отзывалась
    // (issue #1985: Мутновский зелёный при живой рекомендации Минтура).
    // Оперативные каналы МЧС (t.me/vk/max) объявляют по факту события и
    // переиздаются чаще — там короткое окно 48ч остаётся прежним.
    expires_hours = severity >= 2 ? (sourcePrefix === 'kamgov' ? 168 : 48) : 24;
  } else if (
    // Сход грунта БЕЗ вулкана: сель, оползень, камнепад, обвал породы. Ветка
    // стоит ПОСЛЕ вулканической намеренно — «оползни и обвалы с вулкана
    // Мутновского» остаются `volcanic_eruption`, как и были (там своя логика
    // severity и свои тесты). Тот же случай, что с лавинами выше: тип
    // `landslide` объявлен, инструкция «обойдите склон, не вставайте лагерем
    // под ним» написана, производителя не было.
    //
    // «Сел» — с границами слова руками: JS \b кириллицу не знает, а голое
    // «сел» в тексте МЧС встречается в каждом втором предупреждении —
    // «СЕЛьское поселение», «СЕЛо Соболево». Ловим только формы слова «сель».
    /(^|[^а-яё])сел(ь|и|ей|ем|ев(ой|ые|ых|ого|ая))(?![а-яё])|оползн|камнепад|обвал[а-яё]*\s+(грунт|пород|склон|скал)/.test(text)
  ) {
    alert_type = 'landslide';
    severity = 1;
    expires_hours = 72;
  } else {
    return null; // не интересно
  }

  // Порог поверх категорий: прямой запрет тургруппам выходить на маршрут — это
  // severity 2 независимо от стихии. Ниже двойки нет ни пуша, ни красного
  // статуса, то есть предупреждение адресовано ровно нашему туристу и ровно им
  // не будет увидено. Вулканическая ветка уже делала это у себя; вынесено
  // наружу, чтобы не переписывать одну и ту же мысль в каждой новой ветке.
  //
  // Вместе с порогом — потолок срока: запрет живёт часами, а не неделей.
  // Пожарная ветка держит алерт 168 часов, и без потолка «туристам воздержаться
  // от посещения леса» висело бы красным всю неделю после того, как выгорело.
  if (severity < 2 && addressesTouristsWithBan(text)) {
    severity = 2;
    expires_hours = Math.min(expires_hours, 48);
  }

  // Второй порог поверх категорий: источник назвал свой ВЫСШИЙ разряд.
  //
  // Срок здесь НЕ укорачивается, в отличие от запрета выше. Запрет живёт
  // часами — его снимают отдельным сообщением; ОЯ живёт столько, сколько живёт
  // само явление, и паводковые 120 часов поставлены именно под него. Обрезав
  // их до 48, мы сняли бы красный статус с ещё не спавшей воды.
  if (severity < 2 && declaresHazardGrade(text)) {
    severity = 2;
  }

  // #1861, Reading Б (решение владельца, карт-бланш 14.09): выезд спасателей
  // во время идущего события — не тревога. Стоит ПОСЛЕ обоих порогов выше:
  // собственный запрет тургруппам или объявленный разряд ОЯ в том же посте
  // главнее и этой строкой не отменяется (isRescuerDispatchUpdate уже
  // исключает такие тексты своей проверкой alsoWarning, но двойная защита
  // дешева). alert_type и title остаются как есть — пост виден в ленте, а не
  // выдаёт себя за неопознанный.
  if (isRescuerDispatchUpdate(text)) {
    severity = 0;
  }

  const publishedAt = new Date(pubDate);
  if (isNaN(publishedAt.getTime())) return null;

  // У постов ВК и МАХ заголовка нет — весь текст приходит в description. Пустой
  // title означал две поломки сразу, обе проверены запуском классификатора:
  //   1. titleFingerprint('') — константа, значит ВСЕ посты канала получали один
  //      external_id ('vk_mchs/t45h'). Первый пост в истории вставился, каждый
  //      следующий уходил в ON CONFLICT DO NOTHING. Канал сводок был мёртв.
  //   2. Пустой заголовок уезжал в active_alerts пустой строкой на карточках.
  // Отсюда — заголовок из первой фразы и отпечаток по нему же.
  const hadTitle = title.trim() !== '';
  const effectiveTitle = hadTitle ? title : titleFromText(description);

  // Датированный ключ для постов соцканалов: суточная сводка повторяет
  // действующую опасность каждый день, а недатированный отпечаток пустил бы её
  // ровно один раз — после истечения expires_at предупреждение исчезло бы
  // навсегда. Тот же приём, что у пожарных термоточек FIRMS: «пожар всё ещё
  // горит» — новость, а не дубль. Для RSS ключ прежний: там дедуп по заголовку
  // как раз и лечил шестикратную россыпь одного предупреждения.
  const day = publishedAt.toISOString().slice(0, 10);

  return {
    // Дедуп по СОДЕРЖАНИЮ, не по guid: RSS перепубликует одно предупреждение
    // с новыми id, и «Экстренное предупреждение на 16-20 июля» вставлялось
    // шестью строками (скрины владельца 2026-07-17). Одинаковый нормализованный
    // заголовок → одинаковый external_id → ON CONFLICT DO NOTHING.
    source_id:     hadTitle
      ? `${sourcePrefix}/t${titleFingerprint(effectiveTitle)}`
      : `${sourcePrefix}/${day}/t${titleFingerprint(effectiveTitle)}`,
    source_url:    link || 'https://41.mchs.gov.ru',
    published_at:  publishedAt,
    alert_type,
    severity,
    title:         effectiveTitle.slice(0, 200),
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

export function parseMchsItems(xml: string): Array<{ id: string; title: string; link: string; pubDate: string; desc: string }> {
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
    // Тело предупреждения у МЧС лежит НЕ в description.
    //
    // Проба фида 10.08, раздел «Штормовые и экстренные предупреждения»:
    //   <title>Экстренное предупреждение на 11 августа 2026 г.
    //          (опасное метеорологическое явление)</title>
    //   <description></description>          ← пусто
    //   <yandex:full-text>&lt;p&gt;К берегам Камчатки приближается
    //          охотоморский циклон… Туристическим группам…&lt;/p&gt;
    //
    // То есть мы читали заголовок без текста: «экстренное предупреждение на
    // 11 августа» без единого слова о том, что за явление, где и кому. Из 40
    // элементов фида классифицировались 5 — остальные приходили пустыми не
    // потому, что там нечего сказать, а потому, что мы смотрели не в тот узел.
    // Именно так потерялся циклон, о котором МЧС писала прямым текстом:
    // «повышена вероятность пропажи, травмирования и гибели людей вне
    // населённых пунктов, осуществляющих туристическую деятельность».
    //
    // content:encoded — тот же приём в обычных RSS; берём и его.
    const desc = get('description')
      || textFromEscapedHtml(get('yandex:full-text'))
      || textFromEscapedHtml(get('content:encoded'));
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
        // Множественная форма: обычный item остаётся одним событием, а
        // многотемная сводка (Минтур) разбирается построчно — 07.08 владелец
        // поймал, что фидовый путь звал единственную форму и разбор сводки
        // не срабатывал вовсе.
        for (const event of classifyMchsItems(it.id, it.title, it.desc, it.pubDate, it.link)) {
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

/**
 * Префикс `external_id` у лент, которые классифицирует classifyMchsItem без
 * своего префикса (RSS МЧС). Вынесен, чтобы перепись форм id в
 * alert-origin.test.ts читала его из кода, а не из головы.
 */
export const MCHS_FEED_PREFIX = 'mchs';

/**
 * Префиксы `external_id` соцканалов МЧС (VK и MAX). До 25.09 стояли строками
 * прямо в вызовах classifyMchsItems, и перепись форм id их не видела: сверка
 * MCP того дня нашла верхнюю тревогу — паводок у Соболево из VK — подписанной
 * «источник не записан». Правило происхождения ждало `vk.com/mchs_kamchatka/`,
 * а в базу уходил `vk_mchs/<день>/t…`.
 */
export const VK_MCHS_PREFIX = 'vk_mchs';
export const MAX_MCHS_PREFIX = 'max_mchs';

const NEWS_FEED_SOURCES: Array<{ prefix: string; candidates: string[]; optional?: boolean }> = [
  // С сервера НЕ тянется: оба вызывающих (heartbeat-GET в ingestAll и POST в
  // route.ts) передают skipPrefixes ['kamgov'] — kamgov.ru с Timeweb закрыт,
  // и попытка отсюда каждые пять минут была не проверкой, а шумом. Живой путь
  // — XML от раннера через ingestNewsFeedXmls. Сторож: kamgov-runner-only.
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

/**
 * Все префиксы `external_id`, которые новостные ленты пишут через
 * classifyMchsItem: РСС МЧС и каждый источник из NEWS_FEED_SOURCES. Перепись
 * для alert-origin.test.ts — новая лента здесь без правила происхождения
 * в lib/safety/alert-origin.ts делает тот тест красным (случай 18.09:
 * visitkamchatka писал тревоги, а статус подписывал их «источник не записан»).
 */
export const NEWS_FEED_PREFIXES: readonly string[] = [
  MCHS_FEED_PREFIX,
  ...NEWS_FEED_SOURCES.map((s) => s.prefix),
];

/**
 * @param skipPrefixes источники, которые уже принесены снаружи (раннером) —
 *   их не тянем с сервера и, главное, не считаем недоступными. Живой случай:
 *   kamgov.ru с Timeweb не открывается, и каждый прогон писал в ошибки
 *   «news feed unavailable: kamgov», хотя фид жив — просто не с нашего IP.
 */
export async function ingestNewsFeeds(skipPrefixes: string[] = []): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };

  for (const source of NEWS_FEED_SOURCES) {
    if (skipPrefixes.includes(source.prefix)) continue;
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
        // Множественная форма: сводка Минтура разбирается построчно (07.08).
        for (const event of classifyMchsItems(it.id, it.title, it.desc, it.pubDate, it.link, source.prefix)) {
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
  }

  return result;
}

/**
 * Разбор новостного RSS, скачанного НЕ сервером, а GitHub-раннером.
 *
 * kamgov.ru недоступен с хостинга (Timeweb) — тот же случай, что t.me и
 * КБГС РАН: фид живой, но не с нашего IP. Раннер тянет XML и передаёт его в
 * теле POST, сервер только разбирает. Классификация та же самая, поэтому
 * дорожные ограничения и вулканические бюллетени из kamgov попадают в
 * external_alerts наравне с остальными источниками.
 */
export async function ingestNewsFeedXmls(xmls: string[], prefix: string): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };
  // Разные пути гос-сайта бывают алиасами одного фида — дедуп по содержимому.
  for (const xml of [...new Set(xmls.filter((x) => x && x.trim().length > 0))]) {
    for (const it of parseMchsItems(xml)) {
      // Множественная форма: именно этим путём (раннер → kamgov XML) приходит
      // сводка Минтура — одиночная форма схлопывала её в один info (07.08).
      for (const event of classifyMchsItems(it.id, it.title, it.desc, it.pubDate, it.link, prefix)) {
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
      // Множественная форма: суточная сводка несёт несколько тем сразу, и
      // каждая должна попасть на свои маршруты со своей зоной. Для RSS ниже
      // остаётся одиночная — там один item и есть одно предупреждение.
      for (const event of classifyMchsItems(id, '', text, pubDate, link, VK_MCHS_PREFIX)) {
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
    // classifyMchsItems вернёт пустой массив для мусора — это и есть сортировка,
    // и она же разбирает суточную сводку на самостоятельные темы.
    for (const event of classifyMchsItems(id, '', text, pubDate, link, MAX_MCHS_PREFIX)) {
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
    // kamgov с хостинга не открывается (гео, см. шапку ingestNewsFeedXmls) —
    // тянуть его с сервера значит писать «news feed unavailable: kamgov» в
    // каждый heartbeat и держать статус прогона вечно partial. Его приносит
    // раннер XML'ом; здесь — только visitkamchatka (optional).
    ingestKbgsras(), ingestEqkam(), ingestUsgs(), ingestMchsAlerts(), ingestNewsFeeds(['kamgov']), ingestVkMchs(),
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
        const status = await saveQuakeOnce(event);
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
