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
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  it('README на двух языках: команда установки, та же строка конфига, и «не проверено end-to-end» сказано вслух', () => {
    for (const f of ['README.md', 'README.zh.md']) {
      const md = read(`${PLUGIN_DIR}/${f}`);
      expect(md).toContain('dsh plugin --profile web add github:tourhabk-ui/dsh-vedar');
      expect(md).toContain(`url: ${MCP_URL}`);
      expect(md).toContain("name: '@deepseek-ai/dsh-mcp-client'");
      expect(md).toMatch(/112/);
    }
    expect(read(`${PLUGIN_DIR}/README.md`)).toMatch(/not yet been verified end to end/);
    expect(read(`${PLUGIN_DIR}/README.zh.md`)).toMatch(/尚未.*端到端验证/);
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
