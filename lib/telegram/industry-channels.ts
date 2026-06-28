/**
 * lib/telegram/industry-channels.ts
 *
 * Чтение отраслевых Telegram-каналов гостеприимства/туризма через MTProto
 * для рыночной разведки (тренды, аналитика, новости индустрии).
 *
 * В отличие от operator-availability (свободные места у операторов) — здесь
 * именно market-intelligence: что происходит на рынке, у конкурентов, какие тренды.
 * Извлечение делает group-monitor.analyzeChannelBatch → agent_memory (intelligence).
 *
 * Требует MTProto: TG_API_ID, TG_API_HASH, TG_USER_SESSION (см. scripts/tg-auth.ts).
 * Без них тихо пропускает (как и operator-availability).
 *
 * Список можно переопределить env INDUSTRY_TG_CHANNELS (через запятую, без @).
 */

import { getMTProtoClient, isMTProtoConfigured } from '@/lib/telegram/mtproto-client';
import { groupMonitor } from '@/lib/telegram/group-monitor';

// Отраслевые каналы RU-гостеприимства/туризма (market intelligence)
const DEFAULT_CHANNELS = [
  'extranetetg',               // Островок Экстранет — аналитика гостиничного рынка
  'yandex_travel_pro',         // Яндекс PRO Путешествия
  'glamping_association_ru',   // Глэмпинг новости
  'bronevik_com',              // Bronevik — тренды рынка путешествий
  'HotelierPRO',               // Hotelier.PRO
  'AZO_channel',               // Ассоциация загородных отелей
  'hotel_advisors',            // Hotel Advisors — управление, ценообразование
  'russianhospitalityawards',  // Russian Hospitality Awards
  'portierdenuit',             // Ночной портье
];

function channelList(): string[] {
  const fromEnv = (process.env.INDUSTRY_TG_CHANNELS ?? '')
    .split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_CHANNELS;
}

export interface IndustryScanResult {
  channels_scanned: number;
  channels_with_intel: number;
  messages_read: number;
  errors: string[];
}

/**
 * Читает последние сообщения отраслевых каналов и прогоняет через market-intel экстрактор.
 */
export async function scanIndustryChannels(hoursBack = 48): Promise<IndustryScanResult> {
  const result: IndustryScanResult = {
    channels_scanned: 0,
    channels_with_intel: 0,
    messages_read: 0,
    errors: [],
  };

  if (!isMTProtoConfigured()) {
    result.errors.push('MTProto не настроен: нужны TG_API_ID, TG_API_HASH, TG_USER_SESSION');
    return result;
  }

  let client;
  try {
    client = await getMTProtoClient();
  } catch (e) {
    result.errors.push(`MTProto client: ${(e as Error).message}`);
    return result;
  }

  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  for (const username of channelList()) {
    result.channels_scanned++;
    try {
      const entity = await client.getEntity(`@${username}`);
      const messages: Array<{ from: string; text: string; ts: string }> = [];

      const iter = client.iterMessages(entity, { limit: 100 });
      for await (const msg of iter) {
        const msgDate = new Date((msg.date as number) * 1000);
        if (msgDate < since) break;
        const text = (msg.text as string | undefined)?.trim() ?? '';
        if (text.length > 30) {
          messages.push({ from: username, text: text.slice(0, 500), ts: msgDate.toISOString() });
        }
      }

      result.messages_read += messages.length;
      if (messages.length > 0) {
        const ok = await groupMonitor.analyzeChannelBatch(`industry:${username}`, username, messages);
        if (ok) result.channels_with_intel++;
      }
    } catch (e) {
      result.errors.push(`@${username}: ${(e as Error).message}`);
    }
  }

  return result;
}
