/**
 * Avito Channel Adapter
 * Docs: https://developers.avito.ru/
 *
 * Два режима интеграции:
 *
 * РЕЖИМ 1 — Автозагрузка XML (рекомендуется для старта)
 *   - Хостим XML-фид на /api/channels/avito/feed
 *   - Регистрируем URL в личном кабинете Авито → Автозагрузка
 *   - Авито сам обновляет листинги каждые несколько часов
 *   - Не нужен OAuth, не нужно одобрение API
 *   - В описании каждого тура: ссылка на публичную карточку
 *     vedarai.ru/catalog/tours/{id}. Здесь раньше стояло /hub/tour/{id} —
 *     маршрута с таким путём в приложении нет, а /hub/* вдобавок под
 *     авторизацией и закрыт в robots: каждое объявление вело бы в 404, то есть
 *     весь трафик с площадки терялся бы на входе.
 *
 * РЕЖИМ 2 — REST API (после получения одобрения)
 *   - OAuth 2.0 Client Credentials
 *   - POST /core/v1/accounts/{user_id}/items — создать объявление
 *   - GET /messenger/v3/... — читать входящие сообщения (лиды)
 *   - Env: AVITO_CLIENT_ID, AVITO_CLIENT_SECRET, AVITO_USER_ID
 *
 * Категория для рыболовных туров:
 *   Услуги → Активный отдых → Рыбалка, охота
 */

import type {
  ChannelAdapter, ChannelBooking, ChannelName,
  ChannelTour, PushBookingInput, PushBookingResult,
} from './types';

const AVITO_API = 'https://api.avito.ru';

// ── OAuth token (кешируем на время жизни) ─────────────────────────────────

let _token: string | null = null;
let _tokenExpiresAt = 0;

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExpiresAt) return _token;

  const clientId     = process.env.AVITO_CLIENT_ID;
  const clientSecret = process.env.AVITO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('AVITO_CLIENT_ID / AVITO_CLIENT_SECRET не настроены');

  const res = await fetch(`${AVITO_API}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });

  const data = await res.json() as { access_token: string; expires_in: number };
  _token = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

// ── XML Автозагрузка ───────────────────────────────────────────────────────

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Категория Авито и «вид отдыха» по типу активности.
 *
 * Жёстко зашитая «Охота и рыбалка» для ВСЕХ туров была ошибкой: сплав по
 * Быстрой — не рыбалка, а объявление в неверной категории Авито снимает с
 * публикации. Названия обязаны совпадать с теми, что видит владелец в кабинете
 * Автозагрузки, — свериться можно только там, поэтому карта вынесена сюда
 * одним местом.
 *
 * Неизвестный тип НЕ подставляется «по умолчанию»: лучше не выгрузить тур, чем
 * выгрузить его не туда и получить бан аккаунта. Такие туры пропускаются, и это
 * видно в счётчике фида.
 */
export const AVITO_CATEGORY_BY_ACTIVITY: Record<string, { category: string; kind: string }> = {
  fishing:    { category: 'Охота и рыбалка', kind: 'Рыбалка' },
  rafting:    { category: 'Охота и рыбалка', kind: 'Сплав' },
  boat_trip:  { category: 'Охота и рыбалка', kind: 'Сплав' },
};

export function avitoCategory(activityType: string | null | undefined) {
  if (!activityType) return null;
  return AVITO_CATEGORY_BY_ACTIVITY[activityType] ?? null;
}

/** Абсолютный URL: Авито скачивает картинку сам и относительный путь не поймёт. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${SITE_URL.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Публичная карточка тура. Раньше сюда шло /hub/tour/{id} — такого маршрута
 * нет и не было, а /hub/* вдобавок закрыт авторизацией: каждое объявление вело
 * бы в 404. Ради этого перехода объявление и размещается. */
export function tourPublicUrl(id: number | string): string {
  return `${SITE_URL.replace(/\/$/, '')}/catalog/tours/${id}`;
}

/** Длительность словами. Делить часы на 8 нельзя: четырёхчасовой тур давал «0 дн.». */
export function durationLabel(hours: number | null | undefined): string {
  if (!hours || hours <= 0) return 'по договорённости';
  if (hours >= 24) return `${Math.round(hours / 24)} дн.`;
  if (hours >= 8) return '1 день';
  return `${Math.round(hours)} ч.`;
}

function tourDescription(tour: ChannelTour): string {
  const base = tour.short_description ?? tour.description ?? '';
  const included = Array.isArray(tour.included) && tour.included.length > 0
    ? '\n\nВключено: ' + tour.included.join(', ')
    : '';
  const link = `\n\nПодробнее и бронирование: ${tourPublicUrl(tour.id)}`;
  return (base + included + link).slice(0, 7000);
}

export function generateAvitoXmlFeed(tours: ChannelTour[]): string {
  const items = tours
    .map(tour => {
      const cat = avitoCategory(tour.activity_type);
      if (!cat) return null; // тип без категории наружу не выгружаем — см. карту выше
      const price = Math.round(tour.base_price);
      const photos = (tour.photos ?? []).slice(0, 10)
        .map(url => `      <Image url="${escapeXml(absoluteUrl(url))}"/>`)
        .join('\n');

      const address = tour.location_name
        ? `${escapeXml(tour.location_name)}, Камчатский край`
        : 'Камчатский край';
      const coords = tour.latitude != null && tour.longitude != null
        ? `\n    <Latitude>${tour.latitude}</Latitude>\n    <Longitude>${tour.longitude}</Longitude>`
        : '';
      const contact = tour.operator_phone
        ? `\n    <ContactPhone>${escapeXml(tour.operator_phone)}</ContactPhone>`
        : '';
      const manager = tour.operator_name
        ? `\n    <ManagerName>${escapeXml(tour.operator_name)}</ManagerName>`
        : '';

      return `
  <Ad>
    <Id>${tour.id}</Id>
    <Category>${escapeXml(cat.category)}</Category>
    <Title>${escapeXml(tour.title.slice(0, 50))}</Title>
    <Description>${escapeXml(tourDescription(tour))}</Description>
    <Price>${price}</Price>
    <Address>${address}</Address>${coords}${manager}${contact}
    <AllowEmail>0</AllowEmail>
    ${photos ? `<Images>\n${photos}\n    </Images>` : ''}
    <Params>
      <Param name="Вид отдыха">${escapeXml(cat.kind)}</Param>
      <Param name="Длительность">${durationLabel(tour.duration_hours)}</Param>
      <Param name="Количество участников">до ${tour.max_participants} чел.</Param>
    </Params>
  </Ad>`.trim();
    })
    .filter((x): x is string => x !== null)
    .join('\n\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Ads formatVersion="3" target="Avito.ru">
  ${items}
</Ads>`;
}

// ── Messenger API — чтение входящих лидов ────────────────────────────────

export async function fetchAvitoLeads(userId: string): Promise<ChannelBooking[]> {
  const token = await getToken();

  const res = await fetch(
    `${AVITO_API}/messenger/v3/accounts/${userId}/chats?unread_only=true`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (!res.ok) return [];

  const data = await res.json() as { chats?: unknown[] };
  const chats = data.chats ?? [];

  // Возвращаем как ChannelBooking с пустой датой — это лиды, не полноценные брони
  return chats.map((chat: unknown) => {
    const c = chat as Record<string, unknown>;
    const context = c.context as Record<string, unknown> | undefined;
    const users = c.users as Array<Record<string, unknown>> | undefined;
    const caller = users?.find(u => u.id !== userId);

    return {
      external_id:   String(c.id ?? ''),
      channel:       'avito' as ChannelName,
      tour_id:       Number((context?.value as Record<string, unknown>)?.id ?? 0),
      status:        'new' as const,
      tourist_name:  String(caller?.name ?? 'Не указано'),
      tourist_email: '',
      tourist_phone: '',
      participants:  1,
      booking_date:  '',
      amount:        0,
      raw_payload:   c as Record<string, unknown>,
    };
  });
}

// ── ChannelAdapter interface ──────────────────────────────────────────────

export const avitoAdapter: ChannelAdapter = {
  name: 'avito' as ChannelName,

  async pushBooking(_input: PushBookingInput): Promise<PushBookingResult> {
    // Авито — доска объявлений, не маркетплейс.
    // Бронирование происходит на vedarai.ru — ссылка зашита в описание тура.
    // Авито используется только для генерации лидов (трафик → наш сайт).
    return { success: false, error: 'Авито не поддерживает прямое бронирование — пользователи направляются на vedarai.ru' };
  },

  async pollOrders(_since: Date): Promise<ChannelBooking[]> {
    const userId = process.env.AVITO_USER_ID;
    if (!userId || !process.env.AVITO_CLIENT_ID) return [];  // не настроен

    try {
      return await fetchAvitoLeads(userId);
    } catch {
      return [];
    }
  },
};
