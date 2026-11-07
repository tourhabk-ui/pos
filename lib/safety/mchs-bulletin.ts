/**
 * Суточная сводка ГУ МЧС Камчатки: период, место дороги, сверка тура и маршрута.
 *
 * Текст сюда приходит уже из официального канала (VK, MAX, RSS 41.mchs.gov.ru).
 * Чего в тексте нет — не достраивается: нет периода, нет названного вулкана,
 * нет участка дороги — соответствующее поле пустое, а не угаданное.
 */

import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';
import { UNDATED_ALERT_HORIZON_DAYS } from '@/lib/safety/alert-horizon';

export interface BulletinPeriod {
  /** Как в сводке, без года, если источник год не написал: «06:00 24.10–06:00 25.10». */
  label: string;
}

const PERIOD_RE =
  /(?:с\s+)?(\d{1,2}:\d{2})\s+(\d{1,2})\.(\d{1,2})\.?(?:\s*(?:\d{4}|\d{2}))?\s*(?:по|до|[–—-])\s*(?:по\s+)?(\d{1,2}:\d{2})\s+(\d{1,2})\.(\d{1,2})\.?/;

function pad2(n: string): string {
  return n.padStart(2, '0');
}

function validTime(t: string): boolean {
  const [h, m] = t.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function validDay(day: string, month: string): boolean {
  const d = Number(day);
  const mo = Number(month);
  return d >= 1 && d <= 31 && mo >= 1 && mo <= 12;
}

/** Период, который сводка назвала сама. Не разобралось — null, не «сегодня». */
export function parseBulletinPeriod(text: string): BulletinPeriod | null {
  const m = PERIOD_RE.exec(text);
  if (!m) return null;
  const t1 = m[1];
  const d1 = m[2];
  const mo1 = m[3];
  const t2 = m[4];
  const d2 = m[5];
  const mo2 = m[6];
  if (!validTime(t1) || !validTime(t2) || !validDay(d1, mo1) || !validDay(d2, mo2)) return null;
  return { label: `${pad2(t1.split(':')[0])}:${pad2(t1.split(':')[1])} ${pad2(d1)}.${pad2(mo1)}–${pad2(t2.split(':')[0])}:${pad2(t2.split(':')[1])} ${pad2(d2)}.${pad2(mo2)}` };
}

/** Дописать к описанию период и ссылку источника, если их ещё нет в тексте. */
export function citeBulletin(description: string, sourceUrl: string | null, period: string | null): string {
  const bits: string[] = [];
  if (period && !description.includes(period)) bits.push(`Период сводки: ${period}.`);
  if (sourceUrl && !description.includes(sourceUrl)) bits.push(`Источник: ${sourceUrl}`);
  if (bits.length === 0) return description.slice(0, 800);
  const extra = bits.join(' ');
  const room = 800 - extra.length - 1;
  if (room < 40) return description.slice(0, 800);
  return `${description.slice(0, room).trim()} ${extra}`.slice(0, 800);
}

/**
 * Заголовок дорожного ограничения в форме, которую баннер читает как место.
 * Только если участок или округ названы в самом тексте.
 */
export function roadBannerTitle(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const verb = /закрыт|перекрыт/i.test(raw) ? 'проезд закрыт' : 'проезд ограничен';
  if (/левашов/i.test(raw) && /октябрьск/i.test(raw)) {
    return `Мыс Левашова (п. Октябрьский): ${verb}`;
  }
  const district = raw.match(/Усть-Большерецк[а-яё]*|Елизовск[а-яё]*|Мильковск[а-яё]*|Соболевск[а-яё]*|Быстринск[а-яё]*|Усть-Камчатск[а-яё]*/);
  if (!district) return null;
  return `${districtLabel(district[0])}: ${verb}`;
}

const DISTRICT_STEMS = ['усть-большерецк', 'елизовск', 'мильковск', 'соболевск', 'быстринск', 'усть-камчатск'];

/** «Усть-Большерецком» и «Усть-Большерецкий» — то же имя, что «Усть-Большерецк». */
function districtLabel(word: string): string {
  const n = word.toLowerCase().replace(/ё/g, 'е');
  const stem = DISTRICT_STEMS.find((s) => n.startsWith(s));
  return stem ? word.slice(0, stem.length) : word;
}

export interface ActiveWarning {
  kind: 'volcano' | 'road';
  place: string;
  stems: string[];
  period: string | null;
  sourceUrl: string | null;
  /**
   * День Камчатки (YYYY-MM-DD), до которого строка о чём-то говорит: срок
   * строки, а без срока — горизонт сводки от её даты
   * (`UNDATED_ALERT_HORIZON_DAYS`). null или нет поля — не известно, и строка
   * судится как действующая.
   */
  relevantUntil?: string | null;
  /**
   * Период, названный сводкой, уже кончился. Строка в базе живёт дольше
   * периода (публикация + 24–48 ч, `seismic-parser`), поэтому «строка жива»
   * не значит «сводка действует». Случай 07.11: в 12:50 Кузьмич назвал
   * «активными» запреты из сводки на 06:00 06.11–06:00 07.11. Истёкшая сводка
   * не прячется — она называется прошедшей. Нет поля или период не разобран —
   * не известно, и строка говорит без «истёк».
   */
  ended?: boolean;
}

export interface AlertWarningRow {
  alert_type?: string | null;
  title?: string | null;
  description?: string | null;
  source_url?: string | null;
  volcano_name?: string | null;
  /**
   * Срок строки (ISO, UTC): публикация + 24–48 ч (`seismic-parser`), а не конец
   * периода сводки. Конец периода читается из текста — `periodEndMs`.
   */
  expires_iso?: string | null;
  /** Дата последней сводки (ISO, UTC). */
  published_iso?: string | null;
}

/** Камчатка — UTC+12 круглый год. */
const KAMCHATKA_OFFSET_MS = 12 * 3_600_000;

/**
 * Конец периода сводки «06:00 06.11–06:00 07.11» — момент UTC в мс; null —
 * период не разобран или года не из чего взять. Года в сводке нет: он берётся
 * из даты публикации по Камчатке, а период, кончающийся в январе после
 * декабрьской публикации, — в следующем году.
 */
export function periodEndMs(label: string | null, publishedIso: string | null | undefined): number | null {
  if (!label || !publishedIso) return null;
  const m = /–(\d{2}):(\d{2}) (\d{2})\.(\d{2})$/.exec(label);
  const published = Date.parse(publishedIso);
  if (!m || Number.isNaN(published)) return null;
  const [y, pubMonth] = kamchatkaDate(new Date(published)).split('-').map(Number);
  const month = Number(m[4]);
  const year = month < pubMonth - 6 ? y + 1 : y;
  return Date.UTC(year, month - 1, Number(m[3]), Number(m[1]), Number(m[2])) - KAMCHATKA_OFFSET_MS;
}

/** До какого дня Камчатки строка о чём-то говорит; null — не известно. */
export function relevantUntilOf(row: AlertWarningRow): string | null {
  const at = (iso: string | null | undefined): Date | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : new Date(t);
  };
  const expires = at(row.expires_iso);
  if (expires) return kamchatkaDate(expires);
  const published = at(row.published_iso);
  return published ? shiftDate(kamchatkaDate(published), UNDATED_ALERT_HORIZON_DAYS) : null;
}

const ROAD_STOP = new Set([
  'проезд', 'закрыт', 'закрыта', 'ограничен', 'ограничение', 'дорога', 'дороге', 'автодорога',
  'участок', 'транспорта', 'пассажирского', 'камчатка', 'округ', 'округе',
]);

function stemsOf(place: string): string[] {
  const n = place.toLowerCase().replace(/ё/g, 'е');
  const stems = new Set<string>();
  const adj = n.match(/^(.+?)(ий|ый|ой|ая)$/);
  if (adj && adj[1].length >= 5) stems.add(adj[1]);
  if (n.endsWith('а') && n.length >= 8) stems.add(n.slice(0, -1));
  if (n.length >= 5) stems.add(n);
  return [...stems];
}

function roadWordStem(word: string): string | null {
  if (word.length < 6 || ROAD_STOP.has(word)) return null;
  const ending = word.match(/(ого|ому|ыми|ими|ом|ем|ой|ый|ий|ая|ое|ые|ых|их|ам|ям)$/);
  if (ending && word.length - ending[1].length >= 6) return word.slice(0, -ending[1].length);
  if (word.endsWith('а') && word.length >= 8) return word.slice(0, -1);
  return word;
}

function roadStems(place: string): string[] {
  const stems = new Set<string>();
  // Скобка «(п. Октябрьский)» — уточнение участка, не отдельное имя:
  // голое «октябрьский» есть у месяца и у других посёлков.
  const withoutParen = place.replace(/\([^)]*\)/g, ' ');
  for (const word of withoutParen.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9-]+/i)) {
    const stem = roadWordStem(word);
    if (stem && stem.length >= 6) stems.add(stem);
  }
  return [...stems];
}

function volcanoFromTitle(title: string): string | null {
  const m = /^Вулкан\s+([^:]{2,40}):/.exec(title.trim());
  const name = m?.[1]?.trim();
  return name && name.length >= 4 ? name : null;
}

function roadPlace(title: string, description: string): string | null {
  const banner = roadBannerTitle(title) ?? roadBannerTitle(description);
  if (!banner) return null;
  const head = banner.split(':')[0]?.trim() ?? '';
  return head.length >= 4 ? head : null;
}

/**
 * Строки external_alerts → предупреждения, которыми сверяют тур и маршрут.
 * `nowMs` — «сейчас» для признака `ended` (истёк ли период сводки).
 */
export function warningsFromRows(rows: readonly AlertWarningRow[], nowMs: number = Date.now()): ActiveWarning[] {
  const out: ActiveWarning[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const type = row.alert_type ?? '';
    const period = parseBulletinPeriod(row.description ?? '')?.label ?? null;
    const sourceUrl = row.source_url?.trim() || null;
    const relevantUntil = relevantUntilOf(row);
    const end = periodEndMs(period, row.published_iso);
    const ended = end !== null && end <= nowMs;
    if (type === 'volcanic_eruption') {
      const place = row.volcano_name?.trim() || volcanoFromTitle(row.title ?? '') || '';
      if (!place) continue;
      const key = `v:${place.toLowerCase()}`;
      if (seen.has(key)) continue;
      const stems = stemsOf(place);
      if (stems.length === 0) continue;
      seen.add(key);
      out.push({ kind: 'volcano', place, stems, period, sourceUrl, relevantUntil, ended });
    } else if (type === 'road_closure') {
      const place = roadPlace(row.title ?? '', row.description ?? '');
      if (!place) continue;
      const key = `r:${place.toLowerCase()}`;
      if (seen.has(key)) continue;
      const stems = roadStems(place);
      if (stems.length === 0) continue;
      seen.add(key);
      out.push({ kind: 'road', place, stems, period, sourceUrl, relevantUntil, ended });
    }
  }
  return out;
}

/**
 * Сводки МЧС, которые говорят о поездке с датой начала `tripStartIso`, и те,
 * что кончаются до неё (разбор 06.11: сводка о перекрытой на сутки дороге
 * стояла в плане на июль следующего года как факт дня). Без даты начала —
 * всё «как сейчас»; срок строки не известен — строка остаётся.
 */
export function splitWarningsForTrip(
  warnings: readonly ActiveWarning[],
  tripStartIso: string | null,
): { forTrip: ActiveWarning[]; endedBefore: ActiveWarning[] } {
  if (!tripStartIso) return { forTrip: [...warnings], endedBefore: [] };
  const forTrip: ActiveWarning[] = [];
  const endedBefore: ActiveWarning[] = [];
  for (const w of warnings) {
    if (w.relevantUntil && w.relevantUntil < tripStartIso) endedBefore.push(w);
    else forTrip.push(w);
  }
  return { forTrip, endedBefore };
}

/** Строка плана, когда сегодняшние сводки к датам поездки не относятся. */
export function mchsBeforeTripNote(endedBefore: readonly ActiveWarning[], tripStartIso: string): string {
  const places = [...new Set(endedBefore.map((w) => w.place))].slice(0, 4).join('; ');
  const [, m, d] = tripStartIso.split('-');
  return `Сводки МЧС на сегодня (${places}) к датам поездки с ${d}.${m} не относятся: их срок кончается раньше. `
    + 'Обстановку на свои даты проверьте ближе к выезду — сводка выходит ежедневно.';
}

export function offeringMatches(text: string, warning: ActiveWarning): boolean {
  const hay = text.toLowerCase().replace(/ё/g, 'е');
  return warning.stems.some((stem) => hay.includes(stem));
}

/**
 * Строка под ответом или днём плана — для человека, а не правило для модели.
 * До 07.11 она кончалась фразой «Это нельзя называть безопасным или без
 * риска», и турист читал инструкцию, написанную модели. Начало «МЧС: »
 * постоянное — по нему строку узнаёт правка плана (`isOfferingNote`).
 * Истёкший период — прошедшим временем: строка в базе жива, а сводка уже нет.
 */
export function offeringSentence(warning: ActiveWarning): string {
  const what = warning.kind === 'volcano'
    ? `к вулкану ${warning.place} рекомендовано не приближаться`
    : `проезд — ${warning.place}`;
  if (warning.ended && warning.period) {
    const source = warning.sourceUrl ? ` (источник ${warning.sourceUrl})` : '';
    return `МЧС: ${what} — по сводке на ${warning.period}; её срок истёк, обстановку на сегодня проверьте в свежей сводке${source}.`;
  }
  const cite = [
    warning.period ? `сводка на ${warning.period}` : null,
    warning.sourceUrl ? `источник ${warning.sourceUrl}` : null,
  ].filter((x): x is string => Boolean(x)).join(', ');
  return `МЧС: ${what}${cite ? ` (${cite})` : ''}.`;
}

/** Строка сводки МЧС на дне плана или под ответом (`offeringSentence`). */
export function isOfferingNote(text: string): boolean {
  return /^МЧС: (?:к вулкану .+ рекомендовано не приближаться|проезд — )/.test(text);
}

export function notesForOffering(text: string, warnings: readonly ActiveWarning[]): string[] {
  return warnings.filter((w) => offeringMatches(text, w)).map(offeringSentence);
}

/**
 * Зона планера, только если место предупреждения уже привязано к ней
 * картой округов и вулканов. Нет привязки — пусто, зону не угадываем.
 * Ключи совпадают с VOLCANO_ZONES и округами в seismic-parser.
 */
const PLAN_ZONE_BY_PLACE: Array<[RegExp, string]> = [
  [/шивелуч|ключевск|безымянн|толбачик|усть-камчатск|мильков/, 'northern'],
  [/крашенинников|карымск|кроноцк/, 'eastern'],
  [/авачинск|корякск|мутновск|горелый|вилючинск|елизов|петропавловск/, 'avachinsky'],
  [/ичинск|усть-большерецк|левашов|соболев|быстринск/, 'western'],
];

function plannerZones(warning: ActiveWarning): string[] {
  const place = warning.place.toLowerCase().replace(/ё/g, 'е');
  const zones = new Set<string>();
  for (const [re, zone] of PLAN_ZONE_BY_PLACE) {
    if (re.test(place)) zones.add(zone);
  }
  return [...zones];
}

/**
 * День плана: тур или маршрут, в тексте которого названо место, либо день
 * в зоне, к которой это место уже привязано. Чужую зону предупреждение не красит.
 */
export function notesForPlanDay(text: string, zones: readonly string[], warnings: readonly ActiveWarning[]): string[] {
  const notes: string[] = [];
  for (const warning of warnings) {
    const byName = offeringMatches(text, warning);
    const byZone = plannerZones(warning).some((zone) => zones.includes(zone));
    if (!byName && !byZone) continue;
    const sentence = offeringSentence(warning);
    if (!notes.includes(sentence)) notes.push(sentence);
  }
  return notes;
}

export function warningDigest(warnings: readonly ActiveWarning[]): string | null {
  if (warnings.length === 0) return null;
  const volcanoes = warnings.filter((w) => w.kind === 'volcano').map((w) => w.place);
  const roads = warnings.filter((w) => w.kind === 'road').map((w) => w.place);
  const parts: string[] = [];
  if (volcanoes.length > 0) parts.push(`не приближаться к вулканам ${volcanoes.join(', ')}`);
  if (roads.length > 0) parts.push(`проезд ограничен: ${roads.join('; ')}`);
  if (parts.length === 0) return null;
  const period = warnings.find((w) => w.period)?.period ?? null;
  const source = warnings.find((w) => w.sourceUrl)?.sourceUrl ?? null;
  const allEnded = warnings.every((w) => w.ended);
  const when = period ? (allEnded ? `сводка на ${period}, её срок истёк` : `сводка на ${period}`) : null;
  const cite = [when, source ? `источник ${source}` : null]
    .filter((x): x is string => Boolean(x)).join(', ');
  return `МЧС: ${parts.join('. ')}${cite ? ` (${cite})` : ''}. ${DIGEST_TAIL}`;
}

/** Конец строки-сводки: по нему видно, что поправка к «безопасно» уже стоит. */
export const DIGEST_TAIL = 'Безопасными эти места назвать нельзя.';

/**
 * Сводка не прочиталась. Строка идёт и туристу под ответом, и в промпт — как
 * знак «сводки нет», поэтому она одна и написана для человека.
 */
export const MCHS_UNREAD_NOTE =
  'Сводку МЧС сейчас прочитать не удалось — судить, безопасны ли эти места, не по чему. Перед выходом проверьте обстановку: 112.';

/** Блок для промпта. Разбор обратный — warningsFromBlock. */
export function formatWarningBlock(warnings: readonly ActiveWarning[]): string {
  if (warnings.length === 0) return '';
  const lines = warnings.map((w) => {
    const kind = w.kind === 'volcano' ? 'вулкан' : 'дорога';
    const period = w.period ? `${w.period}${w.ended ? ENDED_MARK : ''}` : 'не указан в сводке';
    const source = w.sourceUrl ?? '-';
    return `${kind} | ${w.place} | период ${period} | источник ${source}`;
  });
  return [
    'ПРЕДУПРЕЖДЕНИЯ МЧС ИЗ ПОСЛЕДНИХ СВОДОК:',
    ...lines,
    'Туры у названных вулканов и маршруты по названным дорогам нельзя называть безопасными или без риска.',
    `Период с пометкой «${ENDED_MARK.slice(2)}» уже кончился: говори о такой сводке в прошедшем времени («сводка на … рекомендовала»), не называй её действующей или активной.`,
  ].join('\n');
}

/** Пометка истёкшего периода в блоке промпта; `warningsFromBlock` читает её обратно. */
const ENDED_MARK = ', срок истёк';

const BLOCK_LINE = /^(вулкан|дорога) \| ([^|\n]+?) \| период ([^|\n]+?) \| источник (\S+)/gm;

export function warningsFromBlock(text: string): ActiveWarning[] {
  const out: ActiveWarning[] = [];
  for (const m of text.matchAll(BLOCK_LINE)) {
    const kind = m[1] === 'вулкан' ? 'volcano' as const : 'road' as const;
    const place = m[2].trim();
    const periodRaw = m[3].trim();
    const sourceRaw = m[4].trim();
    const ended = periodRaw.endsWith(ENDED_MARK);
    const periodText = ended ? periodRaw.slice(0, -ENDED_MARK.length) : periodRaw;
    const period = periodText === 'не указан в сводке' ? null : periodText;
    const sourceUrl = sourceRaw === '-' ? null : sourceRaw;
    const stems = kind === 'volcano' ? stemsOf(place) : roadStems(place);
    if (!place || stems.length === 0) continue;
    out.push({ kind, place, stems, period, sourceUrl, ended });
  }
  return out;
}

/**
 * Утверждение «безопасно»: «безопасно», «безопасный маршрут», «вы в
 * безопасности», «без риска». Тема «о безопасности», «безопасность — главное»
 * утверждением не считается: 07.11 ответ начинался «Сначала о безопасности —
 * это главное», и это читалось как «безопасно».
 */
const ALL_CLEAR = /(?:^|[^а-яё])(?:безопасн(?:о|а|ы|ый|ая|ое|ые|ым|ую|ого|ой)(?![а-яё])|в безопасности|без риска|риска нет)/i;

/** Строка сводки называет все предупреждения сразу. Это не упоминание тура. */
function withoutWarningDigest(answer: string): string {
  return answer
    .split('\n')
    .filter((line) => !/не приближаться к вулканам |проезд ограничен: /.test(line) && !line.includes(DIGEST_TAIL))
    .join('\n');
}

/**
 * Ответ уже сказал о запрете у этого места: в одном предложении — место и
 * «не приближаться» (или «не подходить», «запрет»). Тогда строка-повтор не
 * дописывается — 07.11 оба вулкана были названы в первом абзаце, а две строки
 * МЧС ниже повторили их слово в слово. Истёкшая сводка дописывается всегда:
 * её срок ответ мог назвать неверно.
 */
function alreadySaid(answer: string, warning: ActiveWarning): boolean {
  if (warning.ended) return false;
  const near = warning.kind === 'volcano' ? /не\s+приближ|не\s+подход|запрет/i : /закрыт|перекрыт|ограничен|запрет/i;
  return answer.split(/[.!?\n]+/).some((s) => near.test(s) && offeringMatches(s, warning));
}

/**
 * Дописать к ответу флаги по названным в нём местам.
 * Общее «безопасно» при живых предупреждениях тоже не оставляется без оговорки.
 * Сводка внизу ответа не считается упоминанием каждого места из неё.
 */
export function appendOfferingFlags(answer: string, warnings: readonly ActiveWarning[]): string {
  if (!answer.trim() || warnings.length === 0) return answer;
  const text = withoutWarningDigest(answer);
  const notes: string[] = [];
  for (const w of warnings) {
    if (!offeringMatches(text, w) || alreadySaid(text, w)) continue;
    const note = offeringSentence(w);
    if (!answer.includes(note) && !notes.includes(note)) notes.push(note);
  }
  if (ALL_CLEAR.test(answer) && !answer.includes(DIGEST_TAIL)) {
    const digest = warningDigest(warnings);
    if (digest) notes.unshift(digest);
  }
  if (notes.length === 0) return answer;
  return `${answer.trim()}\n\n${notes.join('\n')}`;
}

/**
 * Сводка не прочиталась. «Безопасно» в ответе без этой оговорки читается
 * как «предупреждений нет» — этого мы не знаем.
 */
export function appendUnreadSafety(answer: string, unread: boolean): string {
  if (!unread || !answer.trim() || answer.includes(MCHS_UNREAD_NOTE)) return answer;
  if (!ALL_CLEAR.test(answer)) return answer;
  return `${answer.trim()}\n\n${MCHS_UNREAD_NOTE}`;
}
