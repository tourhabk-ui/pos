/**
 * Сторож интеграций с DeepSeek Harness (dsh), 13.10 — карт-бланш владельца
 * «подключи китайские модели».
 *
 * В каталоге integrations/ лежат два артефакта для чужих репозиториев:
 *   - dsh-vedar/ — плагин DeepSeek Harness: одна строка официального моста
 *     @deepseek-ai/dsh-mcp-client к нашему MCP-серверу (копируется в
 *     репозиторий tourhabk-ui/dsh-vedar, устанавливается
 *     `dsh plugin --profile web add github:tourhabk-ui/dsh-vedar`);
 *   - dsh-mcp-connector-registry/connectors/vedar.json — карточка для каталога
 *     коннекторов плагина dsh-mcp-connector (PR в duhu2000/dsh-mcp-connector-registry).
 *
 * Оба обещают адрес и имя сервера. Обещание без источника — провод в никуда
 * (CLAUDE.md, правило 10.09): адрес здесь берётся из server.json, того же
 * манифеста, которым мы стоим в официальном реестре MCP, и расхождение с ним
 * краснеет. Поля — по README @deepseek-ai/dsh-mcp-client 0.2.0-rc.2 и
 * docs/ONBOARDING.md каталога (оба сверены 13.10).
 *
 * С 15.10 (аудит, находка CN-dsh) здесь же — файлы подачи плагина в два
 * магазина DeepSeek Harness (docs/agents/submissions/dsh/) и диапазон моста в
 * peerDependencies плагина.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import semver from 'semver';
import { PUBLIC_MCP_TOOL_NAMES, WRITE_TOOL_NAMES, TOOL_ENGLISH } from '@/lib/mcp/public-tools';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const manifest = JSON.parse(read('server.json')) as { remotes: Array<{ type: string; url: string }> };
const MCP_URL = manifest.remotes[0].url;

const PLUGIN_DIR = 'integrations/dsh-vedar';
const CARD_PATH = 'integrations/dsh-mcp-connector-registry/connectors/vedar.json';

/** Девять стандартных категорий каталога (docs/ONBOARDING.md, раздел 6). */
const REGISTRY_CATEGORIES = ['企业数据', '金融投资', '法律合规', '开发工具', '办公协作', '调研分析', '设计创意', '效率工具', '其他'];

/** Контракт serverName моста: `[A-Za-z0-9_-]{1,32}` (README dsh-mcp-client). */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Значение ключа в плоском YAML плагина; кавычки снимаются. */
function yamlValue(src: string, key: string): string | null {
  const m = src.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

interface Card {
  schemaVersion: number;
  id: string;
  name: string;
  icon: string;
  category: string;
  summary: string;
  description: string;
  published: boolean;
  featured: boolean;
  homepage: string;
  probeStatus: string;
  auth: { mode: string };
  servers: Array<{ serverKey: string; serverName: string; url: string; transport: string; headers?: Record<string, string> }>;
  prompts: Array<{ title: string; text: string; server: string }>;
}

describe('плагин dsh-vedar — строка официального моста к нашему адресу', () => {
  const patch = read(`${PLUGIN_DIR}/cordis.patch.yml`);
  const pkg = JSON.parse(read(`${PLUGIN_DIR}/package.json`)) as {
    name: string; main: string; files: string[]; keywords: string[];
    dsh: { bundle: { patch: string } };
    peerDependencies: Record<string, string>;
  };

  it('cordis.patch.yml: один insert, мост @deepseek-ai/dsh-mcp-client, streamable-http, адрес из server.json', () => {
    expect((patch.match(/^- insert:/gm) ?? []).length).toBe(1);
    expect(yamlValue(patch, 'name')).toBe('@deepseek-ai/dsh-mcp-client');
    expect(yamlValue(patch, 'transport')).toBe('streamable-http');
    expect(yamlValue(patch, 'url')).toBe(MCP_URL);
    expect(yamlValue(patch, 'serverName')).toMatch(SERVER_NAME_RE);
    // Авторизации у сервера нет — и в строке её быть не должно.
    expect(patch).not.toMatch(/headers|authorization|token/i);
  });

  it('package.json: dsh.bundle.patch ведёт на этот файл, он в files, тема dsh-plugin в keywords, есть точка входа', () => {
    expect(pkg.name).toBe('dsh-vedar');
    expect(pkg.dsh.bundle.patch.replace(/^\.\//, '')).toBe('cordis.patch.yml');
    expect(pkg.files).toContain('cordis.patch.yml');
    expect(pkg.files).toContain(pkg.main.replace(/^\.\//, ''));
    expect(pkg.keywords).toContain('dsh-plugin');
    expect(Object.keys(pkg.peerDependencies)).toContain('@deepseek-ai/dsh-mcp-client');
  });

  it('README на двух языках: команда установки, та же строка конфига, и проверка end-to-end названа с версией dsh пробы', () => {
    for (const f of ['README.md', 'README.zh.md']) {
      const md = read(`${PLUGIN_DIR}/${f}`);
      expect(md).toContain('dsh plugin --profile web add github:tourhabk-ui/dsh-vedar');
      expect(md).toContain(`url: ${MCP_URL}`);
      expect(md).toContain("name: '@deepseek-ai/dsh-mcp-client'");
      expect(md).toMatch(/112/);
    }
    // 14.10, прогон 2 dsh-vedar-probe: зелёный. Статус называет версию dsh, на
    // которой проверено, — ту же, что в маркере пробы: сменилась версия в
    // пробе, а README говорит о старой — «проверено» уже не про эту.
    const { dsh_version } = JSON.parse(read('.github/triggers/dsh-vedar-probe.json')) as { dsh_version: string };
    expect(read(`${PLUGIN_DIR}/README.md`)).toContain(`Verified end to end on 2026-10-14 with dsh ${dsh_version}`);
    expect(read(`${PLUGIN_DIR}/README.zh.md`)).toContain(`用 dsh ${dsh_version}`);
    expect(read(`${PLUGIN_DIR}/README.zh.md`)).toMatch(/完成端到端验证/);
    for (const f of ['README.md', 'README.zh.md']) expect(read(`${PLUGIN_DIR}/${f}`)).not.toMatch(/not yet been verified|尚未/);
  });
});

/**
 * Живая проба плагина (владелец 14.10: «проверяй») — .github/workflows/dsh-vedar-probe.yml.
 * Она стоит ровно столько, сколько похожа на путь пользователя: плагин ставится
 * тем адресом пакета, что в README, а не локальной копией из integrations/; вызовы
 * считаются по имени сервера из самой строки плагина; вопрос не просит заявок —
 * проба не должна будить менеджера настоящим лидом.
 */
describe('проба dsh-vedar-probe.yml — путь пользователя, а не обходной', () => {
  const wf = read('.github/workflows/dsh-vedar-probe.yml');
  const marker = JSON.parse(read('.github/triggers/dsh-vedar-probe.json')) as { dsh_version: string; question: string; run: number };
  const serverName = yamlValue(read(`${PLUGIN_DIR}/cordis.patch.yml`), 'serverName');

  it('плагин ставится с GitHub тем же адресом пакета, что в README, а не копией из integrations/', () => {
    const spec = read(`${PLUGIN_DIR}/README.md`).match(/dsh plugin --profile \w+ add (\S+)/)?.[1];
    expect(spec).toBe('github:tourhabk-ui/dsh-vedar');
    expect(wf).toContain(`dsh plugin --profile headless add ${spec}`);
    expect(wf).not.toMatch(/plugin --profile \w+ add \S*integrations\//);
  });

  it('вызовы Ведара считаются по имени сервера из строки плагина', () => {
    expect(serverName).not.toBeNull();
    expect(wf).toContain(`'mcp__${serverName}__'`);
  });

  it('pnpm ставится раньше `dsh plugin add` (прогон 1: «pnpm was not found»), и README называют его предпосылкой', () => {
    const install = wf.indexOf('"pnpm@$PNPM"');
    expect(install).toBeGreaterThan(-1);
    // Шапка workflow тоже называет команду — сравнивается с её запуском в шаге.
    expect(install).toBeLessThan(wf.lastIndexOf('dsh plugin --profile headless add'));
    expect((marker as { pnpm_version?: string }).pnpm_version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const f of ['README.md', 'README.zh.md']) {
      expect(read(`${PLUGIN_DIR}/${f}`)).toContain('npm i -g pnpm');
    }
  });

  it('маркер: версия dsh закреплена, вопрос прямо запрещает заявки', () => {
    expect(marker.dsh_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(wf).toContain('@deepseek-ai/dsh@$VER');
    expect(marker.question).toContain('不要提交任何申请');
  });
});

describe('карточка для каталога коннекторов DeepSeek Harness', () => {
  const card = JSON.parse(read(CARD_PATH)) as Card;
  const pluginServerName = yamlValue(read(`${PLUGIN_DIR}/cordis.patch.yml`), 'serverName');

  it('id равен имени файла, auth none, один сервер streamable-http на адрес из server.json, serverName тот же, что у плагина', () => {
    expect(card.schemaVersion).toBe(1);
    expect(CARD_PATH.endsWith(`/${card.id}.json`)).toBe(true);
    expect(card.auth).toEqual({ mode: 'none' });
    expect(card.servers).toHaveLength(1);
    const s = card.servers[0];
    expect(s.transport).toBe('streamable-http');
    expect(s.url).toBe(MCP_URL);
    expect(s.serverName).toMatch(SERVER_NAME_RE);
    expect(s.serverName).toBe(pluginServerName);
    // Заголовки — только протокольные; ключей и Authorization быть не может.
    for (const h of Object.keys(s.headers ?? {})) expect(h.toLowerCase()).not.toMatch(/authorization|key|token/);
    for (const p of card.prompts) expect(p.server).toBe(s.serverKey);
  });

  it('категория из девяти стандартных, иконка HTTPS на нашем домене, published true, featured false, статус unverified', () => {
    expect(REGISTRY_CATEGORIES).toContain(card.category);
    expect(card.icon).toMatch(/^https:\/\/vedarai\.ru\//);
    expect(card.homepage).toMatch(/^https:\/\/vedarai\.ru\//);
    expect(card.published).toBe(true);
    expect(card.featured).toBe(false);
    expect(card.probeStatus).toBe('unverified');
    expect(card.name).toMatch(/堪察加/);
    expect(card.description).toMatch(/112/);
  });

  it('примеры запросов — только чтение: не зовут четыре пишущих инструмента и не несут телефонов и почт', () => {
    expect(card.prompts.length).toBeGreaterThan(0);
    for (const p of card.prompts) {
      expect(p.text).not.toMatch(/create_lead|create_booking_request|create_stay_request|request_charter/);
      expect(p.text).not.toMatch(/@|\+7|\d{6,}/);
    }
  });
});

/**
 * Файлы подачи плагина в два магазина DeepSeek Harness — аудит 15.10, находка
 * CN-dsh. Готовим мы, подаёт владелец; лежат в docs/agents/submissions/dsh/ по
 * тем же путям, что в чужих репозиториях.
 *
 * Правила формы ниже — копии правил самих магазинов, сверенные 15.10 по их
 * файлам (raw.githubusercontent.com): awesome-dsh-plugin — contributing.md и
 * scripts/lib/entries.mjs; 1024Store — CONTRIBUTING.md,
 * catalog/schema/plugin.schema.json, catalog/categories.json и
 * scripts/lib/catalog-entry.mjs. Разойдутся с магазином — первым скажет его CI
 * на PR; здесь держится то, что CI магазина не видит: адрес репозитория,
 * описание без числа инструментов (мейнтейнер awesome-dsh-plugin его
 * пересчитывает, а код плагина — одна строка) и то, что каждое обещание
 * описания стоит на инструменте нашего сервера (правило 10.09).
 */
const SUBMISSIONS = 'docs/agents/submissions/dsh';
const PLUGIN_REPO = 'https://github.com/tourhabk-ui/dsh-vedar';
const AWESOME_FILE = `${SUBMISSIONS}/awesome-dsh-plugin/data/plugins/tourhabk-ui__dsh-vedar.yml`;
const STORE1024_FILE = `${SUBMISSIONS}/1024store/catalog/plugins/tourhabk-ui--dsh-vedar.json`;

/** awesome-dsh-plugin, slugFor(): `https://github.com/o/r` -> `o__r`. */
function awesomeSlugFor(url: string): string {
  const p = url.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
  const repo = p.split('/').slice(0, 2).join('/');
  const sub = p.includes('/tree/') ? p.split('/tree/')[1].replace(/^[^/]+\//, '') : null;
  const base = repo.replaceAll('/', '__');
  return sub ? `${base}--${sub.replaceAll('/', '-')}` : base;
}
/** awesome-dsh-plugin, CAT_IDS. */
const AWESOME_CATEGORIES = ['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun'];
/** awesome-dsh-plugin, ENTRY_KEYS без служебного `file`. */
const AWESOME_KEYS = ['url', 'name', 'category', 'description', 'tarball'];

/** 1024Store, pluginFileName(): сегменты id в нижний регистр, не-буквы в `-`, склейка `--`. */
function store1024FileName(id: string): string {
  const slugPart = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${id.split('/').map(slugPart).join('--')}.json`;
}
/** 1024Store, catalog/categories.json. */
const STORE1024_CATEGORIES = ['ui', 'theme', 'session', 'memory', 'tools', 'skill', 'workflow', 'notify', 'model', 'dev', 'fun'];
/** 1024Store, isIsoDate(). */
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Число инструментов в описании — запрет. Любая цифра (их у нас нет и в
 * адресе), числительное перед tools и китайское числительное перед 工具.
 * Возвращает найденное или null.
 */
function toolCountClaim(text: string): string | null {
  return (
    text.match(/\d+/)?.[0]
    ?? text.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|dozens?|several|many)\s+(?:\w+\s+)?tools?\b/i)?.[0]
    ?? text.match(/[一二两三四五六七八九十百几多]+\s*[个种项]?\s*工具/)?.[0]
    ?? null
  );
}

/**
 * Что описание обещает — и каким инструментом сервера это сделано. Инструмент
 * убран или переименован — описание в магазине стало неправдой, и это
 * должно краснеть здесь, а не в отказе мейнтейнера.
 */
const CLAIMS: Array<{ en: string; zh: string; tool: string }> = [
  { en: 'Kamchatka tours', zh: '堪察加旅游', tool: 'get_tours' },
  { en: 'live availability', zh: '实时余位', tool: 'get_tour_availability' },
  { en: 'safety status of places', zh: '地点安全状况', tool: 'get_guardian_context' },
  { en: 'stays', zh: '住宿', tool: 'search_accommodations' },
  { en: 'transfers', zh: '包车接送', tool: 'search_transfers' },
  { en: 'weather', zh: '天气', tool: 'get_weather' },
  { en: 'trip plans', zh: '行程规划', tool: 'make_trip_plan' },
  { en: 'booking requests are confirmed by a human', zh: '预订申请由人工确认', tool: 'create_booking_request' },
];

describe('файлы подачи dsh-vedar в awesome-dsh-plugin и 1024Store (CN-dsh, 15.10)', () => {
  // Разбор — внутри тестов, а не на уровне describe: неразбираемый YAML
  // (например, `en: Foo: bar` без кавычек — самая частая поломка по их
  // contributing) краснеет своими тестами с ошибкой парсера, а не роняет файл.
  type AwesomeEntry = Record<string, unknown> & {
    url: string; name: string; category: string; description: Record<string, string>;
  };
  const awesomeEntry = () => loadYaml(read(AWESOME_FILE)) as AwesomeEntry;
  const store = JSON.parse(read(STORE1024_FILE)) as Record<string, unknown> & {
    $schema: string; id: string; name: string; repository: string; category: string;
    description: Record<string, string>; added: string;
  };

  it('awesome-dsh-plugin: ключи из их списка, url — наш репозиторий, имя файла выводится из url, категория tools', () => {
    const awesome = awesomeEntry();
    for (const k of Object.keys(awesome)) expect(AWESOME_KEYS).toContain(k);
    expect(awesome.url).toBe(PLUGIN_REPO);
    expect(AWESOME_FILE.endsWith(`/data/plugins/${awesomeSlugFor(awesome.url)}.yml`)).toBe(true);
    // name — текст ссылки; owner/repo в нём обязан называть тот же репозиторий.
    expect(awesome.name).toBe(awesome.url.replace(/^https:\/\/github\.com\//, ''));
    expect(AWESOME_CATEGORIES).toContain(awesome.category);
    expect(awesome.category).toBe('tools');
    for (const k of Object.keys(awesome.description)) expect(['en', 'zh']).toContain(k);
    expect(awesome.description.en.trim().length).toBeGreaterThan(0);
    expect(awesome.description.en).not.toMatch(/\n/);
    expect(awesome.description.en.endsWith('.')).toBe(true);
  });

  it('1024Store: ровно их ключи, id и имя файла согласованы, repository — наш репозиторий, дата настоящая', () => {
    expect(Object.keys(store).sort()).toEqual(['$schema', 'added', 'category', 'description', 'id', 'name', 'repository']);
    expect(store.$schema).toBe('../schema/plugin.schema.json');
    expect(store.id).toBe('tourhabk-ui/dsh-vedar');
    expect(STORE1024_FILE.endsWith(`/catalog/plugins/${store1024FileName(store.id)}`)).toBe(true);
    expect(store.repository).toBe(`https://github.com/${store.id}`);
    expect(store.repository).toBe(PLUGIN_REPO);
    expect(store.name).toBe('dsh-vedar');
    expect(STORE1024_CATEGORIES).toContain(store.category);
    expect(store.category).toBe('tools');
    expect(Object.keys(store.description).sort()).toEqual(['en', 'zh']);
    for (const loc of ['en', 'zh']) {
      expect(store.description[loc].trim().length).toBeGreaterThan(0);
      expect(store.description[loc].length).toBeLessThanOrEqual(1000);
    }
    expect(isIsoDate(store.added)).toBe(true);
  });

  it('одно английское описание на оба магазина, и ни в одном нет числа инструментов', () => {
    const awesome = awesomeEntry();
    expect(store.description.en).toBe(awesome.description.en);
    for (const text of [awesome.description.en, awesome.description.zh, store.description.en, store.description.zh]) {
      if (text === undefined) continue;
      expect(toolCountClaim(text)).toBeNull();
    }
  });

  it('сторож числа сам ловит то, что должен (иначе зелёный ничего не значит)', () => {
    expect(toolCountClaim('Connects to the Vedar server with 20 tools.')).not.toBeNull();
    expect(toolCountClaim('Twenty read tools and four write tools.')).not.toBeNull();
    expect(toolCountClaim('提供二十个工具')).not.toBeNull();
  });

  it('каждое обещание описания стоит на инструменте сервера; заявки — пишущий инструмент с подтверждением человеком', () => {
    for (const c of CLAIMS) {
      expect(store.description.en, c.en).toContain(c.en);
      expect(store.description.zh, c.zh).toContain(c.zh);
      expect(PUBLIC_MCP_TOOL_NAMES.has(c.tool), c.tool).toBe(true);
    }
    expect(WRITE_TOOL_NAMES.has('create_booking_request')).toBe(true);
    expect(TOOL_ENGLISH.create_booking_request.lead).toMatch(/human-confirmed/);
  });

  it('README подачи называет те пути, по которым файлы лягут в магазинах', () => {
    const md = read(`${SUBMISSIONS}/README.md`);
    expect(md).toContain(`data/plugins/${awesomeSlugFor(PLUGIN_REPO)}.yml`);
    expect(md).toContain(`catalog/plugins/${store1024FileName(store.id)}`);
    expect(md).toContain('https://github.com/awesome-dsh-plugin/awesome-dsh-plugin');
    expect(md).toContain('https://github.com/imsai-sh/awesome-deepseek-harness-plugins');
  });
});

/**
 * Диапазон моста в peerDependencies плагина (CN-dsh, 15.10). `"*"` по правилам
 * semver не пускает предрелизы, а dsh 0.2.0-rc.2 ставит мост
 * @deepseek-ai/dsh-mcp-client ровно 0.2.0-rc.2 (зависимость dsh в npm, сверено
 * 15.10): плагин объявлял несовместимость с тем, на чём проверен. contributing
 * awesome-dsh-plugin предупреждает именно об этом. Версия берётся из маркера
 * пробы — той, на которой плагин проверен end-to-end.
 */
describe('peerDependencies dsh-vedar пускают мост той версии dsh, на которой плагин проверен', () => {
  const pkg = JSON.parse(read(`${PLUGIN_DIR}/package.json`)) as { peerDependencies: Record<string, string> };
  const { dsh_version } = JSON.parse(read('.github/triggers/dsh-vedar-probe.json')) as { dsh_version: string };

  it('диапазон валиден и включает предрелиз пробы и стабильный выпуск той же линии', () => {
    const range = pkg.peerDependencies['@deepseek-ai/dsh-mcp-client'];
    expect(semver.validRange(range)).not.toBeNull();
    expect(semver.satisfies(dsh_version, range)).toBe(true);
    expect(semver.satisfies(semver.coerce(dsh_version)!.version, range)).toBe(true);
  });
});
