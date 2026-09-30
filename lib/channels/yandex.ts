/**
 * Yandex Channel — YML-фид для Яндекс.Услуги и Яндекс.Путешествия
 *
 * Формат: YML (Yandex Market Language), расширенный для услуг.
 * Яндекс.Услуги читает этот фид и показывает туры в поиске Яндекса.
 *
 * Регистрация:
 *   1. Яндекс.Услуги → Добавить услугу → XML-выгрузка
 *      URL: https://vedarai.ru/api/channels/yandex/feed
 *   2. Яндекс.Путешествия (экскурсии) → partner.yandex.ru/travel
 *      Тип: активности / экскурсии
 *
 * Обновление: Яндекс перечитывает фид раз в 24 часа.
 */

import { priceLine, priceUnitPhrase } from '@/lib/channels/price-line';
import type { ChannelTour } from './types';
import { stripTags } from '@/lib/html/text';
import { absoluteUrl } from './avito';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

// ── Категории (activity_type → YML category) ──────────────────────────────

const CATEGORY_MAP: Record<string, { id: string; name: string; parentId: string }> = {
  trekking:      { id: '11', name: 'Треккинг и пешие походы', parentId: '1' },
  fishing:       { id: '12', name: 'Рыбалка',                  parentId: '1' },
  helicopter:    { id: '13', name: 'Вертолётные туры',         parentId: '1' },
  bear_watching: { id: '14', name: 'Наблюдение за медведями',  parentId: '1' },
  thermal:       { id: '15', name: 'Термальные источники',     parentId: '1' },
  boat_trip:     { id: '16', name: 'Морские прогулки',         parentId: '1' },
  snowmobile:    { id: '17', name: 'Снегоходные туры',         parentId: '1' },
  jeep:          { id: '18', name: 'Джип-туры',                parentId: '1' },
  eco:           { id: '19', name: 'Экотуризм',                parentId: '1' },
  diving:        { id: '20', name: 'Дайвинг',                  parentId: '1' },
  surf:          { id: '21', name: 'Сёрфинг',                  parentId: '1' },
  cultural:      { id: '22', name: 'Культурные экскурсии',     parentId: '1' },
  photo:         { id: '23', name: 'Фототуры',                 parentId: '1' },
};

const DIFFICULTY_LABELS: Record<string, string> = {
  easy:   'Лёгкая',
  medium: 'Средняя',
  hard:   'Сложная',
};

const MONTHS_RU = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDuration(hours: number | null): string {
  if (!hours) return 'по договорённости';
  if (hours < 24) return `${Math.round(hours)} ч`;
  const days = Math.ceil(hours / 24);
  if (days === 1) return '1 день';
  if (days < 5) return `${days} дня`;
  return `${days} дней`;
}

const MONTHS_GEN_RU = ['', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** 'YYYY-MM-DD' → {y, m, d}; иначе null. */
function parseIsoDate(v: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

/**
 * Сезон тура словами. Колонки season_start/season_end — DATE («2026-06-01»),
 * а до 29.09 функция ждала номер месяца: parseInt('2026-06-01') давал 2026, и в
 * ленту уходила сырая ISO-дата (аудит SEO 29.09, Н8). Номер месяца («6»)
 * по-прежнему понимается — так сезон записан у старых импортов.
 */
export function formatSeason(start: string | null, end: string | null): string {
  if (!start || !end) return 'круглый год';
  const a = parseIsoDate(start), b = parseIsoDate(end);
  if (a && b) {
    const left = `${a.d} ${MONTHS_GEN_RU[a.m]}${a.y !== b.y ? ` ${a.y}` : ''}`;
    return `${left} — ${b.d} ${MONTHS_GEN_RU[b.m]} ${b.y}`;
  }
  const s = parseInt(start, 10), e = parseInt(end, 10);
  if (MONTHS_RU[s] && MONTHS_RU[e] && String(s) === start.trim() && String(e) === end.trim()) {
    return `${MONTHS_RU[s]} — ${MONTHS_RU[e]}`;
  }
  return `${start} — ${end}`;
}

/**
 * Сезон кончился — предложение недоступно. Конец сезона неизвестен
 * (NULL или не дата) — считаем доступным: лента не решает за оператора.
 */
export function seasonEnded(end: string | null, today: string = new Date().toISOString().slice(0, 10)): boolean {
  if (!end) return false;
  const b = parseIsoDate(end);
  if (!b) return false;
  return end.trim().slice(0, 10) < today;
}

function buildDescription(tour: ChannelTour): string {
  const parts: string[] = [];

  // Цена с единицей — первой строкой: <price> несёт только число.
  parts.push(priceLine(tour.base_price, tour.price_unit));

  const base = stripTags(tour.short_description ?? tour.description ?? '').trim();
  if (base) parts.push(base);

  if (tour.duration_hours) {
    parts.push(`Продолжительность: ${formatDuration(tour.duration_hours)}.`);
  }
  if (tour.max_participants) {
    parts.push(`Группа до ${tour.max_participants} человек.`);
  }
  if (tour.season_start || tour.season_end) {
    parts.push(`Сезон: ${formatSeason(tour.season_start, tour.season_end)}.`);
  }
  if (Array.isArray(tour.included) && tour.included.length > 0) {
    parts.push(`Включено: ${tour.included.join(', ')}.`);
  }

  parts.push(`Подробнее и бронирование: ${SITE}/catalog/tours/${tour.id}`);

  return parts.join('\n\n').slice(0, 3000);
}

// ── XML генератор ─────────────────────────────────────────────────────────

export function generateYandexYmlFeed(tours: ChannelTour[]): string {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Уникальные категории в фиде
  const usedCategories = new Set(tours.map(t => t.activity_type));
  const categoryTags = [
    `    <category id="1">Туры и экскурсии по Камчатке</category>`,
    ...Object.entries(CATEGORY_MAP)
      .filter(([key]) => usedCategories.has(key))
      .map(([, cat]) => `    <category id="${cat.id}" parentId="${cat.parentId}">${escapeXml(cat.name)}</category>`),
  ].join('\n');

  const offerTags = tours.map(tour => {
    const cat = CATEGORY_MAP[tour.activity_type] ?? { id: '1' };
    const price = Math.round(tour.base_price);
    const desc = buildDescription(tour);
    // Абсолютные URL — как у Авито (absoluteUrl): Яндекс скачивает картинку
    // сам и относительный путь не поймёт. Замер 05.09 (prod-check run 12):
    // первый же открытый ответ фида нёс <picture>/images/...</picture> —
    // у всех восьми туров ни одной картинки, которую Яндекс смог бы забрать.
    const pictures = (tour.photos ?? []).slice(0, 10)
      .map(url => `      <picture>${escapeXml(absoluteUrl(url))}</picture>`)
      .join('\n');

    const params: string[] = [];
    if (tour.duration_hours) {
      params.push(`      <param name="Длительность">${escapeXml(formatDuration(tour.duration_hours))}</param>`);
    }
    if (tour.max_participants) {
      params.push(`      <param name="Размер группы">до ${tour.max_participants} чел.</param>`);
    }
    if (tour.difficulty) {
      params.push(`      <param name="Сложность">${escapeXml(DIFFICULTY_LABELS[tour.difficulty] ?? tour.difficulty)}</param>`);
    }
    if (tour.season_start || tour.season_end) {
      params.push(`      <param name="Сезон">${escapeXml(formatSeason(tour.season_start, tour.season_end))}</param>`);
    }
    if (tour.location_name) {
      params.push(`      <param name="Место">${escapeXml(tour.location_name)}</param>`);
    }
    const unit = priceUnitPhrase(tour.price_unit);
    if (unit) {
      params.push(`      <param name="Цена указана">${escapeXml(unit)}</param>`);
    }

    // Правило дат — общее для каталога и обеих лент (catalogAvailability);
    // своё сравнение с концом сезона — только если отбор его не посчитал.
    const over = tour.availability ? tour.availability === 'season_over' : seasonEnded(tour.season_end);
    const available = over ? 'false' : 'true';
    return `    <offer id="${tour.id}" available="${available}">
      <url>${escapeXml(`${SITE}/catalog/tours/${tour.id}`)}</url>
      <name>${escapeXml(tour.title.slice(0, 120))}</name>
      <description>${escapeXml(desc)}</description>
      <price>${price}</price>
      <currencyId>RUR</currencyId>
      <categoryId>${cat.id}</categoryId>
${pictures ? pictures + '\n' : ''}      <vendor>${escapeXml(tour.operator_name || 'Ведар')}</vendor>
      <vendorCode>${tour.id}</vendorCode>
${unit ? `      <sales_notes>${escapeXml(`Цена ${unit}`.slice(0, 50))}</sales_notes>\n` : ''}      <country_of_origin>Россия</country_of_origin>
${params.join('\n')}
    </offer>`;
  }).join('\n\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<yml_catalog date="${now}">
  <shop>
    <name>Ведар — туры на Камчатку</name>
    <company>Ведар</company>
    <url>${SITE}</url>
    <currencies>
      <currency id="RUR" rate="1"/>
    </currencies>
    <categories>
${categoryTags}
    </categories>
    <offers>
${offerTags}
    </offers>
  </shop>
</yml_catalog>`;
}
