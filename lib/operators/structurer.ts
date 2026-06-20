/**
 * lib/operators/structurer.ts
 *
 * AI-структуризатор HTML-страниц операторов → туры с ценами.
 * Использует callAIFast + Zod валидацию.
 *
 * Правило №1: если цены/даты нет на странице → null, не выдумывать.
 * Правило №2: price_unit обязателен — без него сравнение цен врёт.
 */

import { z } from 'zod';
import { callAIFast } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

// ── Схема одного тура ─────────────────────────────────────────────────────────

export const TourSchema = z.object({
  title: z.string().min(3).max(200),
  category: z.enum(['volcano', 'sea', 'rafting', 'thermal', 'fishing', 'trekking', 'helicopter', 'jeep', 'other']),
  price_from: z.number().positive().nullable(),
  price_unit: z.enum(['per_person', 'per_group', 'unknown']),
  group_size_max: z.number().int().positive().nullable(),
  price_note: z.string().nullable(),
  includes: z.string().nullable(),
  duration_hours: z.number().positive().nullable(),
  departures: z.array(z.object({
    date_from: z.string().nullable(),
    date_to: z.string().nullable(),
    seats_left: z.number().int().nullable(),
  })).nullable(),
  source_url: z.string().url(),
  description: z.string().nullable(),
});

export type ScrapedTour = z.infer<typeof TourSchema>;

const ToursResponseSchema = z.object({
  tours: z.array(TourSchema),
});

// ── Промпт ────────────────────────────────────────────────────────────────────

function buildPrompt(html: string, pageUrl: string): ChatMessage[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n')
    .trim()
    .slice(0, 8000);

  return [
    {
      role: 'system',
      content: `Ты извлекаешь туры с сайтов туроператоров Камчатки.

ПРАВИЛА — обязательны:
1. Если цены нет на странице → price_from: null. НЕ выдумывай цену.
2. price_unit: "с человека"/"за чел"/"чел" → "per_person"; "за группу"/"группа"/"за тур" → "per_group"; непонятно → "unknown".
3. Если дат выездов нет → departures: null. НЕ придумывай даты.
4. source_url = URL страницы откуда взяты данные (всегда заполнен).
5. Возвращай ТОЛЬКО реальные туры со страницы. Не домысливай.

Категории: volcano (вулканы), sea (морские прогулки, катер), rafting (сплав, рафтинг), thermal (источники, Малки), fishing (рыбалка), trekking (поход, пеший), helicopter (вертолёт), jeep (джип, вездеход), other.

Отвечай JSON: { "tours": [...] }`,
    },
    {
      role: 'user',
      content: `URL страницы: ${pageUrl}\n\nТекст страницы:\n${text}`,
    },
  ];
}

// ── Основная функция ──────────────────────────────────────────────────────────

export async function extractToursFromPage(
  html: string,
  pageUrl: string,
): Promise<ScrapedTour[]> {
  const messages = buildPrompt(html, pageUrl);

  let raw: string;
  try {
    raw = await callAIFast(messages);
  } catch {
    return [];
  }

  // Извлекаем JSON из ответа
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    const validated = ToursResponseSchema.safeParse(parsed);
    if (!validated.success) return [];

    return validated.data.tours.map(t => ({
      ...t,
      source_url: t.source_url || pageUrl,
    }));
  } catch {
    return [];
  }
}

// ── Форматирование для ответа Тарасу ─────────────────────────────────────────

export function formatToursForUser(
  tours: Array<ScrapedTour & { operator_name: string }>,
  groupSize = 2,
): string {
  if (!tours.length) return '';

  const lines = tours.map(t => {
    const priceStr = t.price_from
      ? (() => {
          if (t.price_unit === 'per_person') {
            return `${t.price_from.toLocaleString('ru-RU')}₽/чел (на ${groupSize}: ${(t.price_from * groupSize).toLocaleString('ru-RU')}₽)`;
          }
          if (t.price_unit === 'per_group') {
            return `${t.price_from.toLocaleString('ru-RU')}₽/группа до ${t.group_size_max ?? '?'} чел`;
          }
          return `${t.price_from.toLocaleString('ru-RU')}₽ (уточните: за чел или группу)`;
        })()
      : 'цена не указана — уточнить напрямую';

    const datesStr = t.departures?.length
      ? t.departures.map(d => d.date_from ?? '?').join(', ')
      : 'даты уточнять у оператора';

    const includesStr = t.includes ? ` · ${t.includes}` : '';

    return `• ${t.operator_name} — ${priceStr}${includesStr} · ${datesStr}`;
  });

  return lines.join('\n');
}
