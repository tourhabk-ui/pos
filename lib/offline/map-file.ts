/**
 * Закачка карты одним файлом — та часть, где ошибка стоит девяносто мегабайт
 * чужого трафика.
 *
 * Своя карта Камчатки весит 92 МБ (замер 09.08). Это меняет постановку: вместо
 * тысячи запросов за тайлами, каждый из которых может не дойти, — одна
 * закачка. Но одна закачка ломается иначе, чем тысяча: тысяча тайлов теряет
 * несколько штук, а один файл теряется целиком.
 *
 * Отсюда правила, которые здесь и живут:
 *
 *   1. Качаем кусками и помним, какие уже дома. Телефон убивают на середине
 *      постоянно: свернул, замёрз, кончилась батарея. Начинать заново — значит
 *      выбросить трафик человека, который он оплатил.
 *   2. Проверяем место ДО начала. Узнать, что не хватило, на восьмидесятом
 *      проценте — это те же выброшенные мегабайты.
 *   3. Если файл на сервере сменился, докачивать НЕЛЬЗЯ. Куски от старой
 *      версии и новой, сшитые вместе, дадут файл, который не откроется, — и
 *      выяснится это в поле. Сменился — начинаем заново и говорим об этом.
 *
 * Здесь только решения, без ввода-вывода: хранилище и сеть подставляет
 * вызывающий. Так это проверяется тестами, а не полевым выходом.
 */

/** Кусок в четыре мегабайта: 92 МБ это 23 куска — терпимо и для журнала, и для повтора. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * Запас свободного места сверх размера файла. Файл сначала лежит кусками, а
 * при сборке недолго существует в двух видах; без запаса сборка упирается в
 * квоту на последнем шаге.
 */
export const SPACE_HEADROOM = 2.2;

export interface ChunkRange {
  index: number;
  /** Включительно. */
  start: number;
  /** Включительно — как того требует заголовок Range. */
  end: number;
}

/** Разбить файл на куски. Последний короче остальных — это нормально. */
export function planChunks(totalBytes: number, chunkBytes = CHUNK_BYTES): ChunkRange[] {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return [];
  const size = Math.max(1, Math.floor(chunkBytes));
  const out: ChunkRange[] = [];
  for (let start = 0, index = 0; start < totalBytes; start += size, index++) {
    out.push({ index, start, end: Math.min(start + size, totalBytes) - 1 });
  }
  return out;
}

/** Чего ещё нет дома. Порядок сохраняется: качаем с начала файла. */
export function missingChunks(plan: ChunkRange[], have: Iterable<number>): ChunkRange[] {
  const done = new Set(have);
  return plan.filter(c => !done.has(c.index));
}

/** Заголовок Range для куска. */
export function rangeHeader(chunk: ChunkRange): string {
  return `bytes=${chunk.start}-${chunk.end}`;
}

/**
 * Журнал закачки. Живёт рядом с кусками и отвечает на единственный вопрос,
 * который важен после перезапуска: можно ли продолжать — и откуда.
 */
export interface DownloadJournal {
  url: string;
  totalBytes: number;
  chunkBytes: number;
  /** Метка версии файла с сервера (ETag или Last-Modified). */
  version: string | null;
  haveIndices: number[];
  updatedAt: number;
}

/** Что сервер сказал о файле. */
export interface RemoteFileInfo {
  url: string;
  totalBytes: number;
  version: string | null;
  /** Умеет ли отдавать куски. Без этого возобновление невозможно. */
  acceptsRanges: boolean;
}

export type ResumeDecision =
  | { action: 'resume'; missing: ChunkRange[]; doneBytes: number }
  | { action: 'restart'; reason: string }
  | { action: 'complete' };

/**
 * Продолжать, начать заново или уже всё.
 *
 * Главная развилка — «файл на сервере сменился». Докачать к старым кускам
 * новые значит собрать файл, которого никогда не существовало: он не
 * откроется, и человек узнает об этом там, где скачать заново нечем. Поэтому
 * любое расхождение версии или размера — начало с нуля, названное вслух.
 */
export function decideResume(
  journal: DownloadJournal | null,
  remote: RemoteFileInfo,
): ResumeDecision {
  const plan = planChunks(remote.totalBytes, journal?.chunkBytes ?? CHUNK_BYTES);
  if (!journal) return { action: 'restart', reason: 'Качаем впервые' };
  if (journal.url !== remote.url) return { action: 'restart', reason: 'Адрес карты изменился' };
  if (journal.totalBytes !== remote.totalBytes) {
    return { action: 'restart', reason: 'Карта на сервере обновилась — скачиваем заново' };
  }
  if (journal.version && remote.version && journal.version !== remote.version) {
    return { action: 'restart', reason: 'Карта на сервере обновилась — скачиваем заново' };
  }
  // Индексы вне плана означают, что журнал не про этот файл.
  if (journal.haveIndices.some(i => i < 0 || i >= plan.length)) {
    return { action: 'restart', reason: 'Незавершённая закачка испорчена — начинаем заново' };
  }

  const missing = missingChunks(plan, journal.haveIndices);
  if (missing.length === 0) return { action: 'complete' };
  if (!remote.acceptsRanges) {
    return { action: 'restart', reason: 'Сервер не отдаёт файл частями — качаем целиком' };
  }
  const doneBytes = plan
    .filter(c => journal.haveIndices.includes(c.index))
    .reduce((sum, c) => sum + (c.end - c.start + 1), 0);
  return { action: 'resume', missing, doneBytes };
}

export interface SpaceVerdict {
  ok: boolean;
  needBytes: number;
  freeBytes: number | null;
  message: string;
}

/**
 * Хватит ли места. Спрашиваем ДО первого байта: узнать про нехватку на
 * восьмидесяти процентах — это те же выброшенные мегабайты, только с обидой.
 *
 * Браузер может не сказать ничего — тогда не выдумываем и не запрещаем,
 * а честно говорим, что проверить не смогли.
 */
export function checkSpace(
  totalBytes: number,
  estimate: { quota?: number; usage?: number } | null,
  headroom = SPACE_HEADROOM,
): SpaceVerdict {
  const need = Math.ceil(totalBytes * headroom);
  const mb = (b: number) => Math.round(b / 1024 / 1024);
  if (!estimate || typeof estimate.quota !== 'number') {
    return { ok: true, needBytes: need, freeBytes: null, message: 'Свободное место проверить не удалось' };
  }
  const free = Math.max(0, estimate.quota - (estimate.usage ?? 0));
  if (free >= need) {
    return { ok: true, needBytes: need, freeBytes: free, message: `Места хватает: свободно ${mb(free)} МБ` };
  }
  return {
    ok: false,
    needBytes: need,
    freeBytes: free,
    message: `Не хватает места: нужно ${mb(need)} МБ, свободно ${mb(free)} МБ`,
  };
}

/** Человеческая строка прогресса: сколько, как быстро и сколько ещё ждать. */
export function progressLabel(doneBytes: number, totalBytes: number, bytesPerSec?: number | null): string {
  const mb = (b: number) => (b / 1024 / 1024).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1);
  const parts = [`${mb(doneBytes)} из ${mb(totalBytes)} МБ`];
  if (bytesPerSec && bytesPerSec > 0) {
    parts.push(`${(bytesPerSec / 1024 / 1024).toFixed(1)} МБ/с`);
    const leftSec = Math.max(0, Math.round((totalBytes - doneBytes) / bytesPerSec));
    parts.push(leftSec >= 60 ? `осталось ${Math.round(leftSec / 60)} мин` : `осталось ${leftSec} с`);
  }
  return parts.join(' · ');
}

/**
 * Собранный файл — тот ли это файл.
 *
 * Совпадение длины не доказывает целостности, но ловит главное: обрыв,
 * недокачанный кусок, ответ-заглушку вместо данных. Полноценная проверка —
 * дело подписи, и её место здесь же, когда файл начнут раздавать.
 */
export function assembledLooksRight(assembledBytes: number, expectedBytes: number): boolean {
  return assembledBytes === expectedBytes && expectedBytes > 0;
}

/** Настроен ли адрес карты. Пусто — значит фаза 2 ещё не подключена. */
export function mapFileUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_MAP_PMTILES_URL;
  return url && url.trim().length > 0 ? url.trim() : null;
}
