/**
 * Сторож: сервер готов к публикации в официальном реестре MCP и в каталогах.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 16.09 владелец принёс слова чужих агентов: «к vedarai.ru/api/mcp не
 * обращаемся — его нет в каталоге». Разбор показал, что каталог не один, а
 * четыре, и главный из них — официальный реестр (registry.modelcontextprotocol.io),
 * из которого раз в час тянут агрегаторы. Туда можно добавиться самим, но
 * перед этим у сервера нашлись три пробела, которые любое ревью увидит:
 *
 *   · `initialize` отвечал константой `2024-11-05` — ревизией эпохи HTTP+SSE,
 *     при том что сервер живёт на Streamable HTTP (ревизия 2025-03-26);
 *   · ни у одного из тринадцати инструментов не было аннотаций — хост не мог
 *     отличить «посмотреть погоду» от «оставить телефон менеджеру»;
 *   · на уведомление `notifications/initialized` уходил JSON-ответ с `id: null`
 *     — ответ на вопрос, которого не задавали.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * Не «файл server.json есть», а связка: манифест реестра совпадает с тем, что
 * сервер говорит о себе; аннотации есть у КАЖДОГО инструмента и пишущие
 * определяются ими же, а не вторым списком; версия протокола договаривается,
 * а не диктуется; доказательство владения доменом отдаётся только при
 * настоящем ключе.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES, TOOL_ANNOTATIONS, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { CANONICAL_BASE_URL } from '@/lib/config';
import {
  SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION, negotiateProtocolVersion,
} from '@/lib/mcp/protocol-version';
import {
  MCP_REGISTRY_PUBKEY, MCP_REGISTRY_PRIVATE_KEY_SECRET, ED25519_PUBKEY_B64, registryAuthLine,
} from '@/lib/mcp/registry-auth';

vi.mock('@/lib/kuzmich/core', () => ({
  executeKuzmichTool: vi.fn(async (name: string) => `executed:${name}`),
}));

import { POST } from '@/app/api/mcp/route';
import { GET as authGet } from '@/app/.well-known/mcp-registry-auth/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Требования схемы реестра (server.schema.json 2025-12-11), проверенные 16.09. */
const REGISTRY_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const REGISTRY_DESCRIPTION_MAX = 100;

describe('server.json — манифест для официального реестра', () => {
  const manifest = JSON.parse(read('server.json')) as {
    name: string; description: string; version: string; websiteUrl?: string;
    remotes: { type: string; url: string }[];
  };

  it('имя — наш домен в обратной записи, и workflow входит ключом этого домена', () => {
    /**
     * История имени за один день 17.09:
     *   · утро — `ru.vedarai/mcp` в манифесте, ключ у владельца;
     *   · день — владелец на телефоне, ключа нет; единственный путь без
     *     ключа и браузера — OIDC из Actions, а он даёт только
     *     `io.github.<владелец>/*`. Опубликовано как
     *     `io.github.tourhabk-ui/vedar`;
     *   · вечер — решение владельца завести ключ: публичная половина —
     *     константа в коде (деплоится с приложением), приватная — секрет
     *     Actions, добавляется с телефона. Имя снова доменное, старое
     *     помечается deprecated тем же прогоном.
     *
     * Манифест обязан совпадать с тем, каким правом входит workflow, —
     * иначе прогон красный по построению.
     */
    expect(manifest.name).toBe('ru.vedarai/mcp');
    expect(manifest.name).toMatch(REGISTRY_NAME);
  });

  it('workflow публикации существует, входит ключом домена и краснеет, если реестр нас не видит', () => {
    const wf = read('.github/workflows/mcp-registry-publish.yml');
    expect(wf).toMatch(/mcp-publisher login http --domain vedarai\.ru --private-key "\$\{\{ secrets\.MCP_REGISTRY_PRIVATE_KEY \}\}"/);
    expect(wf).toMatch(/mcp-publisher publish/);
    // Секрета нет — красный до входа, с именем секрета, а не «invalid
    // signature» от реестра без объяснения.
    expect(wf).toMatch(/secrets\.MCP_REGISTRY_PRIVATE_KEY \}\}" \]; then\s*\n\s*echo "::error::секрет MCP_REGISTRY_PRIVATE_KEY не задан/);
    // Старое имя io.github снимается тем же правом, каким заводилось —
    // OIDC остаётся ради этого, и только ради этого.
    expect(wf).toMatch(/id-token: write/);
    expect(wf).toMatch(/mcp-publisher status --status deprecated .* io\.github\.\$\{\{ github\.repository_owner \}\}\/vedar|\.\/mcp-publisher status --status deprecated .*"\$OLD"/);
    // Ноль результатов — отказ, не успех (§4.0).
    expect(wf).toMatch(/v0\.1\/servers\?search=/);
    expect(wf).toMatch(/sys\.exit\(1\)/);
    /**
     * Та же версия дважды — реестр отвечает 400 «cannot publish duplicate
     * version». Первый мерж в main (run 35182884177) это показал: маркер
     * опубликовал с ветки, squash тронул тот же маркер в main — второй
     * прогон красный на ровном месте. Поэтому публикация идёт только когда
     * версии в реестре ещё нет; «уже опубликовано» — третий исход, зелёный
     * и названный вслух, а не отказ и не молчание.
     */
    expect(wf).toMatch(/id: present/);
    expect(wf).toMatch(/if: steps\.present\.outputs\.present != 'true'\s*\n\s*run: \.\/mcp-publisher login http/);
    expect(wf).toMatch(/if: steps\.present\.outputs\.present != 'true'\s*\n\s*run: \.\/mcp-publisher publish/);
    expect(wf).toMatch(/уже опубликован/);
    // Пространство имён проверяется до публикации: чужое имя — ошибка с
    // объяснением, а не отказ реестра без слов.
    expect(wf).toMatch(/ru\.vedarai\/\*\) ;;/);
    // Маркер запуска — по общему соглашению репозитория.
    expect(wf).toMatch(/\.github\/triggers\/mcp-registry-publish\.json/);
    expect(read('.github/triggers/mcp-registry-publish.json')).toMatch(/"run"/);
    // Реестр читает ключ с прода: прогон ждёт СВОЮ сборку и идёт только из
    // main — прод собирается только оттуда (сторож marker-waits-for-deploy
    // поймал это на первом же CI, run 35193016946).
    expect(wf).toMatch(/run: bash scripts\/wait-for-deploy\.sh/);
    expect(wf).toMatch(/branches: \[main\]/);
    // Комментарии не в счёт: шапка объясняет, ПОЧЕМУ веток нет, и слово
    // там стоит законно (тот же урок, что у marker-waits-for-deploy 07.09).
    expect(wf.replace(/^[ \t]*#.*$/gm, '')).not.toMatch(/claude\/\*\*/);
  });

  it('описание влезает в лимит реестра', () => {
    // Карточка для каталогов из #1915 — ~200 знаков; реестр режет на 100.
    // Здесь лежит ужатая, и она не должна снова разрастись.
    expect(manifest.description.length).toBeLessThanOrEqual(REGISTRY_DESCRIPTION_MAX);
    expect(manifest.description.length).toBeGreaterThan(20);
  });

  it('версия — та же, что сервер называет на рукопожатии', () => {
    // Две версии в двух файлах разъедутся на первом же релизе.
    expect(manifest.version).toBe(MCP_SERVER_INFO.version);
  });

  it('удалённый эндпоинт — наш живой сервер по Streamable HTTP', () => {
    expect(manifest.remotes).toHaveLength(1);
    expect(manifest.remotes[0]).toEqual({ type: 'streamable-http', url: `${CANONICAL_BASE_URL}/api/mcp` });
    expect(manifest.websiteUrl).toBe(`${CANONICAL_BASE_URL}/mcp`);
  });
});

describe('доказательство владения доменом — публичная половина в коде, приватная только в секрете', () => {
  it('публичный ключ — настоящий Ed25519 в base64, а не заглушка', () => {
    // 32 байта → 43 символа и «=». Нули — не ключ: пара заведена 17.09,
    // и её публичная половина обязана быть непустой по содержанию.
    expect(MCP_REGISTRY_PUBKEY).toMatch(ED25519_PUBKEY_B64);
    expect(MCP_REGISTRY_PUBKEY).not.toMatch(/^A{43}=$/);
  });

  it('/.well-known/mcp-registry-auth отдаёт одну строку формата реестра, всегда 200', async () => {
    const res = await authGet();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await res.text()).toBe(`v=MCPv1; k=ed25519; p=${MCP_REGISTRY_PUBKEY}`);
    expect(registryAuthLine()).toBe(`v=MCPv1; k=ed25519; p=${MCP_REGISTRY_PUBKEY}`);
  });

  it('приватной половины нет ни в коде, ни в примере окружения — только имя секрета', () => {
    /**
     * Приватное семя — 64 hex-знака. В дереве ему места нет: сторож ищет
     * упоминания секрета и требует, чтобы рядом с ними не стояло значения.
     * Полную проверку «нигде нет 64-hex» делать нельзя — хэши коммитов и
     * контрольные суммы той же длины; поэтому граница проводится по имени.
     */
    const env = read('.env.example');
    expect(env).not.toMatch(/MCP_REGISTRY_/);
    for (const f of ['lib/mcp/registry-auth.ts', '.github/workflows/mcp-registry-publish.yml']) {
      const src = read(f);
      const mentions = src.match(new RegExp(`${MCP_REGISTRY_PRIVATE_KEY_SECRET}[^\\n]*`, 'g')) ?? [];
      expect(mentions.length, `${f}: секрет не упомянут`).toBeGreaterThan(0);
      for (const m of mentions) {
        expect(m, `${f}: рядом с именем секрета стоит значение`).not.toMatch(/[0-9a-f]{64}/);
      }
    }
  });
});

describe('аннотации — у каждого инструмента, и пишущие определяются ими', () => {
  it('ни одного инструмента без аннотаций и заголовка', () => {
    for (const t of PUBLIC_MCP_TOOLS) {
      expect(t.annotations, `${t.name}: нет аннотаций — хост не поймёт, спрашивать ли человека`).toBeDefined();
      expect(t.title, `${t.name}: нет заголовка`).toBeTruthy();
    }
  });

  it('записи в TOOL_ANNOTATIONS нет для инструмента, которого нет наружу', () => {
    // Иначе список пухнет мёртвыми именами и перестаёт быть переписью.
    const live = new Set(PUBLIC_MCP_TOOLS.map((t) => t.name));
    for (const name of Object.keys(TOOL_ANNOTATIONS)) {
      expect(live.has(name), `${name}: аннотация есть, инструмента нет`).toBe(true);
    }
  });

  it('пишущих ровно два, и это заявки; всё остальное только читает', () => {
    expect([...WRITE_TOOL_NAMES].sort()).toEqual(['create_booking_request', 'create_lead']);
    for (const t of PUBLIC_MCP_TOOLS) {
      const a = t.annotations!;
      if (WRITE_TOOL_NAMES.has(t.name)) {
        expect(a.readOnlyHint).toBe(false);
        // Заявка создаёт запись, чужие не трогает.
        expect(a.destructiveHint).toBe(false);
      } else {
        expect(a.readOnlyHint, `${t.name} читает, а помечен пишущим`).toBe(true);
        expect(a.idempotentHint).toBe(true);
      }
    }
  });

  it('роут берёт пишущие из аннотаций, а не из своего списка', () => {
    const src = read('app/api/mcp/route.ts');
    expect(src).toMatch(/WRITE_TOOL_NAMES/);
    expect(src).not.toMatch(/new Set<string>\(\[CREATE_LEAD_TOOL\.name/);
  });
});

describe('версия протокола договаривается, а не диктуется', () => {
  it('новейшая — первая в списке; список не пуст', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBeGreaterThanOrEqual(3);
    expect(LATEST_PROTOCOL_VERSION).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    // Streamable HTTP появился в 2025-03-26: сервер на нём обязан называть
    // хотя бы эту ревизию, иначе называет то, чем не является.
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-03-26');
  });

  it('запрошенную поддерживаемую — возвращает ту же; незнакомую — новейшую нашу', () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) expect(negotiateProtocolVersion(v)).toBe(v);
    expect(negotiateProtocolVersion('2099-01-01')).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('роут зовёт переговоры и не держит версию константой', () => {
    const src = read('app/api/mcp/route.ts');
    expect(src).toMatch(/negotiateProtocolVersion\(/);
    expect(src).not.toMatch(/protocolVersion: '\d{4}-\d{2}-\d{2}'/);
  });

  it('живое рукопожатие: клиент просит 2025-03-26 — получает её', async () => {
    const res = await POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    }));
    const json = await res.json();
    expect(json.result.protocolVersion).toBe('2025-03-26');
    expect(json.result.serverInfo.version).toBe(MCP_SERVER_INFO.version);
  });
});

describe('уведомление — без ответа', () => {
  it('notifications/initialized принимается пустым 202', async () => {
    const res = await POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
});
