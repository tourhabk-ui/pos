/**
 * Сторож: публикация в Smithery из Actions — по ключу из секрета, с
 * ожиданием своей сборки и проверкой «нас видно».
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 17.09 владелец принёс инструкцию Smithery: вход через браузер
 * (`smithery auth login`), публикация одной командой. Из Actions браузера
 * нет; по исходнику smithery@1.2.0 CLI читает `SMITHERY_API_KEY` из
 * окружения раньше логина — этого достаточно, ключ владелец создаёт с
 * телефона. Smithery НЕ подтягивает записи из официального реестра MCP сам:
 * это отдельный каталог, и «мы в реестре» не значит «мы в Smithery».
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * Не «workflow есть», а связка: имя и адрес — из маркера, адрес — наш
 * канонический; секрет проверяется ДО публикации с именем; сборка ждётся;
 * поиск переспрашивает и краснеет, если не увидел; ключ нигде не лежит
 * значением.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_BASE_URL } from '@/lib/config';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const WF = read('.github/workflows/smithery-publish.yml');
const CODE = WF.replace(/^[ \t]*#.*$/gm, '');
const MARKER = JSON.parse(read('.github/triggers/smithery-publish.json')) as {
  run: number; name: string; url: string;
};

describe('маркер Smithery', () => {
  it('имя — org/name, адрес — наш живой MCP', () => {
    expect(MARKER.name).toMatch(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/i);
    expect(MARKER.url).toBe(`${CANONICAL_BASE_URL}/api/mcp`);
    expect(typeof MARKER.run).toBe('number');
  });
});

describe('workflow публикации в Smithery', () => {
  it('запускается маркером, только из main, и ждёт свою сборку', () => {
    expect(CODE).toMatch(/\.github\/triggers\/smithery-publish\.json/);
    expect(CODE).toMatch(/branches: \[main\]/);
    expect(CODE).not.toMatch(/claude\/\*\*/);
    // Smithery сканирует инструменты с живого адреса — скан старого прода
    // описал бы вчерашний набор (marker-waits-for-deploy).
    expect(CODE).toMatch(/run: bash scripts\/wait-for-deploy\.sh/);
  });

  it('секрет проверяется до публикации и назван по имени', () => {
    const check = CODE.indexOf('secrets.SMITHERY_API_KEY }}" ]; then');
    const publish = CODE.indexOf('smithery mcp publish');
    expect(check).toBeGreaterThan(0);
    expect(publish).toBeGreaterThan(check);
    expect(CODE).toMatch(/::error::секрет SMITHERY_API_KEY не задан/);
    expect(CODE).toMatch(/smithery\.ai\/account\/api-keys/);
  });

  it('пространство имён спрашивается у Smithery, а не угадывается', () => {
    /**
     * Run 1 (17.09): «404 Namespace not found» — `tourhabk-ui` из маркера
     * оказался не пространством владельца. Ключ принят, отказ на имени.
     * Теперь список пространств берётся у Smithery; org из маркера — если
     * ключ им владеет; единственное чужое — с предупреждением; ни одного —
     * создаётся; несколько без совпадения — красный со списком.
     */
    expect(CODE).toMatch(/smithery namespace list --json/);
    expect(CODE).toMatch(/smithery namespace create "\$ORG"/);
    expect(CODE).toMatch(/::warning::пространство из маркера/);
    expect(CODE).toMatch(/::error::у ключа несколько пространств/);
    expect(CODE).toMatch(/echo "name=\$USE\/\$SRV" >> "\$GITHUB_OUTPUT"/);
  });

  it('публикует адрес из маркера под разрешённым именем, ключ — из окружения', () => {
    expect(CODE).toMatch(/smithery mcp publish "\$\{\{ steps\.cfg\.outputs\.url \}\}" -n "\$\{\{ steps\.ns\.outputs\.name \}\}"/);
    expect(CODE).toMatch(/SMITHERY_API_KEY: \$\{\{ secrets\.SMITHERY_API_KEY \}\}/);
  });

  it('после публикации переспрашивает поиск и краснеет, если не увидел', () => {
    expect(CODE).toMatch(/smithery mcp search/);
    expect(CODE).toMatch(/for attempt in 1 2 3 4 5 6 7 8; do[\s\S]*?sleep 15[\s\S]*?done/);
    expect(CODE).toMatch(/::error::Smithery не показал/);
    expect(CODE).toMatch(/exit 1/);
  });

  it('ключ нигде не лежит значением', () => {
    // Ключи Smithery — длинные строки латиницы/цифр; рядом с именем секрета
    // не должно стоять ничего похожего на значение.
    for (const f of ['.github/workflows/smithery-publish.yml', '.github/triggers/smithery-publish.json']) {
      const src = read(f);
      for (const m of src.match(/SMITHERY_API_KEY[^\n]*/g) ?? []) {
        expect(m, `${f}: рядом с именем секрета значение`).not.toMatch(/[A-Za-z0-9_-]{32,}/);
      }
    }
  });
});
