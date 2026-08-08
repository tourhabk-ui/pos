/**
 * Инструмент Кузьмича make_trip_plan («Мой план 2.0», A-2; владелец 08.08:
 * «план мне нравится, реализуем»).
 *
 * Паттерн GuideGeek (планировщик в мессенджере), доведённый до сделки:
 * Кузьмич в Telegram/MAX/вебе отвечает не советом, а планом по дням из
 * движка recommendTrip — и даёт две ссылки: публичная страница готового
 * плана (/plans/[slug], там бронь реальных туров) и живой планировщик.
 *
 * Ссылку на персональную страницу «в один клик» не рождаем сознательно:
 * user_trips.user_id NOT NULL, анонимный share потребовал бы миграцию —
 * пресетные страницы уже публичны и ведут к брони, этого достаточно для MVP.
 */

import { recommendTrip, parseInterestsFromText, type DayPlan } from '@/lib/planner';
import { PLAN_PRESETS } from '@/lib/plans/presets';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/** Русские слова туриста → ключи интересов движка (дополняет parseInterests). */
const INTEREST_WORDS: Record<string, string> = {
  'вулкан': 'volcano', 'вулканы': 'volcano',
  'рыбалка': 'fishing', 'рыба': 'fishing',
  'медвед': 'bears',
  'вертолет': 'helicopter', 'вертолёт': 'helicopter',
  'термал': 'thermal', 'источник': 'thermal',
  'треккинг': 'trekking', 'поход': 'trekking',
  'море': 'boat_trip', 'океан': 'boat_trip', 'катер': 'boat_trip',
  'гейзер': 'geyser',
  'снегоход': 'snowmobile',
};

/** Свободный текст интересов → ключи движка. Пусто — классика первой поездки. */
export function parseChatInterests(raw: string): string[] {
  const text = (raw || '').toLowerCase();
  const found = new Set<string>();
  for (const [word, key] of Object.entries(INTEREST_WORDS)) {
    if (text.includes(word)) found.add(key);
  }
  // parseInterestsFromText движка ловит то, что словарь не покрыл
  try {
    const parsed = parseInterestsFromText(text);
    for (const k of parsed.interests ?? []) found.add(k);
  } catch { /* словаря достаточно */ }
  if (found.size === 0) return ['volcano', 'bears', 'thermal'];
  return [...found];
}

/** Ближайший пресет /plans под длительность и интересы — ссылка с бронью. */
export function matchPreset(days: number, interests: string[]): { slug: string; title: string } | null {
  let best: { slug: string; title: string; score: number } | null = null;
  for (const p of PLAN_PRESETS) {
    const overlap = p.interests.filter((i) => interests.includes(i)).length;
    const dayPenalty = Math.abs(p.days - days);
    const score = overlap * 10 - dayPenalty;
    if (!best || score > best.score) best = { slug: p.slug, title: p.title, score };
  }
  return best && best.score > 0 ? { slug: best.slug, title: best.title } : null;
}

/** План по дням → текст для чата (Telegram/MAX/веб). Чистая, под тестом. */
export function formatTripPlanForChat(
  days: DayPlan[],
  warnings: string[],
  preset: { slug: string; title: string } | null,
): string {
  if (days.length === 0) {
    return `Не собрал план по этим параметрам — попробуй назвать интересы иначе (вулканы, рыбалка, медведи, море). Живой планировщик: ${SITE}/planner`;
  }
  const lines: string[] = ['Собрал план по дням:', ''];
  for (const d of days) {
    const price = d.priceFrom > 0 ? ` — от ${d.priceFrom.toLocaleString('ru-RU')} ₽` : '';
    lines.push(`День ${d.day}. ${d.title}${price}`);
  }
  if (warnings.length > 0) {
    lines.push('', `Важно: ${warnings.slice(0, 2).join(' ')}`);
  }
  lines.push('');
  if (preset) {
    lines.push(`Готовая страница этого формата с турами и бронью: ${SITE}/plans/${preset.slug}`);
  }
  lines.push(`Пересобрать под свои даты и состав: ${SITE}/planner`);
  return lines.join('\n');
}

/** Обработчик инструмента: собрать план и отдать текст с ссылками. */
export async function makeTripPlanForKuzmich(args: { days?: string; interests?: string }): Promise<string> {
  const daysNum = Math.min(21, Math.max(3, Number(args.days) || 7));
  const interests = parseChatInterests(args.interests ?? '');

  const arrival = new Date(Date.now() + 30 * 86400000);
  const departure = new Date(arrival.getTime() + daysNum * 86400000);

  const rec = await recommendTrip({
    interests,
    arrivalDate: arrival.toISOString().slice(0, 10),
    departureDate: departure.toISOString().slice(0, 10),
    adults: 2,
    children: [],
    fitnessLevel: 'moderate',
    budgetTier: 'comfort',
    riskMode: 'safe_only',
  });

  return formatTripPlanForChat(
    rec.days,
    rec.warnings.filter((w) => w.severity !== 'info').map((w) => w.message),
    matchPreset(daysNum, interests),
  );
}
