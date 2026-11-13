/**
 * scripts/sister-repos-census.ts — сверить соседние репозитории с этим.
 *
 *   npx tsx scripts/sister-repos-census.ts --list         # имена репозиториев, по одному в строке
 *   npx tsx scripts/sister-repos-census.ts --dir <папка>  # сверка: в папке лежат их копии
 *
 * В папке каждый репозиторий лежит под своим именем без владельца
 * (`<папка>/vedar-mcp`). Копии снимает тот, кто зовёт скрипт: на раннере —
 * `git clone --depth 1` в `.github/workflows/sister-repos-census.yml`.
 *
 * Код выхода: 0 — совпадают; 1 — хоть один отстал; 2 — отставших нет, но
 * что-то не прочиталось. Третий исход не равен первому (§4.0).
 *
 * Правило сверки — `lib/mcp/sister-repos.ts`, здесь только чтение файлов.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '../lib/mcp/public-tools';
import {
  SISTER_REPOS, checkSister, censusOutcome, censusTable, censusVerdict,
  type FileReader, type SisterFinding, type SourceFacts,
} from '../lib/mcp/sister-repos';

const ROOT = join(__dirname, '..');

function reader(base: string): FileReader {
  return (path) => {
    try {
      return readFileSync(join(base, path), 'utf-8');
    } catch {
      // Файла нет или он не читается — исход «не прочитан», его называет правило.
      return null;
    }
  };
}

function ownFacts(): SourceFacts {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf-8')) as { version: string; description: string };
  return {
    toolNames: PUBLIC_MCP_TOOLS.map((t) => t.name),
    requestCount: WRITE_TOOL_NAMES.size,
    manifest: { version: manifest.version, description: manifest.description },
  };
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const s of SISTER_REPOS) process.stdout.write(`${s.repo}\n`);
    return 0;
  }
  const at = args.indexOf('--dir');
  const dir = at >= 0 ? args[at + 1] : undefined;
  if (!dir) {
    process.stderr.write('Нужна папка с копиями: --dir <папка> (или --list — имена репозиториев).\n');
    return 2;
  }
  const facts = ownFacts();
  const readOwn = reader(ROOT);
  const findings: SisterFinding[] = [];
  for (const sister of SISTER_REPOS) {
    const base = join(dir, sister.repo.split('/')[1]);
    findings.push(...checkSister(sister, facts, existsSync(join(base, '.git')), reader(base), readOwn));
  }
  const outcome = censusOutcome(findings);
  process.stdout.write(`## Соседние репозитории: ${censusVerdict(findings)}\n\n`);
  process.stdout.write(`У сервера здесь ${facts.toolNames.length} инструментов, видов заявок ${facts.requestCount}, версия манифеста ${facts.manifest.version}.\n\n`);
  process.stdout.write(`${censusTable(findings)}\n`);
  return outcome === 'ok' ? 0 : outcome === 'behind' ? 1 : 2;
}

process.exit(main());
