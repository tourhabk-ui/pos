// Карта кабинета в чате и CRM: node scripts/code-map/run.mjs
// Берёт файлы по scripts/code-map/chat-cabinet.paths из git, сканирует импорты, вызовы /api
// и таблицы (названия сверяются с CREATE TABLE в миграциях) и пишет одну страницу
// docs/maps/chat-cabinet-map.html. Только чтение кода; сеть не нужна.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../..');
const OUT_HTML = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'docs/maps/chat-cabinet-map.html');

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const patterns = fs.readFileSync(path.join(HERE, 'chat-cabinet.paths'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const files = git(['ls-files', '--', ...patterns]).split('\n').filter((p) => p && !/\.(test|spec)\./.test(p));
if (!files.length) throw new Error('Ни одного файла по chat-cabinet.paths — карта не собрана.');

let created = '';
try { created = git(['grep', '-hoiE', 'CREATE TABLE (IF NOT EXISTS )?[a-z_0-9.]+', '--', 'migrations', '*.sql']); }
catch (e) { throw new Error(`Не прочитал CREATE TABLE из миграций: ${e.message}`); }
const tables = [...new Set(created.split('\n').map((l) => l.trim().split(/\s+/).pop()?.toLowerCase().replace(/^public\./, '')).filter(Boolean))];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'code-map-'));
fs.writeFileSync(path.join(work, 'files.txt'), files.join('\n'));
fs.writeFileSync(path.join(work, 'tables.txt'), tables.join('\n'));
const sha = git(['rev-parse', '--short', 'HEAD']).trim();
const env = { ...process.env, MAP_OUT_DIR: work, MAP_SHA: sha, MAP_HTML: OUT_HTML };

execFileSync(process.execPath, [path.join(HERE, 'scan.mjs'), ROOT, path.join(work, 'files.txt')], { env, stdio: 'inherit' });
fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
execFileSync(process.execPath, [path.join(HERE, 'build.mjs')], { env, stdio: 'inherit' });
fs.rmSync(work, { recursive: true, force: true });
process.stdout.write(`Карта: ${path.relative(ROOT, OUT_HTML)} (main ${sha}, файлов ${files.length})\n`);
