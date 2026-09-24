/**
 * lib/services/safety/emsd-fetch.ts — скачать страницу www.emsd.ru и раскодировать
 * её правильно. ОДИН путь на всю платформу: его зовут и приём сейсмики
 * (`safety-ingest`), и проба сводки вулканов (`emsd-vmon-probe`).
 *
 * ── Почему отдельный модуль ───────────────────────────────────────────────
 *
 * Сайт КФ ФИЦ ЕГС РАН отдаёт страницы в windows-1251. `res.text()` читает
 * байты как UTF-8 и выдаёт кракозябры, а парсер, не найдя в них ни одной
 * строки таблицы, честно ответит «разобрано ноль». Снаружи это неотличимо от
 * «землетрясений не было» — то есть отказ под видом тишины (§4.0).
 *
 * Второй экземпляр этого правила в другом файле разошёлся бы с первым на
 * первом же изменении кодировки у источника (§12).
 *
 * ── Чего модуль не знает ──────────────────────────────────────────────────
 *
 * `TextDecoder('windows-1251')` требует полного ICU, а рантайм прода —
 * `node:22-alpine`. Есть ли там полное ICU, подтвердить из контейнера
 * разработки нечем. Поэтому отказ декодера ловится и НАЗЫВАЕТСЯ, а не
 * подменяется чтением как UTF-8. Ответ даст первый прогон на проде.
 */

/** Результат похода. Ровно один из `html` и `error` не null. */
export interface EmsdFetchResult {
  html: string | null;
  /** HTTP-статус; null — ответа не было вовсе (сеть, DNS, таймаут). */
  status: number | null;
  /** Какой кодировкой раскодировано. Первый вопрос при кракозябрах. */
  decodedBy: string | null;
  bytes: number | null;
  /** Почему не получилось — словами. null, когда html есть. */
  error: string | null;
}

/**
 * Скачать и раскодировать. Кодировка — из заголовка, если он её назвал,
 * иначе из meta самой страницы, иначе windows-1251 (так сайт отдаёт сегодня).
 */
export async function fetchEmsdPage(url: string, timeoutMs = 20_000): Promise<EmsdFetchResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { html: null, status: res.status, decodedBy: null, bytes: null, error: `HTTP ${res.status}` };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const header = res.headers.get('content-type') ?? '';
    const headerCharset = header.match(/charset=([\w-]+)/i)?.[1];
    // Для поиска meta хватает латиницы: атрибут charset=... записан
    // ASCII-символами в любой кодировке.
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 4096));
    const metaCharset = head.match(/charset=["']?([\w-]+)/i)?.[1];
    const charset = (headerCharset || metaCharset || 'windows-1251').toLowerCase();
    try {
      const html = new TextDecoder(charset).decode(buf);
      if (html.trim().length === 0) {
        // 200 с пустым телом — отказ отдать содержимое, а не «на странице
        // ничего нет».
        return { html: null, status: res.status, decodedBy: charset, bytes: buf.length, error: 'HTTP 200 с пустым телом' };
      }
      return { html, status: res.status, decodedBy: charset, bytes: buf.length, error: null };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`[emsd-fetch] декодер «${charset}» недоступен в рантайме:`, why);
      return {
        html: null,
        status: res.status,
        decodedBy: null,
        bytes: buf.length,
        error: `страница скачана (${buf.length} байт), но декодер «${charset}» в рантайме недоступен: ${why}`,
      };
    }
  } catch (e) {
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[emsd-fetch] запрос не дошёл (${url}):`, why);
    return { html: null, status: null, decodedBy: null, bytes: null, error: why.slice(0, 300) };
  }
}
