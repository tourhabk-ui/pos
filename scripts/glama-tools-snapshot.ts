/**
 * Снимок определений MCP для сборки на Glama (integrations/glama/server).
 *
 * Glama собирает сервер из репозитория и не даёт проксировать запросы на
 * vedarai.ru (её проверка формы, 20.11). Всё приложение Ведара с базой в
 * образ не собрать, поэтому образ запускает маленький сервер без
 * зависимостей, а определения инструментов берёт из этого снимка.
 *
 * Снимок — это ровно то, что отдаёт `tools/list` живого сервера
 * (PUBLIC_MCP_TOOLS), его serverInfo и версии рукопожатия. Поменялись
 * определения — запустить заново:
 *
 *   npx tsx scripts/glama-tools-snapshot.ts
 *
 * Расхождение снимка с кодом ловит tests/unit/glama-local-server.test.ts.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGlamaSnapshot } from '../lib/mcp/glama-snapshot';

const out = join(process.cwd(), 'integrations/glama/server/tools.json');
writeFileSync(out, `${JSON.stringify(buildGlamaSnapshot(), null, 2)}\n`);
process.stdout.write(`снимок записан: ${out}\n`);
