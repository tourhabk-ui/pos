/**
 * lib/agents/cron-schedulers.ts
 *
 * Кто запускает каждый эндпоинт под `/api/cron/`.
 *
 * Реестр `cron-registry.ts` описывает джобы GitHub Actions и меряет их живость.
 * Но эндпоинтов под `/api/cron/` больше, чем workflow: перепись достижимости
 * 22.08 нашла 122 роута против 74, дёргаемых из `.github/workflows`. Оставшиеся
 * 44 не запускает НИЧТО, что видно из репозитория, — и это два разных случая,
 * которые до сих пор были неотличимы по имени каталога:
 *
 *   external — шапка роута обещает расписание снаружи («каждый час»,
 *              «cron-job.org каждые 30 минут»). Идёт оно или нет, репозиторий
 *              подтвердить не может: cron-job.org настраивается в чужой панели.
 *              Это НЕ «работает» и НЕ «сломано» — это «не знаю», и оно обязано
 *              называться так вслух (CLAUDE.md §4.0). Для `payouts` цена
 *              незнания — удержанные платежи оператору, которые никто не
 *              отпускает.
 *   manual   — перепись, разбор или починка, которую человек зовёт по адресу.
 *              Живёт под `/api/cron/`, потому что `CRON_SECRET` сужен на этот
 *              префикс (09.08, после утечки секрета на сторонний хост).
 *              Отсутствие расписания — норма, а не поломка.
 *
 * Третье состояние здесь — `undeclared`: новый роут, о котором никто ничего не
 * сказал. Сторож `tests/unit/cron-scheduler-declared.test.ts` требует, чтобы
 * такого не было: либо workflow, либо строка здесь. Молчание — не ответ.
 */

export type SchedulerKind = 'workflow' | 'external' | 'manual' | 'undeclared';

export interface SchedulerDeclaration {
  kind: 'external' | 'manual';
  /** Что обещает шапка роута (external) или что роут делает (manual). */
  note: string;
  /** Меняет ли данные. Ручной пишущий разбор опаснее ручной переписи. */
  writes: boolean;
}

/**
 * Расписание заявлено, планировщик снаружи репозитория.
 * Формулировки — из шапок самих роутов, не придуманы здесь.
 */
export const EXTERNAL_SCHEDULE: Record<string, SchedulerDeclaration> = {
  payouts: {
    kind: 'external', writes: false,
    note: 'шапка: «запускать каждый час» — релиз HELD-платежей через 36 ч после тура',
  },
  'leads-followup': {
    kind: 'external', writes: false,
    note: 'шапка: «cron-job.org каждые 30 минут» — добивка лидов и эскалация к админу',
  },
  digest: {
    kind: 'external', writes: true,
    note: 'шапка: «cron-job.org 1 раз в день в 09:00 KMT»',
  },
  'legislation-sync': {
    kind: 'external', writes: false,
    note: 'шапка: «раз в сутки/неделю» — Firecrawl → legislation_docs',
  },
  'industry-intel': {
    kind: 'external', writes: false,
    note: 'шапка: «1-2 раза в день»',
  },
  'memory-reflect': {
    kind: 'external', writes: false,
    note: 'шапка: «раз в сутки»',
  },
  'memory-contradiction': {
    kind: 'external', writes: false,
    note: 'шапка: «раз в сутки»',
  },
};

/** Ручные переписи, разборы и починки — расписания у них быть и не должно. */
export const MANUAL_ENDPOINTS: Record<string, SchedulerDeclaration> = {
  'ai-models':                 { kind: 'manual', writes: false, note: 'какие модели реально доступны нашим ключам — чтобы override выбирали не по памяти' },
  // 'tochka-check' объявления здесь не несёт: его зовёт tochka-check.yml —
  // объявление тут было бы вторым ответом на тот же вопрос (см. тот же довод
  // у 'ai-channel-check' ниже).
  'channel-photo-check':       { kind: 'manual', writes: false, note: 'почему посты канала уходят без картинок: откаты sendPhoto с ответом Telegram' },
  'channel-readiness':         { kind: 'manual', writes: false, note: 'сколько туров годится к выкладке на чужую витрину и что мешает каждому' },
  'tour-pickup':               { kind: 'manual', writes: true,  note: 'записать, как турист попадает на тур: перевозка — свойство оператора, а не поездки' },
  'tour-photos':               { kind: 'manual', writes: true,  note: 'приписать туру фото, уже лежащие в public/images; чужие хосты запрещены' },
  'funnel-census':             { kind: 'manual', writes: false, note: 'числа воронки целиком: срезы health закрыты requireAdmin, объектив эволюции отдаёт вердикт без цифр' },
  'payment-config':            { kind: 'manual', writes: false, note: 'какими способами турист может заплатить: имена настроенных переменных без значений — «0 оплат» не должно быть неотличимо от «нечем платить»' },
  'beacon-check':              { kind: 'manual', writes: false, note: 'способен ли приёмник маяка записать событие: тот же INSERT в транзакции с гарантированным откатом' },
  'scout-relay-check':         { kind: 'manual', writes: false, note: 'читает ли прод источники разведчика через реле Cloudflare: только чтение, без модели и публикации' },
  'sql-shape-check':           { kind: 'manual', writes: false, note: 'разбираются ли запросы формы INSERT ... SELECT $n ... WHERE NOT EXISTS: PREPARE без выполнения' },
  'booking-attempts':          { kind: 'manual', writes: false, note: 'сколько броней создано, сколько не дошло до денег, сколько сорвалось пятисоткой; попытки-касания — только с починки маяка' },
  'locked-out-partners':       { kind: 'manual', writes: false, note: 'аккаунт есть, партнёрского профиля нет: точный счёт потерь на запертой двери регистрации' },
  'backfill-partner-profile':  { kind: 'manual', writes: true,  note: 'создаёт недостающий партнёрский профиль через ensurePartnerForRole — возврат тех, кого заперла регистрация' },
  'route-core':                { kind: 'manual', writes: false, note: 'Ф5 плана порядка маршрутов: ядро из 20 по цене ошибки (lib/routes/error-cost.ts), не по спросу — правило владельца 21.08' },
  'route-core-sources':        { kind: 'manual', writes: false, note: 'диагностика по конкретным id ядра Ф5: есть ли source_url/pdf_url/park_approval_url — прежде чем звать это «нужны полевые треки»' },
  'route-core-ocr-peek':       { kind: 'manual', writes: false, note: 'заглянуть в OCR-markdown паспорта: есть ли в тексте что-то похожее на координаты/путь, прежде чем строить парсер трека' },
  // 'route-endpoints' объявления здесь не несёт с 02.09: его зовёт
  // route-endpoints-batch.yml (перепись, сухой прогон, партия по 10 — #1493);
  // объявление тут было бы вторым ответом на тот же вопрос, как у tochka-check.
  'commission-dry-run':        { kind: 'manual', writes: false, note: 'что записалось бы в комиссию по броне и почему не записалось бы: разбор по звеньям, без вставки' },
  'evo-log-cleanup':           { kind: 'manual', writes: true,  note: 'пометить неисполнимые записи очереди эволюции: 21 «ожидает» с апреля, которые рука пропускает каждый прогон' },
  'duplicate-routes-audit':    { kind: 'manual', writes: false, note: 'перепись дублей маршрутов' },
  // До 24.08 этот адрес дёргал routes-audit.yml — но не под расписанием
  // (только push в триггер-файл/workflow_dispatch), а сам workflow с 19.08
  // указывал на /api/cron/route-data-audit по ошибке (issue #1378): судья
  // ждал форму GeometryAudit, этот роут отдаёт другую (computeRoutesAudit).
  // Расписание переехало на верный адрес, а этот остался без единого
  // caller'а в репозитории — ручной, как и был по факту.
  'routes-audit':              { kind: 'manual', writes: false, note: 'категории пробелов в карточках маршрутов: нет геометрии/точек/дистанции/сложности' },
  'intel-note':                { kind: 'manual', writes: true,  note: 'разведка от человека → находка категории intel' },
  // Служебная обвязка проверки оплаты: заводит невидимый тур и бронь под
  // реальный рубль, teardown прячет их мягко. Расписания быть не должно.
  'payment-test-setup':        { kind: 'manual', writes: true,  note: 'обвязка проверки оплаты и комиссии: служебный партнёр, невидимый тур, бронь под QR' },
  'partner-junk-census':       { kind: 'manual', writes: false, note: 'партнёры, у которых имя не имя (реестровый номер вместо названия)' },
  // Расписания у уборки нет и быть не должно: удаление необратимо, и запускает
  // его человек по цифрам переписи. Сам роут без `confirm: true` не удаляет.
  'partner-cleanup':           { kind: 'manual', writes: true,  note: 'удаление бесхозных партнёров: ни туров, ни броней, ни входа, ни аттестаций' },
  'legacy-tours-census':       { kind: 'manual', writes: false, note: 'что лежит в мёртвой таблице tours: её ключ держит пятерых партнёров от удаления' },
  // Расписания у сноса нет и быть не должно: удаление необратимо, список строк
  // назван поимённо, запускает человек. Без `confirm: true` роут не удаляет.
  'legacy-tours-cleanup':      { kind: 'manual', writes: true,  note: 'снос шести демо-строк из мёртвой tours по решению владельца 23.08: они держат пятерых бесхозных партнёров' },
  'safety-alert':              { kind: 'manual', writes: true,  note: 'приём предупреждения по зоне: публикация и снятие' },
  'field-check-photo':         { kind: 'manual', writes: false, note: 'снимок полевой проверки по id, только чтение' },
  'field-check-queue':         { kind: 'manual', writes: false, note: 'очередь полевых проверок с расхождениями, только чтение' },
  'track-import-queue':        { kind: 'manual', writes: true, note: 'GET — очередь загруженных треков (чтение); POST — применяет один трек как geometry названного маршрута (30.08)' },
  'route-kind-classify':       { kind: 'manual', writes: true,  note: 'разметка рода записи: путь или «как добраться»' },
  'schema-drift':              { kind: 'manual', writes: false, note: 'объявленные колонки против information_schema живой базы' },
  // 'ai-channel-check' тоже дёргает scout-diagnose-report.yml — объявления
  // здесь быть не должно по той же причине (два ответа на один вопрос).
  //
  // 'scout-diagnose' убран из ручных 29.08: его дёргает
  // .github/workflows/scout-diagnose-report.yml (по кнопке, без расписания —
  // диагностике не место в liveness-панели). Объявление рядом с workflow —
  // это два разных ответа на один вопрос, и сторож cron-scheduler-declared
  // правильно на них ругается.
  // Расписания нет намеренно: источник и вопрос называет человек. Пишет
  // только по явному save=1, и только когда ответ найден с цитатами.
  'scout-study':               { kind: 'manual', writes: true,  note: 'прочитать названный источник и ответить из него с цитатами: прод достаёт то, что закрыто egress-политикой у разработчика' },
  'elevation-backfill':        { kind: 'manual', writes: false, note: 'добор высот по точкам' },
  'explain-availability':      { kind: 'manual', writes: false, note: 'разбор занятости тура' },
  'hidden-tracks-census':      { kind: 'manual', writes: false, note: 'перепись скрытых треков' },
  'idilesom-gap':              { kind: 'manual', writes: false, note: 'чего нет у нас против источника' },
  'idilesom-name-gap':         { kind: 'manual', writes: false, note: 'расхождение имён с источником' },
  'idilesom-scout':            { kind: 'manual', writes: false, note: 'разведка источника маршрутов' },
  'inspect-tour-card':         { kind: 'manual', writes: false, note: 'осмотр карточки тура' },
  'partner-candidates-census': { kind: 'manual', writes: false, note: 'перепись кандидатов в партнёры' },
  // Объявлено по шапке самого роута (23.08): правка координаты места партиями
  // до 10, поимённо, с обязательным источником и dry_run по умолчанию.
  // Расписания быть не должно — координату правит человек по уликам.
  'place-audit':                { kind: 'manual', writes: false, note: 'поиск places по имени независимо от видимости/слияния + профиль безопасности, только чтение' },
  'sos-census':                { kind: 'manual', writes: false, note: 'кто шлёт SOS: сырые строки sos_events с IP, user-agent, сессией и сводки по ним, только чтение' },
  // 'place-coords' объявления здесь не несёт с 03.09: его зовёт place-coords.yml
  // (сухой прогон и правка по маркеру — Верхне-Опальские в 29 км от места);
  // объявление тут было бы вторым ответом на тот же вопрос, как у route-endpoints.
  'place-link':                { kind: 'manual', writes: true,  note: 'привязка места к маршруту' },
  'place-link-suggest':        { kind: 'manual', writes: false, note: 'предложения привязки' },
  'place-unlink':              { kind: 'manual', writes: true,  note: 'отвязка места от маршрута' },
  'places-by-type':            { kind: 'manual', writes: false, note: 'разрез мест по типу' },
  'places-candidates':         { kind: 'manual', writes: false, note: 'кандидаты в места' },
  'places-no-track-census':    { kind: 'manual', writes: false, note: 'места без трека' },
  'places-routes-census':      { kind: 'manual', writes: false, note: 'связи мест и маршрутов' },
  'prod-errors':               { kind: 'manual', writes: false, note: 'серверные ошибки прода списком, только чтение' },
  'prospect-scan':             { kind: 'manual', writes: false, note: 'скан проспектов' },
  'relief-sanity':             { kind: 'manual', writes: false, note: 'проверка рельефа' },
  'route-desc-census':         { kind: 'manual', writes: false, note: 'перепись описаний маршрутов' },
  'route-desc-read':           { kind: 'manual', writes: false, note: 'чтение описания маршрута' },
  'route-family-merge':        { kind: 'manual', writes: true,  note: 'слияние семьи маршрутов' },
  'route-fields-backfill':     { kind: 'manual', writes: false, note: 'добор полей маршрута' },
  'route-geometry-census':     { kind: 'manual', writes: false, note: 'линии, обещающие путь, которого нет' },
  'route-lay':                 { kind: 'manual', writes: true,  note: 'прокладка линии по дорожному графу (A*)' },
  'route-lay-census':          { kind: 'manual', writes: false, note: 'перепись рода линий' },
  'route-link-suggest':        { kind: 'manual', writes: false, note: 'предложения связей маршрута' },
  'route-place-twins':         { kind: 'manual', writes: false, note: 'двойники маршрут/место' },
  'route-title-census':        { kind: 'manual', writes: false, note: 'перепись имён маршрутов (§13)' },
  'route-translit-census':     { kind: 'manual', writes: false, note: 'перепись транслита' },
  'route-twins-enrich':        { kind: 'manual', writes: true,  note: 'обогащение двойников' },
  'route-twins-hide':          { kind: 'manual', writes: true,  note: 'скрытие двойников' },
  'route-web-null':            { kind: 'manual', writes: false, note: 'маршруты без веб-источника' },
  'routes-dedup':              { kind: 'manual', writes: true,  note: 'схлопывание дублей маршрутов' },
  'routes-unmerge':            { kind: 'manual', writes: false, note: 'откат схлопывания' },
  'tour-tracks-census':        { kind: 'manual', writes: false, note: 'перепись треков у туров' },
  'track-attachment-audit':    { kind: 'manual', writes: false, note: 'разбор привязки треков' },
  'verdict-census':            { kind: 'manual', writes: false, note: 'перепись вердиктов' },
  'web-routes-census':         { kind: 'manual', writes: false, note: 'перепись веб-маршрутов' },
};

export const DECLARED: Record<string, SchedulerDeclaration> = {
  ...EXTERNAL_SCHEDULE,
  ...MANUAL_ENDPOINTS,
};

/**
 * Чем запускается эндпоинт. `workflowDriven` — множество имён, вычисленное из
 * `.github/workflows` вызывающей стороной (сторожем или сборкой панели): читать
 * файлы отсюда нельзя, модуль ходит и в браузер.
 */
export function schedulerOf(endpoint: string, workflowDriven: ReadonlySet<string>): SchedulerKind {
  if (workflowDriven.has(endpoint)) return 'workflow';
  return DECLARED[endpoint]?.kind ?? 'undeclared';
}

/** Человеческое имя рода — для панели и логов. */
export const SCHEDULER_LABELS: Record<SchedulerKind, string> = {
  workflow: 'GitHub Actions',
  external: 'планировщик снаружи — подтвердить нечем',
  manual: 'вручную по адресу',
  undeclared: 'не объявлено',
};
