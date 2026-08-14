/**
 * GPX-экспорт плана поездки («Мой план 2.0», C-6 — офлайн-план).
 *
 * План из share-ссылки должен переживать отсутствие связи: на Камчатке связь
 * заканчивается за городом, а дни плана — это координаты. GPX открывается в
 * Organic Maps / Garmin / любом навигаторе без нашего приложения и без сети.
 *
 * Формат: waypoint на каждый день с координатами + route (rte), связывающий
 * дни по порядку — навигатор показывает и точки, и нить маршрута.
 * Чистая функция без БД — сторожится юнит-тестом напрямую.
 */

export interface PlanGpxDay {
  day: number;
  title: string;
  coords?: [number, number];
  /** Дата дня YYYY-MM-DD, если известна дата заезда. */
  date?: string;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Имя файла — строго ASCII. Кириллица в HTTP-заголовке роняет ответ целиком:
 * Content-Disposition — ByteString, символ с кодом >255 бросает исключение,
 * и катч роута превращал КАЖДОЕ скачивание GPX в 500 (дефолтное название
 * плана — «Маршрут ГГГГ-ММ-ДД», то есть кириллица всегда).
 */
export function planGpxFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => TRANSLIT[ch] ?? '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .slice(0, 50)
    .replace(/^_+|_+$/g, '') || 'plan';
  return `${slug}.gpx`;
}

/**
 * Готовый Content-Disposition: ASCII-имя в filename (совместимость и
 * гарантия валидного заголовка) + оригинал в filename* (RFC 5987,
 * percent-encoded — тоже чистый ASCII), чтобы навигатор показал
 * человеческое название. Роут не собирает заголовок сам.
 */
export function planGpxContentDisposition(title: string): string {
  const ascii = planGpxFilename(title);
  const utf8 = encodeURIComponent(title.slice(0, 80)).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}.gpx`;
}

/** Дни с валидными координатами — только они попадают в GPX. */
export function planGpxPoints(days: PlanGpxDay[]): (PlanGpxDay & { coords: [number, number] })[] {
  return days.filter((d): d is PlanGpxDay & { coords: [number, number] } =>
    Array.isArray(d.coords) && d.coords.length === 2 &&
    Number.isFinite(d.coords[0]) && Number.isFinite(d.coords[1]));
}

export function buildPlanGpx(title: string, days: PlanGpxDay[]): string {
  const points = planGpxPoints(days);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx version="1.1" creator="Ведар" xmlns="http://www.topografix.com/GPX/1/1">');
  lines.push('  <metadata>');
  lines.push(`    <name>${escapeXml(title)}</name>`);
  lines.push('    <author>');
  lines.push('      <name>Ведар — vedarai.ru</name>');
  lines.push('    </author>');
  lines.push('  </metadata>');

  for (const p of points) {
    lines.push(`  <wpt lat="${p.coords[0]}" lon="${p.coords[1]}">`);
    lines.push(`    <name>${escapeXml(`День ${p.day}: ${p.title}`)}</name>`);
    if (p.date) lines.push(`    <desc>${escapeXml(p.date)}</desc>`);
    lines.push('  </wpt>');
  }

  if (points.length > 1) {
    lines.push('  <rte>');
    lines.push(`    <name>${escapeXml(title)}</name>`);
    for (const p of points) {
      lines.push(`    <rtept lat="${p.coords[0]}" lon="${p.coords[1]}">`);
      lines.push(`      <name>${escapeXml(`День ${p.day}: ${p.title}`)}</name>`);
      lines.push('    </rtept>');
    }
    lines.push('  </rte>');
  }

  lines.push('</gpx>');
  return lines.join('\n');
}
