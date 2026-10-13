/**
 * lib/mcp/ru-clients.ts — клиенты и продукты РФ по самоназванию.
 *
 * Повод (владелец 13.10, после китайского контура): «остались российские ИИ».
 * Механизм тот же, что у реестра КНР (china-clients.ts): самоназвания
 * программ по границе слова, метка «РФ» у имени клиента и агента в срезах
 * `/hub/admin/mcp` и `/hub/admin/a2a`, отдельная группа в переписи
 * `mcp-census`. Это имена ПРОГРАММ, не страна запроса: IP не хранится и не
 * читается (152-ФЗ, суточный hash).
 *
 * Кто здесь: Яндекс (AI Studio с MCP Hub и Responses API, YandexGPT, Алиса),
 * Сбер (GigaChat, GigaChain, Salute), МТС (Cotype), Т-Банк (T-Pro, T-Lite),
 * VK (VK Cloud, MAX). Какими именами они подписывают clientInfo.name и
 * User-Agent, документация не называет — маркеры по брендам, список открытый:
 * первое живое подключение (yandex-mcp-probe) покажет точное имя, и оно
 * добавляется сюда. Обходчик YandexBot сюда не попадает: «yandexbot» не
 * проходит границу слова, а адрес `+http://yandex.com/bots` из заголовка
 * вырезается до сличения; род обходчиков держит реестр краулеров (bot-detect).
 *
 * Сторож: tests/unit/ru-clients.test.ts.
 */

export interface RuClientFamily {
  /** Род для `ua_family` и для группировки. */
  family: string;
  /** Кому принадлежит, для человека. */
  vendor: string;
  /** Самоназвания (нижний регистр), по границе слова. */
  markers: readonly string[];
}

export const RU_CLIENT_FAMILIES: readonly RuClientFamily[] = [
  { family: 'yandex-ai', vendor: 'Яндекс (AI Studio, YandexGPT, Алиса), РФ',  markers: ['yandex', 'yandexgpt', 'yandex-cloud', 'yandexcloud', 'yagpt', 'алиса'] },
  { family: 'gigachat',  vendor: 'Сбер (GigaChat, GigaChain, Salute), РФ',    markers: ['gigachat', 'gigachain', 'sber', 'sberbank', 'salute'] },
  { family: 'mts-ai',    vendor: 'МТС (Cotype), РФ',                           markers: ['cotype', 'mts-ai', 'mtsai'] },
  { family: 't-bank-ai', vendor: 'Т-Банк (T-Pro, T-Lite), РФ',                 markers: ['t-pro', 't-lite', 'tbank', 't-bank'] },
  { family: 'vk-ai',     vendor: 'VK (VK Cloud, MAX), РФ',                     markers: ['vk-cloud', 'vkcloud', 'vk-ai'] },
];

/** Метка региона в срезах — одно слово, одинаковое везде. */
export const RU_REGION_LABEL = 'РФ';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Граница слова для латиницы, цифр и кириллицы: буква или цифра по краям — не совпадение. */
const EDGE = '[^a-z0-9а-яё]';
const MARKER_RES: ReadonlyArray<{ family: string; re: RegExp }> = RU_CLIENT_FAMILIES.flatMap((f) =>
  f.markers.map((m) => ({ family: f.family, re: new RegExp(`(^|${EDGE})${escapeRe(m)}(${EDGE}|$)`) })),
);

export const RU_FAMILY_SET: ReadonlySet<string> = new Set(RU_CLIENT_FAMILIES.map((f) => f.family));

/** Род клиента РФ по самоназванию или заголовку; null — не из реестра. */
/**
 * Адрес в заголовке — не самоназвание: обходчик YandexBot несёт
 * `+http://yandex.com/bots`, и слово «yandex» там стоит по границе слова.
 * Адреса вырезаются до сличения; по ним род не присваивается.
 */
const ADDRESS_RE = /https?:\/\/\S+/g;

export function ruClientFamily(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(ADDRESS_RE, ' ');
  for (const { family, re } of MARKER_RES) {
    if (re.test(s)) return family;
  }
  return null;
}
