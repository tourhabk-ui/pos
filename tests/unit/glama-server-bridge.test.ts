/**
 * Сторож моста на Glama (integrations/glama, слово владельца 19.11 «Мост»).
 *
 * Главный список MCP-серверов берёт строку только с записью сервера на Glama,
 * а Glama собирает образ по форме: шаги сборки и CMD. Сервер Ведара удалённый,
 * поэтому образ — мост mcp-remote к https://vedarai.ru/api/mcp. Значения формы
 * владелец вставляет руками из README, повтор образа — Dockerfile, данные —
 * glama-build.json. Три копии одного решения расходятся молча; сторож держит
 * их вместе и с адресом сервера (MCP_ENDPOINT, server.json).
 *
 * Сама сборка у Glama и проверка инструментов отсюда не видны: докера в CI
 * нет, прод из тестов не зовётся. Мост проверен руками 19.11 (README).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_ENDPOINT } from '@/lib/mcp/connect';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DIR = 'integrations/glama';

interface GlamaBuild {
  endpoint: string;
  buildSteps: string[];
  cmdArguments: string[];
  mcpProxyVersion: string;
}

const build = JSON.parse(read(`${DIR}/glama-build.json`)) as GlamaBuild;
const dockerfile = read(`${DIR}/Dockerfile`);
const readme = read(`${DIR}/README.md`);

/** Строки внутри ```-блоков README. */
function codeBlocks(md: string): string[] {
  return [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
}

/** Инструкции Dockerfile без комментариев, с перенесёнными строками склеенными. */
function instructions(df: string): string[] {
  return df
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

describe('мост на Glama — адрес', () => {
  it('мост ведёт на канонический адрес MCP и на адрес из server.json', () => {
    const manifest = JSON.parse(read('server.json')) as { remotes: Array<{ url: string }> };
    expect(build.endpoint).toBe(MCP_ENDPOINT);
    expect(manifest.remotes.map((r) => r.url)).toContain(build.endpoint);
    expect(build.cmdArguments).toContain(build.endpoint);
  });

  it('транспорт — Streamable HTTP, без отката на SSE', () => {
    const i = build.cmdArguments.indexOf('--transport');
    expect(i).toBeGreaterThan(0);
    expect(build.cmdArguments[i + 1]).toBe('http-only');
    // --allow-http нужен только для http://; в форме Glama его быть не должно
    expect(build.cmdArguments).not.toContain('--allow-http');
  });
});

describe('мост на Glama — версии', () => {
  const pinned = (spec: string) => /@\d+\.\d+\.\d+$/.test(spec);

  it('каждый пакет шага сборки закреплён точной версией', () => {
    expect(build.buildSteps.length).toBeGreaterThan(0);
    for (const step of build.buildSteps) {
      const pkgs = step.replace(/^npm install -g\s+/, '').split(/\s+/);
      expect(step.startsWith('npm install -g '), step).toBe(true);
      for (const p of pkgs) expect(pinned(p), `${p} без точной версии`).toBe(true);
    }
    expect(/^\d+\.\d+\.\d+$/.test(build.mcpProxyVersion)).toBe(true);
  });

  it('команда CMD — та, что ставит шаг сборки', () => {
    const bin = build.cmdArguments[0];
    expect(build.buildSteps.some((s) => s.includes(` ${bin}@`))).toBe(true);
  });
});

describe('мост на Glama — README и Dockerfile повторяют форму', () => {
  it('README даёт оба поля формы одной строкой, ровно как в glama-build.json', () => {
    const blocks = codeBlocks(readme);
    expect(blocks).toContain(JSON.stringify(build.buildSteps));
    expect(blocks).toContain(JSON.stringify(build.cmdArguments));
    for (const b of blocks) expect(b.includes('\n'), `многострочный блок: ${b}`).toBe(false);
  });

  it('README не ставит «mcp-proxy --» в CMD: Glama добавляет их сама', () => {
    const cmd = JSON.parse(codeBlocks(readme).find((b) => b.includes(build.endpoint)) ?? '[]') as string[];
    expect(cmd).not.toContain('mcp-proxy');
  });

  it('Dockerfile исполняет шаги сборки и mcp-proxy той же версии', () => {
    const runs = instructions(dockerfile).filter((l) => l.startsWith('RUN '));
    for (const step of build.buildSteps) {
      expect(runs.some((r) => r.includes(step)), step).toBe(true);
    }
    expect(runs.some((r) => r.includes(`npm install -g mcp-proxy@${build.mcpProxyVersion}`))).toBe(true);
  });

  it('CMD Dockerfile = «mcp-proxy --» и CMD формы', () => {
    const cmdLine = instructions(dockerfile).find((l) => l.startsWith('CMD '));
    expect(cmdLine).toBeDefined();
    const cmd = JSON.parse(cmdLine!.slice(4)) as string[];
    expect(cmd).toEqual(['mcp-proxy', '--', ...build.cmdArguments]);
  });

  it('основа образа — та, что ставит Glama', () => {
    const from = instructions(dockerfile).find((l) => l.startsWith('FROM '));
    expect(from).toBe('FROM debian:trixie-slim');
    expect(dockerfile).toContain('setup_24.x');
  });
});

describe('владение записью', () => {
  it('glama.json в корне называет аккаунт, которым владелец подтверждает запись', () => {
    const g = JSON.parse(read('glama.json')) as { maintainers: string[] };
    expect(g.maintainers).toContain('tourhabk-ui');
    expect(readme).toContain('`tourhabk-ui`');
  });
});
