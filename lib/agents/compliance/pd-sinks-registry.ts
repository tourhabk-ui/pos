/**
 * Реестры сторожа ПД на стоках (`pd-sinks.ts`) и обход репозитория.
 *
 * Два реестра, оба самоустаревающие (как `KNOWN_UNPRODUCED`): запись, которой
 * больше не о чем говорить, краснеет и требует удаления.
 *
 * 1. `DEVICE_STORAGE` — каждый файл, который пишет на устройство человека
 *    (localStorage, sessionStorage, IndexedDB, Cache API, cookie), говорит,
 *    что там лежит и чьё оно. Новый писатель без записи — красный: так
 *    черновик анкеты планера (#3425) встал бы на ревью сам, а не после него.
 *
 * 2. `ALLOWED_FINDINGS` — находки сторожа, которые разобраны и оставлены с
 *    причиной. Ключ — файл, сток и выражение, без номера строки: правка рядом
 *    запись не ломает.
 *
 * Как расширять. Новая запись в хранилище — строка в `DEVICE_STORAGE` с
 * честным родом: `none`, если о человеке там ничего; `account`, если это
 * данные аккаунта, — тогда «Выйти» обязан их стирать, и это проверяет рендер
 * (`tests/unit/pd-sinks-guard.test.tsx`). Находка в логе, Telegram или адресе
 * чинится маской (`PD_SANITIZERS`) или проверкой наличия; в
 * `ALLOWED_FINDINGS` она идёт, только когда номера и имени на деле в стоке нет
 * (счёт, список для маски) или сток не выходит за машину человека, — и
 * причина говорит, какой из случаев.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { scanSinks, deviceWrites, exportedSqlConsts, mergeSqlConsts, type SinkFinding, type DeviceWrite } from './pd-sinks';

/**
 * Где ищутся стоки. `scripts` — с ними: их печать уходит в лог Actions (#3203).
 * `public` — браузерный код без сборки: service worker, SOS-экраны, виджет.
 */
export const SINK_ROOTS = ['app', 'lib', 'components', 'hooks', 'contexts', 'scripts', 'public'] as const;
/** Где ищутся записи на устройство человека: код, который идёт в браузер. */
export const DEVICE_ROOTS = ['app', 'lib', 'components', 'hooks', 'contexts', 'public'] as const;

/**
 * Чужой код в `public`, вендоренный без изменений: его не пишем и не правим,
 * а его запись в хранилище — не наша запись. Путь, которого нет, краснеет
 * (сторож проверяет), чтобы список не пережил свои файлы.
 */
export const THIRD_PARTY: readonly string[] = [
  'public/vendor/', // maplibre-gl 6.11.2
  'public/leaflet/', // leaflet.min.js
  'public/safety/qrcode.js', // qrcode-generator@2.0.4
  'public/safety/jsqr.js', // jsqr@1.4.0
];

/**
 * Чьё и что лежит на устройстве:
 *  - `none` — о человеке ничего (тема, вид списка, случайный номер, кэш общих данных);
 *  - `own-session` — его данные, живут до закрытия вкладки;
 *  - `account` — данные аккаунта: «Выйти» стирает ключи `keys` (рендер);
 *  - `own-device` — его данные нарочно остаются на устройстве, `why` обязателен;
 *  - `gap` — должны стираться при выходе и не стираются: известный пробел,
 *    запись краснеет, когда «Выйти» начнёт стирать `keys`.
 */
export type DevicePersonal = 'none' | 'own-session' | 'account' | 'own-device' | 'gap';

export interface DeviceStorageEntry {
  file: string;
  personal: DevicePersonal;
  holds: string;
  why?: string;
  /** Ключи хранилища — для проверки «Выйти» (account и gap). */
  keys?: readonly string[];
  /**
   * Правка пробела уже идёт отдельным PR: проверка «Выйти» принимает оба
   * состояния, чтобы вливание той правки не красило main. После её вливания
   * запись переходит в `account`.
   */
  fixInFlight?: string;
}

export const DEVICE_STORAGE: readonly DeviceStorageEntry[] = [
  // --- данные аккаунта: стираются при «Выйти»
  { file: 'contexts/AuthContext.tsx', personal: 'account', keys: ['user', 'user_roles'], holds: 'вошедший пользователь: имя, почта, роли' },
  { file: 'app/auth/login/_AuthPageClient.tsx', personal: 'account', keys: ['user'], holds: 'пользователь после входа' },
  { file: 'app/operators/join/_JoinClient.tsx', personal: 'account', keys: ['user'], holds: 'пользователь после регистрации оператора' },
  { file: 'app/team/join/[token]/_JoinClient.tsx', personal: 'account', keys: ['user'], holds: 'пользователь после входа в команду' },

  {
    file: 'app/planner/_PlannerClient.tsx', personal: 'account', keys: ['vedar_planner_form_v1'],
    holds: 'анкета планера своего аккаунта: состав группы, возраст детей, подвижность, рейсы — без имени и телефона (PR 3452)',
  },

  // --- известные пробелы: при выходе не стираются
  {
    file: 'app/ai-assistant/_AIAssistantClient.tsx', personal: 'gap', keys: ['th_ai_chat_history'],
    holds: 'переписка с ассистентом: человек мог написать в ней имя и телефон',
  },
  {
    file: 'contexts/OrdersContext.tsx', personal: 'gap', keys: ['orders'],
    holds: 'заказы с именем, почтой и телефоном покупателя; провайдер стоит в приложении, но его никто не зовёт — пишется пустой список',
  },

  // --- его данные до закрытия вкладки
  { file: 'app/watch/WatchClient.tsx', personal: 'own-session', holds: 'телефон руководителя группы — им открывается контроль выхода' },
  { file: 'app/request-resume/_ResumeClient.tsx', personal: 'own-session', holds: 'ключ заявки и её комментарий до отправки' },
  { file: 'lib/kuzmich/offline-queue.ts', personal: 'own-session', holds: 'вопросы Кузьмичу, заданные без сети, до отправки' },

  // --- его данные нарочно остаются на устройстве
  {
    file: 'lib/offline/pending-queue.ts', personal: 'own-device',
    holds: 'SOS, не ушедший без сети: имя, телефон, координаты — свои и чужие, принятые эстафетой',
    why: 'SOS обязан дойти, когда появится сеть',
  },
  { file: 'lib/offline/db.ts', personal: 'own-device', holds: 'офлайн-карты, свои треки и наблюдения на маршруте', why: 'работа на маршруте без сети' },
  { file: 'lib/offline/trip-save.ts', personal: 'own-device', holds: 'страница своего плана поездки по ссылке', why: 'план нужен без сети' },
  { file: 'app/planning/_PlanningClient.tsx', personal: 'own-device', holds: 'трек пройденного пути, настройки экрана, чек-листы', why: 'трек нужен на маршруте без сети' },
  { file: 'components/tracking/LastPositionTracker.tsx', personal: 'own-device', holds: 'последняя координата устройства в сети', why: 'SOS без сети называет последнюю точку' },
  { file: 'hooks/useOfflineGPS.ts', personal: 'own-device', holds: 'последняя координата устройства', why: 'SOS и карта без сети' },
  { file: 'contexts/GeoContext.tsx', personal: 'own-device', holds: 'место устройства и режим геолокации', why: 'погода и обстановка рядом без повторного вопроса' },
  { file: 'lib/offline/last-fix.ts', personal: 'own-device', holds: 'точная последняя координата устройства на 30 суток', why: 'экран поля и SOS без сети показывают, где человек был последний раз' },
  { file: 'lib/on-route/wp-progress.ts', personal: 'own-device', holds: 'номер пройденной точки маршрута', why: 'прогресс на маршруте без сети' },
  { file: 'lib/safety/register-submit.ts', personal: 'own-device', holds: 'случайный ключ повтора формы контроля возвращения', why: 'повтор той же формы узнаёт свою запись, а не создаёт вторую (§10)' },
  {
    file: 'public/sw.js', personal: 'own-device',
    holds: 'копии страниц, снимков, данных карточек мест и плана поездки по ссылке; очередь SOS только читает и удаляет (пишет её lib/offline/pending-queue.ts)',
    why: 'карта, карточки и SOS работают без сети',
  },
  { file: 'components/planner/SeatRequestForm.tsx', personal: 'own-device', holds: 'ссылки на свои запросы мест с ключом', why: 'запрос делается без входа; ссылка — единственный путь к нему' },

  // --- о человеке ничего
  { file: 'app/_home/_HomeV8Client.tsx', personal: 'none', holds: 'тема оформления' },
  { file: 'lib/planner/form-draft.ts', personal: 'none', holds: 'метка «из аккаунта вышли» (время и номер выхода) — другие вкладки по ней перестают писать черновик' },
  { file: 'app/field-check/_FieldCheckClient.tsx', personal: 'none', holds: 'отметки проверки на местности и метка выезда' },
  { file: 'app/hub/admin/artem/_ArtemWorkspaceClient.tsx', personal: 'none', holds: 'чек-лист рабочего места' },
  { file: 'app/hub/admin/leads/_LeadsClient.tsx', personal: 'none', holds: 'вид списка заявок' },
  { file: 'app/hub/admin/traffic/_SelfVisitToggle.tsx', personal: 'none', holds: 'метка «свой визит» администратора' },
  { file: 'app/hub/operator/leads/_LeadsClient.tsx', personal: 'none', holds: 'вид списка заявок' },
  { file: 'app/kuzmich/_KuzmichClient.tsx', personal: 'none', holds: 'случайный номер разговора' },
  { file: 'app/places/[id]/_PlaceDetailClient.tsx', personal: 'none', holds: 'кэш карточки места' },
  { file: 'app/routes/[id]/_RouteDetailClient.tsx', personal: 'none', holds: 'кэш маршрута и текущий маршрут' },
  { file: 'app/sos/relay/page.tsx', personal: 'none', holds: 'случайный номер устройства' },
  { file: 'lib/client-errors/report.ts', personal: 'none', holds: 'очередь отчётов об ошибках: сообщение и адрес без строки запроса' },
  { file: 'lib/legal/consent.ts', personal: 'none', holds: 'выбор в окне согласия на cookie' },
  { file: 'lib/mesh/volcano-mesh.ts', personal: 'none', holds: 'случайный номер устройства' },
  { file: 'lib/offline/route-facts.ts', personal: 'none', holds: 'факты сохранённого маршрута: опасности, снаряжение, регистрация МЧС, медпомощь у точек, предупреждения' },
  { file: 'lib/offline/route-map-save.ts', personal: 'none', holds: 'отметка сохранённой карты маршрута' },
  { file: 'lib/preparation/storage.ts', personal: 'none', holds: 'план подготовки к маршруту: длительность, опыт, снаряжение' },
  { file: 'lib/referral/agent-link.ts', personal: 'none', holds: 'метка агента, приведшего посетителя' },
  { file: 'lib/referral/link.ts', personal: 'none', holds: 'реферальная метка' },
  { file: 'lib/wishlist/client.ts', personal: 'none', holds: 'избранные туры и места' },
  { file: 'components/PWA/InstallPrompt.tsx', personal: 'none', holds: 'отказ от установки приложения' },
  { file: 'components/PWA/InstallTracker.tsx', personal: 'none', holds: 'случайный номер установки' },
  { file: 'components/admin/shared/SensitiveMaskToggle.tsx', personal: 'none', holds: 'включена ли маска контактов в админке' },
  { file: 'components/field/PointCard.tsx', personal: 'none', holds: 'формат координат' },
  { file: 'components/hub/PartnerOfferBanner.tsx', personal: 'none', holds: 'отметка «позже» у просьбы принять оферту: до закрытия вкладки, с редакцией оферты в имени ключа' },
  { file: 'components/kuzmich/KuzmichWidget.tsx', personal: 'none', holds: 'случайный номер разговора' },
  { file: 'components/map/MapThreatChip.tsx', personal: 'none', holds: 'кэш тревог на карте' },
  { file: 'components/places/PlaceSwipeDeck.tsx', personal: 'none', holds: 'подсказка показана' },
  { file: 'components/shared/AssistantButton.tsx', personal: 'none', holds: 'случайный номер разговора' },
  { file: 'components/shared/PageViewTracker.tsx', personal: 'none', holds: 'случайный номер визита' },
  { file: 'hooks/useGeofence.ts', personal: 'none', holds: 'кэш зон тревоги' },
  { file: 'hooks/useInterestTracker.ts', personal: 'none', holds: 'интересы по просмотренным страницам, без имени' },
  { file: 'hooks/usePlaceProximity.ts', personal: 'none', holds: 'места, о которых уже напомнили' },
  { file: 'hooks/useSourceTracker.ts', personal: 'none', holds: 'метки источника визита' },
  { file: 'lib/client-errors/chunk-load.ts', personal: 'none', holds: 'адрес страницы и время перезагрузки после сбоя загрузки' },
  { file: 'lib/hub/plaque-dismiss.ts', personal: 'none', holds: 'плашка кабинета скрыта' },
  { file: 'lib/routes/catalog-return.ts', personal: 'none', holds: 'адрес каталога и прокрутка для возврата' },
  { file: 'lib/safety/new-alerts.ts', personal: 'none', holds: 'ключи уже показанных тревог' },
  { file: 'contexts/AdventureModeContext.tsx', personal: 'none', holds: 'режим экрана' },
  { file: 'contexts/CartContext.tsx', personal: 'none', holds: 'туры в корзине' },
  { file: 'contexts/ThemeContext.tsx', personal: 'none', holds: 'тема оформления' },
];

/**
 * Разобранная находка: ключ — файл, сток, выражение.
 *
 * `leak` — ПД на деле уходят туда, куда не должны, и это ещё не исправлено:
 * запись называет утечку вслух, чтобы она не пряталась среди разрешённых, и
 * краснеет, когда правка её уберёт. Новая утечка сюда не вносится — её чинят.
 */
export interface AllowedFinding { file: string; sink: string; expr: string; reason: string; leak?: true }

/** Человеку в его же чат — его же имя или номер: получатель и есть хозяин данных. */
const OWN_CHAT = 'своё имя или номер — самому человеку в его же чат Telegram';

export const ALLOWED_FINDINGS: readonly AllowedFinding[] = [
  {
    file: 'lib/requests/request-chat-service.ts', sink: 'sendPdAlert stub', expr: 'r.guestName',
    reason: 'имя идёт в заглушку списком для маски (ownerIncomingStub прячет его в тексте), а не в текст',
  },
  {
    file: 'scripts/review-pii-scrub.mjs', sink: 'process.stdout.write', expr: 't.phones',
    reason: 'число найденных телефонов, не номера',
  },
  {
    file: 'scripts/review-pii-scrub.mjs', sink: 'process.stdout.write', expr: 't.emails',
    reason: 'число найденных почт, не адреса',
  },
  { file: 'lib/requests/request-chat-service.ts', sink: 'sendPdAlert stub', expr: 'tr ← r.guestName', reason: 'имя идёт в перевод списком для маски, а не в текст' },
  { file: 'app/api/cron/tour-review-request/route.ts', sink: 'sendTelegramMessage', expr: 'text ← b.tourist_name', reason: OWN_CHAT },
  { file: 'app/api/hub/admin/support/tickets/[id]/route.ts', sink: 'telegramService.sendMessage', expr: 'userName', reason: OWN_CHAT },
  { file: 'lib/leads/proposal-delivery.ts', sink: 'tgSend', expr: 'text ← lead.name', reason: OWN_CHAT },
  { file: 'lib/notifications/booking-notifications.ts', sink: 'telegramService.sendMessage', expr: 'firstName', reason: OWN_CHAT },
  { file: 'lib/notifications/booking-notifications.ts', sink: 'telegramService.sendMessage', expr: 'lines ← firstName', reason: OWN_CHAT },
  {
    file: 'lib/agents/execution/handlers/operator-outreach-executor.ts', sink: 'fetch api.telegram.org', expr: 'tgText ← op.email',
    reason: 'почта компании-оператора с её открытого сайта, не человека',
  },
  {
    file: 'scripts/scrape-operators-visitkamchatka.js', sink: 'console.log', expr: 'phoneMark ← op.phone',
    reason: 'телефон компании с открытого сайта — в терминал того, кто запустил скрипт; ни один workflow скрипт не зовёт',
  },
  ...['text ← booking.passengerName', 'text ← booking.passengerPhone', 'replyMarkup ← booking.passengerPhone'].map((expr) => ({
    file: 'lib/notifications/telegram.ts', sink: 'this.sendMessage', expr, leak: true as const,
    reason: 'sendDriverNotification шлёт водителю в Telegram имя и телефон пассажира — записанный остаток (шапка telegram.ts): вызывающих нет, чинится адресами водителей в MAX',
  })),
  ...['text ← contactName', 'text ← phone', 'text ← email'].map((expr) => ({
    file: 'app/api/auth/register-operator/route.ts', sink: 'fetch api.telegram.org', expr, leak: true as const,
    reason: 'уведомление администратору о регистрации партнёра несёт имя, телефон и почту контактного лица в Telegram, а ПД ходят только в MAX (23.08); не исправлено',
  })),
  {
    file: 'lib/agents/evo/growth-agent.ts', sink: 'INSERT INTO evo_growth_scans', expr: 'censusLine ← l.name',
    reason: '`l` здесь — объектив сканера (lens), а не лид: в строку сводки идут имена объективов',
  },
  ...['g.name', 'g.phone', 'g.email'].map((expr) => ({
    file: 'scripts/scrape-guides-visitkamchatka.js', sink: 'console.log', expr,
    reason: 'сухой прогон печатает контакты гидов с открытого сайта в терминал того, кто его запустил; ни один workflow скрипт не зовёт',
  })),
];

export const findingKey = (f: Pick<SinkFinding, 'file' | 'sink' | 'expr'>): string => `${f.file}|${f.sink}|${f.expr}`;

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__', 'tests']);
const SOURCE = /\.(?:ts|tsx|js|mjs|cjs)$/;

function walk(dir: string, acc: string[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, acc);
    else if (SOURCE.test(name) && !/\.(?:test|spec)\.|\.d\.ts$/.test(name)) acc.push(full);
  }
}

export function readRoots(repoRoot: string, roots: readonly string[]): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  for (const r of roots) {
    const files: string[] = [];
    walk(join(repoRoot, r), files);
    for (const abs of files) {
      const rel = relative(repoRoot, abs).split('\\').join('/');
      if (THIRD_PARTY.some((t) => rel === t || (t.endsWith('/') && rel.startsWith(t)))) continue;
      let src: string;
      try { src = readFileSync(abs, 'utf8'); } catch { continue; }
      out.push({ rel, src });
    }
  }
  return out;
}

export interface SinkCensus {
  /** Находки, не разобранные в `ALLOWED_FINDINGS` и не разрешённые реестром хранилища. */
  violations: SinkFinding[];
  /** Записи `ALLOWED_FINDINGS`, которым больше нечего разрешать. */
  staleAllowed: AllowedFinding[];
  /** Файлы, пишущие на устройство, без записи в реестре. */
  unregistered: Array<{ file: string; writes: DeviceWrite[] }>;
  /** Записи реестра, чей файл больше на устройство не пишет. */
  staleDevice: DeviceStorageEntry[];
  /**
   * Запись ПД в базу (`kind: 'db'`): не нарушение сама по себе — заявка обязана
   * хранить телефон. Сверяется с реестром таблиц (`pd-db-tables.ts`).
   */
  dbFindings: SinkFinding[];
}

/**
 * Перепись по исходникам. Чистая: исходники на входе. Находка в хранилище
 * разрешена, только если реестр называет файл не `none`: что лежит, он уже
 * сказал, и проверку «Выйти» держит рендер.
 */
export function sinkCensus(
  sinkSources: ReadonlyArray<{ rel: string; src: string }>,
  deviceSources: ReadonlyArray<{ rel: string; src: string }>,
  registry: readonly DeviceStorageEntry[] = DEVICE_STORAGE,
  allowed: readonly AllowedFinding[] = ALLOWED_FINDINGS,
): SinkCensus {
  const byFile = new Map(registry.map((e) => [e.file, e]));
  const allowedKeys = new Map(allowed.map((a) => [findingKey(a), a]));
  const used = new Set<string>();
  const violations: SinkFinding[] = [];
  const dbFindings: SinkFinding[] = [];
  // Текст запроса из соседнего модуля: экспортированные константы всех файлов.
  const sqlConsts = mergeSqlConsts(sinkSources.map(({ src }) => exportedSqlConsts(src)));
  for (const { rel, src } of sinkSources) {
    for (const f of scanSinks(rel, src, sqlConsts)) {
      const key = findingKey(f);
      if (allowedKeys.has(key)) { used.add(key); continue; }
      if (f.kind === 'db') { dbFindings.push(f); continue; }
      const entry = byFile.get(f.file);
      if (f.kind === 'storage' && entry && entry.personal !== 'none') continue;
      violations.push(f);
    }
  }
  const unregistered: SinkCensus['unregistered'] = [];
  const writing = new Set<string>();
  for (const { rel, src } of deviceSources) {
    const writes = deviceWrites(src);
    if (writes.length === 0) continue;
    writing.add(rel);
    if (!byFile.has(rel)) unregistered.push({ file: rel, writes });
  }
  return {
    violations,
    staleAllowed: allowed.filter((a) => !used.has(findingKey(a))),
    unregistered,
    staleDevice: registry.filter((e) => !writing.has(e.file)),
    dbFindings,
  };
}

/**
 * Исходники в корне репозитория (ревью #3499): `instrumentation.ts` и
 * `middleware.ts` исполняются на сервере, `start.js` запускает его, и любой
 * из них может писать в базу и в лог. Обход каталогов их не видит, поэтому
 * корень читается отдельно и без спуска вглубь: подкаталоги — `SINK_ROOTS`.
 */
export function readRootFiles(repoRoot: string): Array<{ rel: string; src: string }> {
  let names: string[];
  try { names = readdirSync(repoRoot); } catch { return []; }
  const out: Array<{ rel: string; src: string }> = [];
  for (const name of names.sort()) {
    if (!SOURCE.test(name) || /\.(?:test|spec)\.|\.d\.ts$/.test(name)) continue;
    const abs = join(repoRoot, name);
    try {
      if (!statSync(abs).isFile()) continue;
      out.push({ rel: name, src: readFileSync(abs, 'utf8') });
    } catch { continue; }
  }
  return out;
}

/** Всё, что перепись стоков читает: каталоги `SINK_ROOTS` и файлы корня. */
export function sinkSourcesOfRepo(repoRoot: string): Array<{ rel: string; src: string }> {
  return [...readRootFiles(repoRoot), ...readRoots(repoRoot, SINK_ROOTS)];
}

export function sinkCensusOfRepo(repoRoot: string): SinkCensus {
  return sinkCensus(sinkSourcesOfRepo(repoRoot), readRoots(repoRoot, DEVICE_ROOTS));
}
