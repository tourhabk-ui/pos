/**
 * Rescue Agent — проактивный мониторинг того, что НЕ покрывает Watchdog.
 *
 * Разведение дублей (EVO-3, июль 2026): SOS-таймауты и неподтверждённые
 * бронирования сторожит теперь ТОЛЬКО Watchdog (lib/agents/watchdog.ts) —
 * у него тот же порог, тот же Telegram, но частота 30 мин против 6-часовой
 * evo-оркестрации, и он ещё пишет оператору напрямую. Держать те же проверки
 * в двух агентах = двойные алерты владельцу об одном событии. Rescue оставляет
 * за собой то, чего у Watchdog нет:
 *   1. Погодные угрозы для ближайших туров (Open-Meteo по зоне бронирования)
 *   2. Операторы без бронирований >7 дней (сигнал оттока, severity info)
 *
 * SOS и брони >24ч → Watchdog. Не возвращать их сюда — расширять того сторожа.
 */

import { pool } from '@/lib/db-pool';
import { fetchWeatherForecast } from '@/lib/planner/intelligence';

export interface RescueAlert {
  type: 'weather_threat' | 'operator_no_response';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
  action: string;
}

export interface RescueScanResult {
  alerts: RescueAlert[];
  scan_duration_ms: number;
}

// Координаты основных зон для проверки погоды
const ZONE_COORDS: Record<string, [number, number]> = {
  petropavlovsk: [53.01, 158.65],
  paratunka:     [52.75, 158.20],
  nalychevo:     [53.15, 158.40],
  mutnovsky:     [52.60, 158.20],
  kurilskoe:     [51.45, 156.90],
  klyuchevskoy:  [56.05, 160.65],
};

// WMO коды опасной погоды
const DANGEROUS_WEATHER = new Set([
  63, 65,  // дождь
  73, 75,  // снег
  80, 81, 82,  // ливень
  85, 86,  // снегопад
  95, 96, 99,  // гроза
]);

const WEATHER_LABELS: Record<number, string> = {
  63: 'дождь', 65: 'сильный дождь',
  73: 'снег', 75: 'сильный снег',
  80: 'ливень', 81: 'сильный ливень', 82: 'шквал',
  85: 'снегопад', 86: 'сильный снегопад',
  95: 'гроза', 96: 'гроза с градом', 99: 'сильная гроза',
};

/**
 * Главный скан спасателя.
 */
export async function runRescueScan(): Promise<RescueScanResult> {
  const start = Date.now();
  const alerts: RescueAlert[] = [];

  // Погодные угрозы для ближайших туров (уникально для Rescue).
  alerts.push(...await checkWeatherThreats());

  // Операторы без бронирований >7 дней — сигнал оттока (severity info).
  // NB: это НЕ то же, что Watchdog.checkOperatorNoResponse (там оператор
  // игнорирует конкретную бронь >48ч) — здесь про тишину/отток.
  alerts.push(...await checkOperatorResponse());

  // SOS и брони >24ч сюда НЕ возвращать — их сторожит Watchdog (см. заголовок).
  if (alerts.some(a => a.severity === 'critical')) {
    void sendCriticalAlerts(alerts.filter(a => a.severity === 'critical'));
  }

  return { alerts, scan_duration_ms: Date.now() - start };
}

// ── Weather Threat Check ──────────────────────────────────────────────────

async function checkWeatherThreats(): Promise<RescueAlert[]> {
  const alerts: RescueAlert[] = [];

  // Получаем ближайшие активные бронирования (следующие 3 дня)
  try {
    const { rows: bookings } = await pool.query<{
      id: number; tour_title: string; booking_date: string;
      participants: number; location_name: string | null;
      operator_name: string; tourist_name: string;
    }>(`
      SELECT ob.id, ot.title AS tour_title, ob.booking_date,
             ob.participants, ot.location_name,
             COALESCE(p.name, 'Оператор') AS operator_name,
             ob.tourist_name
      FROM operator_bookings ob
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      LEFT JOIN partners p ON p.id = ot.operator_id
      WHERE ob.booking_status IN ('new', 'confirmed')
        AND ob.booking_date >= CURRENT_DATE
        AND ob.booking_date <= CURRENT_DATE + INTERVAL '3 days'
        AND ob.deleted_at IS NULL
      ORDER BY ob.booking_date ASC
      LIMIT 20
    `);

    // Для каждого бронирования проверяем погоду
    for (const booking of bookings) {
      const location = booking.location_name ?? '';
      const coords = findClosestZone(location);
      if (!coords) continue;

      const daysAhead = daysUntil(booking.booking_date);
      if (daysAhead < 0 || daysAhead > 5) continue;

      const forecast = await fetchWeatherForecast(coords[0], coords[1], 3);
      if (forecast.length <= daysAhead) continue;

      const dayWeather = forecast[daysAhead];
      if (DANGEROUS_WEATHER.has(dayWeather.weatherCode)) {
        const weatherLabel = WEATHER_LABELS[dayWeather.weatherCode] ?? 'опасная погода';
        alerts.push({
          type: 'weather_threat',
          severity: 'warning',
          title: `⛈️ Погода: ${weatherLabel} на ${formatDate(booking.booking_date)}`,
          body: `${booking.tour_title} — ${booking.tourist_name} (${booking.participants} чел.)`,
          action: `Предложить альтернативу или перенести. ${weatherLabel}, ветер ${dayWeather.windKmh} км/ч.`,
        });
      }
    }
  } catch {
    // Ошибка — не критично
  }

  return alerts;
}

// ── Operator Response Check ───────────────────────────────────────────────

async function checkOperatorResponse(): Promise<RescueAlert[]> {
  const alerts: RescueAlert[] = [];

  try {
    const { rows } = await pool.query<{
      name: string; last_booking_at: Date | null; days_since: number;
    }>(`
      SELECT p.name,
             MAX(ob.created_at) AS last_booking_at,
             EXTRACT(EPOCH FROM (NOW() - MAX(ob.created_at))) / 86400 AS days_since
      FROM partners p
      LEFT JOIN operator_bookings ob ON ob.operator_tour_id IN (
        SELECT id FROM operator_tours WHERE operator_id = p.id
      )
      WHERE p.is_active = true
      GROUP BY p.id, p.name
      HAVING MAX(ob.created_at) IS NOT NULL
      ORDER BY days_since DESC
    `);

    for (const op of rows) {
      const days = Math.round(op.days_since);
      if (days > 7) {
        alerts.push({
          type: 'operator_no_response',
          severity: 'info',
          title: `🏢 ${op.name} — ${days} дней без бронирований`,
          body: `Последнее бронирование: ${op.last_booking_at ? formatDate(String(op.last_booking_at)) : 'неизвестно'}`,
          action: 'Проверить — оператор ушёл или просто тишина.',
        });
      }
    }
  } catch {
    // Таблица может не существовать
  }

  return alerts;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function sendCriticalAlerts(alerts: RescueAlert[]): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const text = alerts.map(a =>
    `<b>${a.title}</b>\n${a.body}\n<i>${a.action}</i>`
  ).join('\n\n');

  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch { /* silent */ }
}

function findClosestZone(locationName: string): [number, number] | null {
  const lower = locationName.toLowerCase();
  if (lower.includes('паратун') || lower.includes('paratun')) return ZONE_COORDS.paratunka;
  if (lower.includes('налыч') || lower.includes('nalych')) return ZONE_COORDS.nalychevo;
  if (lower.includes('мутн') || lower.includes('mutn')) return ZONE_COORDS.mutnovsky;
  if (lower.includes('курил') || lower.includes('kuril')) return ZONE_COORDS.kurilskoe;
  if (lower.includes('ключ') || lower.includes('klyuch')) return ZONE_COORDS.klyuchevskoy;
  // По умолчанию — Петропавловск
  return ZONE_COORDS.petropavlovsk;
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / 86400000);
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  } catch {
    return dateStr;
  }
}
