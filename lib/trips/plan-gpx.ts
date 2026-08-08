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

export function planGpxFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, '')
    .replace(/\s+/g, '_')
    .slice(0, 50) || 'plan';
  return `${slug}.gpx`;
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
