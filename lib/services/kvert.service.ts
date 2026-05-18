/**
 * KVERT — Камчатская группа реагирования на вулканические извержения
 * http://www.kscnet.ru/ivs/kvert/
 *
 * Парсит RSS-ленту KVERT и возвращает цветовые коды активности вулканов.
 * Цветовые коды: GREEN / YELLOW / ORANGE / RED
 */

export type KvertColor = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'UNKNOWN';

export interface VolcanoStatus {
  name: string;
  nameEn: string;
  color: KvertColor;
  description: string;
  updatedAt: string;
  url?: string;
}

const KVERT_RSS_URL = 'http://www.kscnet.ru/ivs/kvert/updates/index.php?rss';

const COLOR_PRIORITY: Record<KvertColor, number> = {
  RED: 4, ORANGE: 3, YELLOW: 2, GREEN: 1, UNKNOWN: 0,
};

function extractColor(text: string): KvertColor {
  const up = text.toUpperCase();
  if (up.includes('RED') || up.includes('КРАСНЫЙ')) return 'RED';
  if (up.includes('ORANGE') || up.includes('ОРАНЖЕВЫЙ')) return 'ORANGE';
  if (up.includes('YELLOW') || up.includes('ЖЁЛТЫЙ') || up.includes('ЖЕЛТЫЙ')) return 'YELLOW';
  if (up.includes('GREEN') || up.includes('ЗЕЛЁНЫЙ') || up.includes('ЗЕЛЕНЫЙ')) return 'GREEN';
  return 'UNKNOWN';
}

function parseXmlField(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

let _cache: { data: VolcanoStatus[]; ts: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function getVolcanoStatuses(): Promise<VolcanoStatus[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;

  try {
    const res = await fetch(KVERT_RSS_URL, {
      headers: { 'User-Agent': 'TourHab/1.0 (tourhab.ru)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`KVERT HTTP ${res.status}`);
    const xml = await res.text();

    const items = xml.split('<item>').slice(1);
    const statuses: VolcanoStatus[] = [];

    for (const item of items) {
      const title = parseXmlField(item, 'title');
      const description = parseXmlField(item, 'description');
      const pubDate = parseXmlField(item, 'pubDate');
      const link = parseXmlField(item, 'link');

      const color = extractColor(title + ' ' + description);
      const nameMatch = title.match(/^([A-Za-zА-Яа-яё\s\-/]+?)(?:\s*[–\-]\s*|\s+(?:GREEN|YELLOW|ORANGE|RED))/i);
      const name = nameMatch?.[1]?.trim() ?? title.split(/\s*[–\-]\s*/)[0]?.trim() ?? 'Вулкан';

      statuses.push({
        name,
        nameEn: name,
        color,
        description: description.replace(/<[^>]+>/g, '').slice(0, 300),
        updatedAt: pubDate,
        url: link,
      });
    }

    // Deduplicate by name, keep highest priority color
    const byName = new Map<string, VolcanoStatus>();
    for (const s of statuses) {
      const key = s.name.toLowerCase();
      const existing = byName.get(key);
      if (!existing || COLOR_PRIORITY[s.color] > COLOR_PRIORITY[existing.color]) {
        byName.set(key, s);
      }
    }

    const data = [...byName.values()].sort(
      (a, b) => COLOR_PRIORITY[b.color] - COLOR_PRIORITY[a.color],
    );

    _cache = { data, ts: Date.now() };
    return data;
  } catch {
    return _cache?.data ?? [];
  }
}

export async function getAlertVolcanoes(): Promise<VolcanoStatus[]> {
  const all = await getVolcanoStatuses();
  return all.filter(v => v.color === 'RED' || v.color === 'ORANGE');
}

export function formatKvertForKuzmich(statuses: VolcanoStatus[]): string {
  if (!statuses.length) return 'Данные KVERT временно недоступны.';

  const alerts = statuses.filter(v => v.color === 'RED' || v.color === 'ORANGE');
  const elevated = statuses.filter(v => v.color === 'YELLOW');
  const calm = statuses.filter(v => v.color === 'GREEN');

  const lines: string[] = [];

  if (alerts.length) {
    lines.push(`ВНИМАНИЕ KVERT — активные вулканы:`);
    for (const v of alerts) {
      lines.push(`  ${v.name}: ${v.color} — ${v.description}`);
    }
  }

  if (elevated.length) {
    lines.push(`Повышенная активность: ${elevated.map(v => v.name).join(', ')}`);
  }

  if (calm.length) {
    lines.push(`Спокойные: ${calm.map(v => v.name).join(', ')}`);
  }

  return lines.join('\n');
}
