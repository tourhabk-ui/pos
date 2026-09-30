/**
 * lib/kuzmich/watch-flow.ts — контроль выхода из чата Кузьмича (Telegram, MAX).
 *
 * Владелец 30.09: «зачем что-то в наше время заполнять вручную, если можно
 * делать это из чата?» Человек пишет «еду на Чёртов мост, вернусь к 19:00,
 * если задержусь — сообщите маме +7 914 …», Кузьмич собирает недостающее,
 * показывает итог — и контроль включается только после явного «да».
 *
 * Здесь НЕТ языковой модели, и это решение, а не упрощение
 * (docs/safety/WATCH_MANIFEST.md, правило 3). Разбор срока, телефона и
 * подтверждения — детерминированный: модель, которая «поняла» из «ну вроде
 * к вечеру» девятнадцать часов, включила бы тревогу не в тот час, и узнать
 * об этом было бы неоткуда. Не разобрали — переспрашиваем с примером.
 * Итог показывается человеку целиком, и включает контроль только «да».
 *
 * Запись контроля — lib/safety/trip-watch.ts, сторож — checkin-watchdog.
 */
import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { kamchatkaDate, shiftDate, isRealDate, ruShort, DAY_MS } from '@/lib/analytics/kamchatka-day';
import { kamchatkaWallTime, formatKamchatkaTime, BUFFERS } from '@/lib/safety/checkin-escalation';
import {
  createTripWatch, openWatchesForChat, closeTripWatch, type TouristChannel,
} from '@/lib/safety/trip-watch';

/** Черновик живёт полчаса — как и заявка на тур. */
export const WATCH_DRAFT_TTL_MS = 30 * 60 * 1000;
/** Дальше месяца контроль из чата не ставится: это уже экспедиция, ей нужна форма и МЧС. */
export const WATCH_MAX_AHEAD_MS = 30 * DAY_MS;

export type WatchStep = 'where' | 'return' | 'contact' | 'contact_name' | 'leader_phone' | 'confirm';

export interface WatchDraft {
  step: WatchStep;
  where?: string;
  returnDate?: string; // YYYY-MM-DD по Камчатке
  returnTime?: string; // HH:MM
  contactPhone?: string;
  contactName?: string;
  leaderPhone?: string;
  startedAt: number;
}

// ── Разбор: чистые функции ────────────────────────────────────────────────────

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Слово целиком, без знаков: «Да!» → «да», «Вернулся.» → «вернулся». */
function bare(text: string): string {
  return norm(text).replace(/[.,!?;:«»"'()\-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const TRIGGERS: RegExp[] = [
  /поставь(те)? (меня )?на контрол/,
  /контрол[ьяюе]? выход/,
  /если (я |мы )?(не вернусь|не вернемся|задержусь|задержимся|не выйду на связь|не выйдем на связь|пропаду|пропадем)/,
  /^\/watch\b/,
];

export function isWatchTrigger(text: string): boolean {
  const t = norm(text);
  return TRIGGERS.some((r) => r.test(t));
}

const RETURNED = new Set(['вернулся', 'вернулась', 'вернулись', 'я вернулся', 'я вернулась', 'мы вернулись', 'back', '/back']);
// Без «ок»: отметка отодвигает тревогу, и случайное «ок» в разговоре не должно
// её отодвигать.
const DELAYED = new Set(['задерживаюсь', 'задерживаемся', 'я в порядке', 'мы в порядке']);
const CONFIRM = new Set(['да', 'подтверждаю', 'да подтверждаю', 'ставь', 'да ставь', 'включай', 'да включай']);
const CANCEL = new Set(['нет', 'отмена', 'отменить', 'стоп', 'не надо', '/cancel']);

/**
 * Только сообщение ЦЕЛИКОМ. Подстрока здесь опасна: «я не вернулся» содержит
 * «вернулся», а «ок» живёт внутри «около» — закрыть контроль живого человека
 * из-за совпадения букв нельзя (правило 3).
 */
export const isReturnedCommand = (text: string) => RETURNED.has(bare(text));
export const isDelayedCommand = (text: string) => DELAYED.has(bare(text));
export const isConfirm = (text: string) => CONFIRM.has(bare(text));
export const isCancel = (text: string) => CANCEL.has(bare(text));

/** Российский мобильный или городской номер → +7XXXXXXXXXX; иначе null. */
export function extractPhone(text: string): string | null {
  const m = text.match(/(?:\+7|(?<!\d)8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  return `+7${digits.slice(1)}`;
}

/** Куда идут — из фразы «еду на …», «иду к …». Не нашли — спросим. */
export function extractDestination(text: string): string | null {
  const m = text.match(
    /(?:еду|иду|идем|идём|едем|пойду|поеду|пойдем|пойдём|поедем|выхожу|выходим|собираюсь|собираемся|сплавляюсь|сплавляемся)\s+(?:на|в|во|к|ко)\s+([^,.;!?\n]{2,80})/i,
  );
  if (!m) return null;
  const cut = m[1].split(/\s+(?:если|вернусь|вернемся|вернёмся|до|к\s+\d|в\s+\d|сегодня|завтра|послезавтра|и\s+вернусь)(?!\p{L})/iu)[0].trim();
  return cut.length >= 2 ? cut : null;
}

export type ReturnParse =
  | { ok: true; date: string; time: string }
  | { ok: false; reason: 'no_time' | 'bad_date' | 'past' | 'too_far' };

/**
 * Срок возвращения из текста: «сегодня 19:00», «завтра к 12», «03.10 18:30»,
 * «к 19:00». Без даты — сегодня. Срок в прошлом или дальше месяца — отказ,
 * а не догадка «наверное, завтра».
 */
export function parseReturn(text: string, now: Date): ReturnParse {
  const t = norm(text);
  const today = kamchatkaDate(now);

  let date = today;
  const dm = t.match(/(?<![\d:])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\d:])/);
  if (/послезавтра/.test(t)) date = shiftDate(today, 2);
  else if (/завтра/.test(t)) date = shiftDate(today, 1);
  else if (dm) {
    const year = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : Number(today.slice(0, 4));
    const candidate = `${year}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    if (!isRealDate(candidate)) return { ok: false, reason: 'bad_date' };
    date = candidate;
    // «03.01» в декабре — январь следующего года, если год не назван.
    if (!dm[3] && date < today) date = `${year + 1}${date.slice(4)}`;
  }

  let hh: number | null = null;
  let mm = 0;
  const tm = t.match(/(?<![\d.])(\d{1,2}):(\d{2})(?![\d.])/);
  const hm = t.match(/(?:^|\s)(?:к|в|до)\s+(\d{1,2})(?:\s*(?:ч|час|часам|часов|часа))?(?![\d.:])/);
  if (tm) { hh = Number(tm[1]); mm = Number(tm[2]); }
  else if (hm) { hh = Number(hm[1]); }
  if (hh === null || hh > 23 || mm > 59) return { ok: false, reason: 'no_time' };

  const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const at = kamchatkaWallTime(date, time);
  if (at.getTime() <= now.getTime()) return { ok: false, reason: 'past' };
  if (at.getTime() - now.getTime() > WATCH_MAX_AHEAD_MS) return { ok: false, reason: 'too_far' };
  return { ok: true, date, time };
}

/** Имя контакта: текст без телефона и служебных слов. */
export function extractContactName(text: string): string | null {
  const phone = text.match(/(?:\+7|(?<!\d)8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)/);
  const rest = (phone ? text.replace(phone[0], ' ') : text)
    // \b в JS не видит кириллицу — граница слова через \p{L} и флаг u.
    .replace(/(?<!\p{L})(сообщите|сообщить|позвоните|позвонить|напишите|написать|по номеру|номер|телефон|тел)(?!\p{L})\.?/giu, ' ')
    .replace(/[,:;\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (rest.length < 2 || rest.length > 80) return null;
  return rest;
}

// ── Тексты ────────────────────────────────────────────────────────────────────

function whenText(date: string, time: string, now: Date): string {
  const today = kamchatkaDate(now);
  const day = date === today ? 'сегодня' : date === shiftDate(today, 1) ? 'завтра' : ruShort(date);
  return `${day}, ${ruShort(date)}, ${time} по камчатскому времени`;
}

/**
 * Итог, который человек подтверждает. Лестница названа своими числами
 * (checkin-escalation.ts, BUFFERS): человек должен знать, что и когда
 * случится, если он не отметится, — и что спасателей вызывает не автомат.
 */
export function watchSummary(d: WatchDraft, now: Date): string {
  const b = BUFFERS[d.returnDate === kamchatkaDate(now) ? 'day' : 'multi'];
  const [soft, hard, duty] = [b.soft, b.hard, b.mchs];
  return [
    'Проверьте, всё ли верно:',
    '',
    `Куда: ${escapeHtml(d.where)}`,
    `Вернусь: ${whenText(d.returnDate ?? '', d.returnTime ?? '', now)}`,
    `Ваш телефон: ${escapeHtml(d.leaderPhone)}`,
    `Кому сообщить: ${escapeHtml(d.contactName)}, ${escapeHtml(d.contactPhone)}`,
    '',
    'Если к сроку не напишете «вернулся»:',
    `- через ${soft} ч спрошу вас здесь;`,
    `- через ${hard} ч сообщу ${escapeHtml(d.contactName)};`,
    `- через ${duty} ч передам дежурному Ведара вашу последнюю точку и данные. Спасателей вызывает дежурный, а не автомат.`,
    '',
    'Ответьте «да», чтобы включить контроль, или «нет», чтобы отменить.',
  ].join('\n');
}

const ASK: Record<Exclude<WatchStep, 'confirm'>, string> = {
  where: 'Куда идёте? Например: «Чёртов мост» или «Авачинский перевал, радиально».',
  return: 'Когда вернётесь? Например: «сегодня 19:00», «завтра к 12», «03.10 18:30». Время — камчатское.',
  contact: 'Кому сообщить, если не вернётесь к сроку? Имя и телефон, например: «Марина +7 914 123-45-67».',
  contact_name: 'Как зовут человека, которому сообщить?',
  leader_phone: 'Ваш телефон — по нему вас будут искать. Например: +7 914 123-45-67.',
};

const RETURN_ERR: Record<Exclude<ReturnParse, { ok: true }>['reason'], string> = {
  no_time: 'Не понял время. Напишите, например: «сегодня 19:00» или «завтра к 12».',
  bad_date: 'Такой даты нет. Напишите, например: «03.10 18:30».',
  past: 'Этот срок уже прошёл. Когда вернётесь? Например: «сегодня 21:00».',
  too_far: 'Из чата контроль ставится не дальше чем на месяц. Для долгого похода — форма vedarai.ru/register.',
};

function nextStep(d: WatchDraft): WatchStep {
  if (!d.where) return 'where';
  if (!d.returnDate || !d.returnTime) return 'return';
  if (!d.contactPhone) return 'contact';
  if (!d.contactName) return 'contact_name';
  if (!d.leaderPhone) return 'leader_phone';
  return 'confirm';
}

function prompt(d: WatchDraft, now: Date): string {
  return d.step === 'confirm' ? watchSummary(d, now) : ASK[d.step];
}

/**
 * Черновик из первой фразы: забираем всё, что названо явно. Первый телефон
 * фразы — телефон КОНТАКТА: в ней человек говорит, кому сообщить, а свой
 * номер спрашивается отдельно.
 */
export function draftFromTrigger(text: string, now: Date, startedAt: number): WatchDraft {
  const d: WatchDraft = { step: 'where', startedAt };
  const where = extractDestination(text);
  if (where) d.where = where;
  const r = parseReturn(text, now);
  if (r.ok) { d.returnDate = r.date; d.returnTime = r.time; }
  const phone = extractPhone(text);
  if (phone) d.contactPhone = phone;
  d.step = nextStep(d);
  return d;
}

/** Один шаг черновика: вернуть черновик и ответ. Не разобрали — тот же шаг и пример. */
export function advanceDraft(d: WatchDraft, text: string, now: Date): { draft: WatchDraft; reply: string } {
  const next: WatchDraft = { ...d };
  switch (d.step) {
    case 'where': {
      const w = text.trim().replace(/\s+/g, ' ');
      if (w.length < 2 || w.length > 120) return { draft: d, reply: ASK.where };
      next.where = w;
      break;
    }
    case 'return': {
      const r = parseReturn(text, now);
      if (!r.ok) return { draft: d, reply: RETURN_ERR[r.reason] };
      next.returnDate = r.date;
      next.returnTime = r.time;
      break;
    }
    case 'contact': {
      const p = extractPhone(text);
      if (!p) return { draft: d, reply: `Не нашёл телефон. ${ASK.contact}` };
      next.contactPhone = p;
      const n = extractContactName(text);
      if (n) next.contactName = n;
      break;
    }
    case 'contact_name': {
      const n = extractContactName(text);
      if (!n) return { draft: d, reply: ASK.contact_name };
      next.contactName = n;
      break;
    }
    case 'leader_phone': {
      const p = extractPhone(text);
      if (!p) return { draft: d, reply: `Не нашёл телефон. ${ASK.leader_phone}` };
      if (p === next.contactPhone) {
        return { draft: d, reply: 'Это номер контакта. Нужен ваш собственный телефон — тот, что будет с вами.' };
      }
      next.leaderPhone = p;
      break;
    }
    case 'confirm':
      return { draft: d, reply: 'Ответьте «да», чтобы включить контроль, или «нет», чтобы отменить.' };
  }
  next.step = nextStep(next);
  return { draft: next, reply: prompt(next, now) };
}

// ── Хранение черновика ────────────────────────────────────────────────────────
// Отказ базы не глушится (§4.0): черновик контроля — не заявка на тур, и
// «потерялся молча» здесь значит «человек думает, что его ждут, а его не ждут».

async function loadDraft(channel: TouristChannel, chatId: number): Promise<WatchDraft | null> {
  const { rows } = await pool.query<{ state: WatchDraft }>(
    `SELECT state FROM trip_watch_flow WHERE channel = $1 AND chat_id = $2`,
    [channel, chatId],
  );
  return rows[0]?.state ?? null;
}

async function saveDraft(channel: TouristChannel, chatId: number, d: WatchDraft): Promise<void> {
  await pool.query(
    `INSERT INTO trip_watch_flow (channel, chat_id, state, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (channel, chat_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [channel, chatId, JSON.stringify(d)],
  );
}

export async function deleteWatchDraft(channel: TouristChannel, chatId: number): Promise<void> {
  await pool.query(`DELETE FROM trip_watch_flow WHERE channel = $1 AND chat_id = $2`, [channel, chatId]);
}

// ── Вход из processMessage ────────────────────────────────────────────────────

export interface WatchMessage {
  channel: TouristChannel;
  chatId: number;
  text: string;
  userName: string | null;
  reply: (chatId: number, text: string) => Promise<void>;
  now?: Date;
}

const FAIL_TEXT =
  'Не получилось включить контроль — сбой на нашей стороне, и я не буду делать вид, что всё в порядке. ' +
  'Поставьте контроль через форму vedarai.ru/register или предупредите близких сами. В беде — 112.';

/**
 * true — сообщение про контроль выхода и обработано здесь; false — не про
 * него, дальше идёт обычный разговор.
 */
export async function handleWatchMessage(m: WatchMessage): Promise<boolean> {
  const now = m.now ?? new Date();
  const { channel, chatId, text, reply } = m;

  if (isReturnedCommand(text)) {
    const open = await openWatchesForChat(channel, chatId);
    if (open.length === 0) {
      await reply(chatId, 'Открытого контроля выхода у этого чата нет. С возвращением!');
      return true;
    }
    for (const w of open) await closeTripWatch(w.id, 'chat');
    const names = open.map((w) => `«${escapeHtml(w.route_name)}»`).join(', ');
    await reply(chatId, `С возвращением! Контроль ${names} закрыт, тревог не будет.`);
    return true;
  }

  if (isDelayedCommand(text)) {
    const open = await openWatchesForChat(channel, chatId);
    if (open.length === 0) return false;
    await pool.query(
      `UPDATE route_registrations SET checkin_confirmed_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[]) AND completed_at IS NULL`,
      [open.map((w) => w.id)],
    );
    await reply(
      chatId,
      'Отметил: вы в порядке и задерживаетесь. Отсчёт тревог пошёл заново от этой минуты — ' +
        'не забудьте написать «вернулся», когда вернётесь.',
    );
    return true;
  }

  let draft: WatchDraft | null;
  try {
    draft = await loadDraft(channel, chatId);
  } catch (err) {
    console.error('[watch-flow] черновик не прочитан', channel, chatId, err instanceof Error ? err.message : err);
    draft = null;
  }
  if (draft && draft.startedAt < now.getTime() - WATCH_DRAFT_TTL_MS) {
    await deleteWatchDraft(channel, chatId);
    draft = null;
  }

  if (draft) {
    if (isCancel(text)) {
      await deleteWatchDraft(channel, chatId);
      await reply(chatId, 'Контроль выхода не включён.');
      return true;
    }
    if (draft.step === 'confirm' && isConfirm(text)) {
      return confirmDraft(m, draft, now);
    }
    const { draft: next, reply: answer } = advanceDraft(draft, text, now);
    await saveDraft(channel, chatId, next);
    await reply(chatId, answer);
    return true;
  }

  if (!isWatchTrigger(text)) return false;

  const d = draftFromTrigger(text, now, now.getTime());
  await saveDraft(channel, chatId, d);
  await reply(chatId, [
    'Поставлю вас на контроль выхода: если не вернётесь к сроку, я подниму тревогу.',
    '',
    prompt(d, now),
  ].join('\n'));
  return true;
}

async function confirmDraft(m: WatchMessage, d: WatchDraft, now: Date): Promise<boolean> {
  const { channel, chatId, reply } = m;
  const today = kamchatkaDate(now);
  try {
    const expectedReturnAt = kamchatkaWallTime(d.returnDate ?? '', d.returnTime ?? '');
    // Срок мог истечь, пока человек думал над «да».
    if (expectedReturnAt.getTime() <= now.getTime()) {
      const back = { ...d, step: 'return' as const, returnDate: undefined, returnTime: undefined };
      await saveDraft(channel, chatId, back);
      await reply(chatId, RETURN_ERR.past);
      return true;
    }
    await createTripWatch({
      source: channel === 'tg' ? 'telegram' : 'max',
      userId: null,
      routeName: d.where ?? '',
      routeDescription: null,
      startDate: today,
      endDate: d.returnDate ?? today,
      expectedReturnAt,
      region: 'Камчатский край',
      groupSize: 1,
      groupMembers: null,
      leaderName: m.userName?.trim() || 'турист из чата',
      leaderPhone: d.leaderPhone ?? '',
      leaderEmail: null,
      contactName: d.contactName ?? '',
      contactPhone: d.contactPhone ?? '',
      contactRelation: null,
      contactTelegramChatId: null,
      contactEmail: null,
      contactConsent: false,
      touristChat: { channel, chatId },
    });
    await deleteWatchDraft(channel, chatId);
  } catch (err) {
    console.error('[watch-flow] контроль не создан', channel, chatId, err instanceof Error ? err.message : err);
    await reply(chatId, FAIL_TEXT);
    return true;
  }
  await reply(chatId, [
    `Контроль включён. Жду вас к ${formatKamchatkaTime(kamchatkaWallTime(d.returnDate ?? '', d.returnTime ?? ''))}.`,
    '',
    'Вернётесь — напишите сюда «вернулся». Задерживаетесь, но всё в порядке — «задерживаюсь».',
    'В беде не ждите срока: 112 работает без баланса и SIM-карты.',
  ].join('\n'));
  return true;
}
