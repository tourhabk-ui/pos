// Собирает карту из data.json (scripts/code-map): группы, связи, таблицы, сценарии, находки.
// Группы, сценарии и находки ниже записаны руками: сценарий проверяется по настоящим импортам
// и падает, если файл шага исчез; находки — с датой и способом проверки.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.env.MAP_OUT_DIR || DIR;
const data = JSON.parse(fs.readFileSync(path.join(WORK, 'data.json'), 'utf8'));
const known = new Set(fs.readFileSync(path.join(WORK, 'tables.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
const ROOT = data.root;

const GROUPS = [
  { id: 'entry', kind: 'entry', label: 'Входы мессенджеров', summary: 'Вебхуки MAX и Telegram. Сюда приходит каждое сообщение и нажатие кнопки; дальше вебхук решает, чей это чат и куда передать.', match: (p) => /^app\/api\/(max|telegram)\//.test(p) },
  { id: 'site', kind: 'site', label: 'Сайт: экраны CRM', summary: 'Входящие, Клиенты и Задачи в кабинете на сайте для всех ролей и их API. Тот же учёт клиентов, что в чате.', match: (p) => /^(app\/hub\/|components\/crm\/|app\/api\/hub\/crm\/)/.test(p) },
  { id: 'cabinet', kind: 'chat', label: 'Кабинет в чате', summary: 'Экраны кабинета в сообщениях бота: вкладки, «Ещё», сводка, поиск клиента, счёт нажатий. Кнопки правят то же сообщение.', match: (p) => /^lib\/(chat-cabinet|roles)\//.test(p) || p === 'lib/kuzmich/operator-chat.ts' },
  { id: 'max', kind: 'chat', label: 'MAX: доставка и защита', summary: 'Отправка и правка сообщений MAX, строка меню только снизу, проверка, что нажатие пришло от настоящего MAX.', match: (p) => /^lib\/max\//.test(p) },
  { id: 'operator', kind: 'role', label: 'Туроператор', summary: 'Даты и места фразой и мастером, запросы мест «Есть места / Мест нет», сводка запросов.', match: (p) => /^lib\/operators\/chat-/.test(p) || /^lib\/seat-requests\//.test(p) },
  { id: 'guide', kind: 'role', label: 'Гид', summary: 'Роль гида в чате: свои туры, правка текста и цены «было → станет», .docx, профиль, приглашение в команду, отзывы.', match: (p) => /^lib\/guides\//.test(p) },
  { id: 'carrier', kind: 'role', label: 'Перевозчик', summary: '«Поездка состоялась» и ссылка на отзыв, цена фразой на модерацию.', match: (p) => /^lib\/transfers\//.test(p) },
  { id: 'stay', kind: 'role', label: 'Хозяин жилья', summary: 'Ответ на заявку одной кнопкой, «занято с … по …» фразой, экран «Занято».', match: (p) => /^lib\/stay\//.test(p) },
  { id: 'rental', kind: 'role', label: 'Прокат', summary: 'Пилот «Лагуны»: «Беру / Не могу», календарь машин, правки на модерацию, своя строка меню.', match: (p) => /^lib\/rental\//.test(p) },
  { id: 'bookings', kind: 'role', label: 'Брони и заявки', summary: 'Кнопки «Подтвердить / Отклонить» с вторым шагом «Да», статусы заявок, переписка с клиентом по заявке.', match: (p) => /^lib\/(bookings|leads|requests)\//.test(p) },
  { id: 'team', kind: 'team', label: 'Команда и привязка чата', summary: 'Кто этот чат: коды и ссылки подключения, владелец чата, менеджеры оператора, вход на сайт через мессенджер.', match: (p) => /^lib\/partners\//.test(p) || /^lib\/operators\/(member-|team)/.test(p) },
  { id: 'crm', kind: 'crm', label: 'CRM: клиенты, задачи, лента', summary: 'Общее ядро для сайта, чата, Кузьмича и MCP: контакты, лента событий, задачи, напоминания, Входящие, ключи MCP.', match: (p) => /^lib\/crm\//.test(p) },
  { id: 'pd', kind: 'pd', label: 'Персональные данные', summary: 'Дверь, через которую имя и телефон клиента уходят партнёру: в MAX целиком, в Telegram заглушкой без ПД.', match: (p) => /^lib\/notifications\//.test(p) },
];
const groupOf = (p) => GROUPS.find((g) => g.match(p))?.id || null;

const CORE = [
  { id: 'core-db', label: 'База данных (пул)', match: (p) => /^lib\/(db-pool|database)/.test(p) },
  { id: 'core-telegram', label: 'Telegram API', match: (p) => /^lib\/telegram\//.test(p) },
  { id: 'core-notify', label: 'Уведомления', match: (p) => /^lib\/notifications\//.test(p) },
  { id: 'core-kuzmich', label: 'Кузьмич', match: (p) => /^lib\/kuzmich\//.test(p) },
  { id: 'core-auth', label: 'Вход и права', match: (p) => /^lib\/(auth|security)/.test(p) },
  { id: 'core-safety', label: 'Безопасность и 112', match: (p) => /^lib\/safety\//.test(p) },
  { id: 'core-legal', label: 'Согласия и юр. тексты', match: (p) => /^lib\/legal\//.test(p) },
  { id: 'core-tours', label: 'Туры и каталог', match: (p) => /^lib\/tours\//.test(p) },
  { id: 'core-other', label: 'Прочее ядро Ведара', match: () => true },
];
const coreOf = (p) => CORE.find((c) => c.match(p)).id;

const byPath = new Map(data.files.map((f) => [f.path, f]));
const files = data.files.map((f) => {
  const g = groupOf(f.path);
  const httpOk = /^(components\/|app\/hub\/)/.test(f.path);
  return {
    id: 'f:' + f.path,
    path: f.path,
    name: (() => { const parts = f.path.split('/'); const base = parts.at(-1).replace(/\.(tsx?|mjs|js)$/, ''); return ['route', 'page', 'layout', 'index'].includes(base) ? `${parts.at(-2)}/${base}` : base; })(),
    group: g,
    loc: f.loc,
    doc: f.doc,
    imports: f.imports.filter((p) => byPath.has(p)),
    outside: [...new Set(f.imports.filter((p) => !byPath.has(p)).map(coreOf))],
    http: httpOk ? f.http : [],
    tables: f.tables.filter((t) => known.has(t.n)).map((t) => t.n),
    usedByCode: f.usedByCode,
    usedByTests: f.usedByTests,
    isEntry: f.isEntry,
  };
});
const missing = files.filter((f) => !f.group);
if (missing.length) { console.error('unassigned', missing.map((f) => f.path)); process.exit(1); }

// Обратные связи внутри карты.
const usedBy = new Map();
for (const f of files) for (const t of f.imports) { if (!usedBy.has(t)) usedBy.set(t, []); usedBy.get(t).push(f.path); }
for (const f of files) f.usedBy = usedBy.get(f.path) || [];

// Сводные связи групп: импорты + вызовы /api (сайт → API).
const gEdges = new Map();
const add = (a, b, kind) => { if (a === b) return; const k = `${a}|${b}|${kind}`; gEdges.set(k, (gEdges.get(k) || 0) + 1); };
for (const f of files) {
  for (const t of f.imports) add(f.group, byPath.has(t) ? groupOf(t) : null, 'uses');
  for (const t of f.http) { const g = groupOf(t); if (g) add(f.group, g, 'http'); }
  for (const c of f.outside) add(f.group, c, 'core');
  if (f.tables.length) add(f.group, 'db', 'data');
}
const groupEdges = [...gEdges.entries()].map(([k, n]) => { const [a, b, kind] = k.split('|'); return { a, b, kind, n }; }).filter((e) => e.b && e.b !== 'null');

const tableUse = new Map();
for (const f of files) for (const t of f.tables) { if (!tableUse.has(t)) tableUse.set(t, []); tableUse.get(t).push(f.path); }
const tables = [...tableUse.entries()].map(([n, users]) => ({ n, users })).sort((a, b) => b.users.length - a.users.length);

// Сценарии — по настоящим импортам (проверяем каждую ступень).
const FLOWS = [
  {
    id: 'booking', title: 'Бронь подтверждается из MAX',
    lede: 'Оператор или гид получил уведомление о брони и жмёт «Подтвердить», потом «Да».',
    steps: [
      ['app/api/max/kuzmich/route.ts', 'MAX присылает нажатие кнопки на вебхук.'],
      ['lib/max/verified-press.ts', 'Проверка, что нажатие пришло от настоящего MAX: без ключа ничего не пишется.'],
      ['lib/chat-cabinet/signed-payload.ts', 'Подпись кнопки снимается: кнопка не подделана и не старше 3 дней.'],
      ['lib/bookings/chat-owner-press.ts', 'Разбор кнопки: какая бронь и какое действие.'],
      ['lib/bookings/chat-owner-action.ts', 'Вопрос «Подтвердить бронь №…?» и «Да». Нажать вправе только тот, кто подключил чат.'],
      ['lib/bookings/owner-status.ts', 'Смена статуса брони, то же правило, что у кнопки на сайте; запись в ленту клиента.'],
    ],
    table: 'operator_bookings',
  },
  {
    id: 'busy', title: 'Хозяин жилья пишет «занято с 5 по 9»',
    lede: 'Фраза в чате закрывает ночи для гостей. С #2948 запись идёт только после «Понял так: … Записать?», а вопрос ничего не пишет.',
    steps: [
      ['app/api/max/kuzmich/route.ts', 'Сообщение хозяина приходит на вебхук.'],
      ['lib/kuzmich/operator-chat.ts', 'Чат опознан как чат партнёра; до помощника проверяются короткие команды.'],
      ['lib/stay/busy-flow.ts', 'Фраза про «занято / свободно» уходит в поток жилья.'],
      ['lib/stay/busy-dates.ts', 'Разбор слов и дат: вопрос («ли», «?») командой не считается, прошедшая дата без года — переспрос.'],
    ],
    table: 'accommodation_availability',
  },
  {
    id: 'clients', title: 'Клиенты в чате: найти и позвонить',
    lede: 'Партнёр открывает «Клиенты», ищет по фамилии, звонит и отмечает итог.',
    steps: [
      ['app/api/max/kuzmich/route.ts', 'Нажатие «Клиенты» приходит на вебхук.'],
      ['lib/chat-cabinet/service.ts', 'Кабинет: проверка, чей это чат, и какой экран открыть.'],
      ['lib/crm/contact-queries.ts', 'Список и поиск клиентов: то же, что на сайте.'],
      ['lib/chat-cabinet/screens.ts', 'Экран из текста и кнопок; в Telegram без имён и телефонов.'],
      ['lib/chat-cabinet/max-deliver.ts', 'Правка того же сообщения в MAX.'],
      ['lib/max/menu-tail.ts', 'Строка меню остаётся только под последним сообщением.'],
    ],
    table: 'crm_contacts',
  },
  {
    id: 'site', title: 'Те же клиенты на сайте',
    lede: 'Оператор открывает «Клиенты» в кабинете на сайте и попадает в то же ядро CRM, что и чат.',
    steps: [
      ['app/hub/operator/clients/page.tsx', 'Страница «Клиенты» кабинета оператора.'],
      ['components/crm/ContactsScreen.tsx', 'Экран списка: поиск, метки, сегменты, выгрузка.'],
      ['components/crm/api.ts', 'Запрос к API кабинета.'],
      ['app/api/hub/crm/contacts/route.ts', 'API клиентов: проверка партнёра и прав.'],
      ['lib/crm/contact-queries.ts', 'Тот же запрос, что у чата в предыдущем сценарии.'],
    ],
    table: 'crm_contacts',
  },
];
for (const fl of FLOWS) {
  fl.callers = [];
  for (let i = 0; i < fl.steps.length; i++) {
    const [p] = fl.steps[i];
    if (!byPath.has(p)) { console.error('flow file missing', p); process.exit(1); }
    let caller = null;
    for (let j = i - 1; j >= 0; j--) {
      const pf = files.find((f) => f.path === fl.steps[j][0]);
      if (pf.imports.includes(p) || pf.http.includes(p)) { caller = j; break; }
    }
    fl.callers.push(caller);
  }
  fl.tableAt = fl.steps.findIndex(([p]) => files.find((f) => f.path === p).tables.includes(fl.table));
}

const FINDINGS = [
  { file: 'lib/stay/busy-dates.ts', sev: 'high', fixed: '#2948', status: 'найдено 02.11, исправлено в #2948', text: '«Свободно ли 5 ноября?» снимало занятость. Теперь вопрос ничего не пишет, а «занято с … по …» идёт через «Понял так: … Записать?».' },
  { file: 'lib/max/menu-tail.ts', sev: 'mid', fixed: '#2948', status: 'найдено 02.11, исправлено в #2948', text: 'После ответа «Беру / Свободно» следующее меню возвращало старый текст с живыми кнопками. Теперь отвеченная карточка забывается.' },
  { file: 'lib/rental/request-answer-store.ts', sev: 'mid', fixed: '#2948', status: 'найдено 02.11, исправлено в #2948', text: 'Перевозчик мог подтвердить поездку по своей же заявке. Теперь такая заявка получает отказ.' },
  { file: 'lib/transfers/ride-outcome-flow.ts', sev: 'low', status: 'по коду 02.11, открыто', text: '«Поездка состоялась» записывается до выдачи ссылки на отзыв; при сбое ссылку уже не выдать, менеджер об этом не узнаёт.' },
  { file: 'lib/requests/request-chat-service.ts', sev: 'low', status: 'по коду 02.11, открыто', text: 'Когда бот ждёт сообщение по заявке, текст «помогите, мы заблудились» уходит второй стороне, Кузьмич его не видит. Блок 112 к ответу приписан.' },
];
for (const x of FINDINGS) if (!byPath.has(x.file)) { console.error('finding file missing', x.file); process.exit(1); }

const big = files.filter((f) => f.loc >= 800).sort((a, b) => b.loc - a.loc).map((f) => ({ path: f.path, loc: f.loc }));
const hubs = [...files].sort((a, b) => b.imports.length - a.imports.length).slice(0, 5).map((f) => ({ path: f.path, n: f.imports.length }));
const shared = [...files].sort((a, b) => b.usedBy.length - a.usedBy.length).slice(0, 5).map((f) => ({ path: f.path, n: f.usedBy.length }));

const sha = process.env.MAP_SHA || '';

const graph = {
  meta: { sha, files: files.length, loc: files.reduce((s, f) => s + f.loc, 0), tables: tables.length, generated: data.generated.slice(0, 10), cycles: data.cycles.length, noDoc: files.filter((f) => !f.doc).length },
  groups: GROUPS.map(({ match, ...g }) => ({ ...g, files: files.filter((f) => f.group === g.id).length, loc: files.filter((f) => f.group === g.id).reduce((s, f) => s + f.loc, 0) })),
  core: CORE.map(({ match, ...c }) => c),
  files, groupEdges, tables, flows: FLOWS, findings: FINDINGS, big, hubs, shared,
};
fs.writeFileSync(path.join(WORK, 'graph.json'), JSON.stringify(graph));
const HTML = process.env.MAP_HTML || path.join(WORK, 'map.html');
const tpl = fs.readFileSync(path.join(DIR, 'template.html'), 'utf8');
fs.writeFileSync(HTML, tpl.replace('/*__GRAPH__*/null', JSON.stringify(graph).replace(/</g, '\\u003c')));
console.log('groups', GROUPS.map((g) => g.id + ':' + files.filter((f) => f.group === g.id).length).join(' '));
console.log('flows', FLOWS.map((f) => f.id + ' callers ' + f.callers.join(',') + ' tableAt:' + f.tableAt).join(' | '));
console.log('tables', tables.length, 'edges', groupEdges.length, 'bytes', fs.statSync(HTML).size);
