/**
 * lib/client-errors/chunk-load.ts — «страница не догрузилась».
 *
 * Дайджест ловушки 06.11: внешний посетитель, /plans/kamchatka-za-5-dney-vulkany,
 * род boundary, «Loading chunk 7177 failed. (timeout: …/chunks/app/layout-….js)».
 * Браузер две минуты ждал кусок кода сайта и сдался. Это связь (timeout) или
 * выкладка (старая страница просит кусок, которого на сервере уже нет), а не
 * дефект страницы. Экран же говорил «Произошла непредвиденная ошибка» и давал
 * «Попробовать снова»: reset() перерисовывает ту же часть дерева, а кусок,
 * который не пришёл, этим не возвращается.
 *
 * Правило:
 *   - граница узнаёт такую ошибку по роду (ChunkLoadError) или по сообщению
 *     загрузчика: куски JS и CSS у webpack, динамический import в трёх движках;
 *   - один раз перезагружает страницу сама: новая страница — новые куски;
 *   - повтор на том же адресе за минуту страницу не перезагружает: цикл
 *     перезагрузок хуже честного экрана. Без sessionStorage цикл не удержать —
 *     тоже не перезагружает. Без сети перезагружать незачем;
 *   - экран говорит правду («страница не догрузилась — похоже, слабая связь»),
 *     а кнопка обновляет страницу целиком, а не перерисовывает кусок.
 *
 * Доклад в ловушку не меняется: такая ошибка уходит, как и прежде, родом
 * boundary — счёт «не догрузилось» остаётся виден в переписи.
 */

/** Сообщения загрузчиков кода. Номер куска у webpack — число или имя. */
const CHUNK_MESSAGES: readonly RegExp[] = [
  /Loading chunk \S+ failed/i, // webpack: JS (timeout, error, missing)
  /Loading CSS chunk \S+ failed/i, // webpack: CSS
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
];

/** Ошибка загрузки куска кода — связь или выкладка, а не дефект страницы. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  return typeof message === 'string' && CHUNK_MESSAGES.some((re) => re.test(message));
}

/** Запись о сделанной перезагрузке: адрес и время, без query — там бывают ключи. */
export const CHUNK_RELOAD_KEY = 'vedar_chunk_reload';
/** Повтор на том же адресе раньше этого срока — уже не перезагрузка, а экран. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;
/**
 * Перезагрузка могла не случиться: вебвью мессенджера, запрет браузера.
 * Через этот срок экран показывает кнопку, а не вечное «Обновляем страницу…».
 */
export const CHUNK_RELOAD_STALL_MS = 8_000;

/**
 * Исход:
 *   reload        — перезагружаем страницу (первая попытка на этом адресе);
 *   already-tried — перезагрузка уже была меньше минуты назад: показываем экран;
 *   offline       — сети нет, перезагрузка не поможет;
 *   no-storage    — запись о попытке сделать негде: без неё не удержать цикл.
 */
export type ChunkReloadDecision = 'reload' | 'already-tried' | 'offline' | 'no-storage';

export type ReloadStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ChunkReloadInput {
  path: string;
  now: number;
  online: boolean;
  storage: ReloadStorage | null;
}

function previousAttempt(raw: string | null): { path: string; at: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { path?: unknown; at?: unknown };
    return typeof v.path === 'string' && typeof v.at === 'number' ? { path: v.path, at: v.at } : null;
  } catch {
    // Чужая или испорченная запись — попытки на этом адресе не было.
    return null;
  }
}

export function decideChunkReload(input: ChunkReloadInput): ChunkReloadDecision {
  if (!input.online) return 'offline';
  if (!input.storage) return 'no-storage';
  try {
    const prev = previousAttempt(input.storage.getItem(CHUNK_RELOAD_KEY));
    if (prev && prev.path === input.path && input.now - prev.at >= 0 && input.now - prev.at < CHUNK_RELOAD_WINDOW_MS) {
      return 'already-tried';
    }
    input.storage.setItem(CHUNK_RELOAD_KEY, JSON.stringify({ path: input.path, at: input.now }));
    return 'reload';
  } catch {
    // Хранилище есть, но не пишет (квота, запрет сайта): запись о попытке не
    // ляжет, и автоперезагрузка могла бы пойти по кругу — показываем экран.
    return 'no-storage';
  }
}

/** sessionStorage, если браузер его даёт: при запрете данных сайта доступ бросает. */
export function sessionStorageOrNull(): ReloadStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // Доступ запрещён настройками браузера — исход «no-storage» назовёт это.
    return null;
  }
}

/**
 * Перезагрузка страницы — через объект, чтобы сторож мог её подменить:
 * jsdom навигацию не умеет. Кнопки экранов зовут её же.
 */
export const browserPage = {
  reload(): void {
    window.location.reload();
  },
};

/** Слова экрана — одни на все границы, включая корневую со своими стилями. */
export const CHUNK_TEXT = {
  title: 'Страница не догрузилась',
  body: 'Часть страницы не пришла по сети — похоже, слабая связь. Обновите страницу.',
  offline: 'Похоже, нет связи. Когда она появится, обновите страницу.',
  reloading: 'Обновляем страницу…',
  button: 'Обновить страницу',
} as const;

/** Текст под заголовком по исходу решения. */
export function chunkNoticeBody(decision: ChunkReloadDecision | null): string {
  if (decision === 'reload') return CHUNK_TEXT.reloading;
  if (decision === 'offline') return CHUNK_TEXT.offline;
  return CHUNK_TEXT.body;
}
