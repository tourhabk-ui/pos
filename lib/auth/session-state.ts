/**
 * «Вошёл ли смотрящий» — для клиента, одним запросом на экран и без 401.
 *
 * Аудит vedarai.ru 01.10: у гостя главная и каталог отдавали в консоль
 * четыре красных ответа подряд — /api/auth/me (общий AuthContext на каждой
 * странице), /api/trips/active, /api/referral/my-code и
 * /api/tourist/wishlist. Гость — не ошибка, а нормальный ответ; спрашивать
 * его данные, не узнав, вошёл ли он, — значит заказывать 401. Шапка эту
 * дорогу уже прошла (/api/auth/state, #1780): здесь её общая форма.
 *
 * Три исхода, не два: true, false и null — «не смогли спросить» (сеть,
 * 500). Звать данные пользователя — только при true: при null и false
 * их всё равно не будет, а запрос стал бы тем же 401.
 *
 * Ответ («вошёл» или «гость») живёт минуту. Вход и выход внутри приложения
 * сбрасывают его (resetSessionState); вход, прошедший мимо AuthContext,
 * догонит не позже минуты или при следующей загрузке страницы. «Не смогли
 * спросить» не запоминается: это не ответ, а его отсутствие (§4.0), —
 * одновременные вопросы экрана делят один запрос, следующий уйдёт заново.
 */
const TTL_MS = 60_000;

let cached: { at: number; value: Promise<boolean | null> } | null = null;

export function sessionState(): Promise<boolean | null> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  const value = fetch('/api/auth/state', { credentials: 'include', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { data?: { authenticated?: unknown } } | null) =>
      typeof d?.data?.authenticated === 'boolean' ? d.data.authenticated : null)
    .catch(() => null);
  const entry = { at: now, value };
  cached = entry;
  void value.then((v) => { if (v === null && cached === entry) cached = null; });
  return value;
}

/** Вход и выход меняют ответ — следующий вопрос должен уйти заново. */
export function resetSessionState(): void {
  cached = null;
}
