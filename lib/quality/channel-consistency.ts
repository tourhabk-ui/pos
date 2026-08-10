/**
 * lib/quality/channel-consistency.ts
 *
 * Два канала одной правды обязаны совпасть.
 *
 * Платформа рассказывает о турах трижды и по-разному: людям — каталогом,
 * поисковикам — картой сайта, ИИ-агентам — файлом llms.txt и протоколом MCP.
 * Источник у всех один, а код разный, и расхождение между ними никогда не
 * падает: каждый канал по отдельности отвечает 200 и выглядит исправным.
 *
 * Так уже было дважды. `get_tours` отдавал «Туры не найдены» при живых
 * карточках на сайте — из-за колонки, которой нет (#1048). Карта сайта
 * собиралась на билде без базы и содержала полсотни ссылок вместо сотен, при
 * живом llms.txt (#1049, #1053). Оба раза нашёл владелец, глазами, спустя
 * недели.
 *
 * Здесь — сравнение множеств. Не «отвечает ли канал», а «одно ли он говорит с
 * остальными». Чистые функции: тестируются без сети.
 */

/** Идентификаторы туров, вытащенные из одного канала. */
export interface ChannelTours {
  channel: string;
  ids: Set<string>;
}

/**
 * ID туров из ответа MCP `get_tours`.
 *
 * Формат ответа — текст для модели, а не JSON: «ID27: "Сплав по реке Быстрая"
 * — ... | Оп: ... | Мест: 12». Разбор по метке ID, потому что она и есть
 * контракт: по ней агент ссылается на тур, и её же видит человек в чате.
 */
export function mcpTourIds(body: string): Set<string> {
  const out = new Set<string>();
  const re = /\bID(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

/** ID туров из ссылок вида /catalog/tours/6 или /marketplace/tours/6. */
export function urlTourIds(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\/(?:catalog|marketplace)\/tours\/(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

/** Сколько всего адресов в карте сайта. */
export function sitemapUrlCount(xml: string): number {
  return (xml.match(/<loc>/g) ?? []).length;
}

export interface Divergence {
  /** Канал, где тур есть. */
  present: string;
  /** Канал, где того же тура нет. */
  missing: string;
  ids: string[];
}

/**
 * Расхождения между каналами: что есть в одном и нет в другом.
 *
 * Сравниваются все пары в обе стороны — важно и «MCP видит, сайт нет», и
 * обратное. Первое значит, что человек не найдёт тур поиском; второе — что
 * агент не сможет на него сослаться.
 *
 * Пустой канал в сравнение НЕ идёт: полностью пустой список — это отдельная
 * поломка, и её ловит проверка порога, а не сверка. Иначе один упавший канал
 * порождал бы расхождения со всеми остальными и топил настоящую причину.
 */
export function findDivergences(channels: ChannelTours[]): Divergence[] {
  const live = channels.filter((c) => c.ids.size > 0);
  const out: Divergence[] = [];
  for (const a of live) {
    for (const b of live) {
      if (a.channel === b.channel) continue;
      const missing = [...a.ids].filter((id) => !b.ids.has(id)).sort();
      if (missing.length > 0) out.push({ present: a.channel, missing: b.channel, ids: missing });
    }
  }
  return out;
}

/** Человекочитаемый отчёт для лога и для issue. */
export function formatDivergences(d: Divergence[]): string {
  return d
    .map((x) => `в ${x.present} есть, в ${x.missing} нет: ${x.ids.join(', ')}`)
    .join('; ');
}

/**
 * Домен отвечает содержимым вместо перенаправления на канонический.
 *
 * Два живых домена с одинаковым содержимым — это не запасной вход, а два
 * канона: агенты цитируют то один, то другой, и вес ссылок делится пополам.
 * Проверяется по коду ответа: перенаправление — 301/308, всё прочее при
 * непустом теле означает второй канон.
 */
export function isSecondCanon(status: number, bodyBytes: number): boolean {
  if (status === 301 || status === 308) return false;
  return status === 200 && bodyBytes > 0;
}
