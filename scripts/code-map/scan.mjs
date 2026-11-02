// Сканер карты кода (scripts/code-map): импорты, вызовы /api, таблицы SQL, докстроки.
// Только чтение репозитория. Пишет data.json в MAP_OUT_DIR. Запуск — run.mjs.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
const LIST = process.argv[3];
const OUT = path.join(process.env.MAP_OUT_DIR || path.dirname(new URL(import.meta.url).pathname), 'data.json');

const subset = fs.readFileSync(LIST, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((p) => /\.(ts|tsx|js|mjs)$/.test(p));
const inSubset = new Set(subset);

const EXT = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
function resolveSpec(fromFile, spec) {
  let base;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  else return null; // пакет
  for (const e of EXT) {
    const p = base + e;
    try { if (fs.statSync(path.join(ROOT, p)).isFile()) return p; } catch { /* нет такого */ }
  }
  return null;
}

const IMPORT_RE = [
  /(?:^|[\s;])(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|[\s;])import\s+['"]([^'"]+)['"]/g,
];
function importsOf(file, src) {
  const out = new Set();
  for (const re of IMPORT_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const r = resolveSpec(file, m[1]);
      if (r && r !== file) out.add(r);
    }
  }
  return [...out];
}

function docOf(src) {
  const s = src.replace(/^\s*(['"]use (client|server)['"];?\s*)/, '');
  const m = /^\s*\/\*\*([\s\S]*?)\*\//.exec(s);
  let text = '';
  if (m) text = m[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join(' ');
  else {
    const lines = [];
    for (const l of s.split('\n')) {
      if (/^\s*\/\//.test(l)) lines.push(l.replace(/^\s*\/\/\s?/, ''));
      else if (lines.length || l.trim()) break;
    }
    text = lines.join(' ');
  }
  // Докстрока может стоять и после импортов: берём первую /** */ в файле, если сверху пусто.
  if (!text.trim()) {
    const mm = /\n\/\*\*([\s\S]*?)\*\//.exec(s);
    if (mm) text = mm[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join(' ');
  }
  text = text.replace(/\s+/g, ' ').replace(/`/g, '').trim();
  if (!text) return '';
  const cut = text.match(/^(.{20,240}?[.!?])(\s|$)/);
  let one = cut ? cut[1] : text.slice(0, 220);
  if (one.length < text.length && !cut) one += '…';
  return one;
}

const SQL_KW = new Set(['select', 'where', 'and', 'or', 'set', 'values', 'the', 'a', 'to', 'from', 'lateral', 'unnest', 'jsonb_array_elements', 'generate_series', 'only', 'json_to_recordset', 'jsonb_to_recordset', 'json', 'jsonb', 'now', 'cte', 'with']);
function tablesOf(src) {
  const t = new Map();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]{2,})\b/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (SQL_KW.has(name)) continue;
    t.set(name, (t.get(name) || 0) + 1);
  }
  return t;
}

// Роуты Next.js из всего app/api, чтобы сопоставлять fetch('/api/...').
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}
const allFiles = walk('').filter((p) => /\.(ts|tsx|js|mjs)$/.test(p) && !p.startsWith('floorplan/'));
const routeFiles = allFiles.filter((p) => /^app\/api\/.*\/route\.(ts|js)$/.test(p));
const routes = routeFiles.map((f) => {
  const url = '/' + f.replace(/^app\//, '').replace(/\/route\.(ts|js)$/, '');
  const re = new RegExp('^' + url.split('/').map((seg) => (/^\[\.\.\./.test(seg) ? '.+' : /^\[.*\]$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');
  const statics = url.split('/').filter((s) => s && !s.startsWith('[')).length;
  return { file: f, url, re, statics };
});
function routeFor(url) {
  const clean = url.replace(/\$\{[^}]*\}/g, 'X').replace(/\/+$/, '');
  const hits = routes.filter((r) => r.re.test(clean)).sort((a, b) => b.statics - a.statics);
  return hits[0]?.file || null;
}
const FETCH_RE = /['"`](\/api\/[A-Za-z0-9_\-/${}.[\]]+)/g;

// Кто импортирует каждый файл подмножества — по всему репозиторию (тесты отдельно).
const importers = new Map();
for (const f of allFiles) {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
  if (!/import|export/.test(src)) continue;
  for (const t of importsOf(f, src)) {
    if (!inSubset.has(t)) continue;
    if (!importers.has(t)) importers.set(t, { code: new Set(), tests: new Set() });
    const bucket = /^tests\/|\.test\.|\.spec\./.test(f) ? 'tests' : 'code';
    importers.get(t)[bucket].add(f);
  }
}

const files = [];
for (const f of subset) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const imps = importsOf(f, src);
  const http = new Set();
  let m;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src))) { const r = routeFor(m[1]); if (r && r !== f) http.add(r); }
  const tbl = tablesOf(src);
  const imp = importers.get(f) || { code: new Set(), tests: new Set() };
  files.push({
    path: f,
    loc: src.split('\n').length,
    doc: docOf(src),
    imports: imps,
    http: [...http],
    tables: [...tbl.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ n, c })),
    usedByCode: [...imp.code].length,
    usedByTests: [...imp.tests].length,
    usedByOutside: [...imp.code].filter((x) => !inSubset.has(x)).slice(0, 12),
    isEntry: /\/(route|page|layout)\.(ts|tsx)$/.test(f) || /_[A-Za-z]+Client\.tsx$/.test(f),
  });
}

// Компоненты сильной связности (циклы импортов) внутри подмножества.
const idx = new Map(files.map((x, i) => [x.path, i]));
let index = 0; const stack = []; const on = new Set(); const ids = new Map(); const low = new Map(); const sccs = [];
function strong(v) {
  ids.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
  for (const w of files[idx.get(v)].imports.filter((p) => idx.has(p))) {
    if (!ids.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (on.has(w)) low.set(v, Math.min(low.get(v), ids.get(w)));
  }
  if (low.get(v) === ids.get(v)) {
    const comp = []; let w;
    do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1) sccs.push(comp);
  }
}
for (const x of files) if (!ids.has(x.path)) strong(x.path);

fs.writeFileSync(OUT, JSON.stringify({ root: ROOT, generated: new Date().toISOString(), files, cycles: sccs }, null, 0));
const totalLoc = files.reduce((s, x) => s + x.loc, 0);
console.log(`files ${files.length}, loc ${totalLoc}, routes known ${routes.length}, cycles ${sccs.length}`);
console.log('no doc:', files.filter((x) => !x.doc).length);
console.log('http edges:', files.reduce((s, x) => s + x.http.length, 0));
console.log('dead (no code importers, not entry):', files.filter((x) => !x.usedByCode && !x.isEntry).map((x) => x.path).join(', '));
console.log('big >800:', files.filter((x) => x.loc > 800).map((x) => `${x.path}:${x.loc}`).join(', '));
console.log('cycles:', sccs.map((c) => c.length + ':' + c.slice(0, 4).join(' ')).join(' | '));
