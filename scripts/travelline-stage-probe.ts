/**
 * TravelLine Partner API, тестовая среда (Stage): проверка ключей канала и
 * чтение спецификации — с раннера GitHub (29.09).
 *
 * Зачем. Владелец подал ООО «Пос сервис» каналом продаж в TravelLine, получил
 * ключи тестовой среды и положил их в секреты (`TRAVELLINE_CLIENT_ID`,
 * `TRAVELLINE_CLIENT_SECRET`). Из контейнера разработки `partner.qatl.ru`
 * закрыт; раннер ходит свободно. Модуль интеграции пишется по НАСТОЯЩИМ
 * ответам, а не по обрывкам из поиска.
 *
 * Что известно из базы знаний TravelLine (проба 624): токен тестовой среды —
 * `https://partner.qatl.ru/auth/token`; объекты для тестов — 7291, 8155, 8156,
 * 8613–8616; спецификация — Swagger UI на `/docs/booking-process/`.
 *
 * Только чтение. Ключи и токен наружу не выходят: токен маскируется
 * `::add-mask::` до любого вывода, тела ошибок чистятся от значений ключей,
 * печатаются коды ответа, названия полей и публичная спецификация.
 */

export {};

const BASE = 'https://partner.qatl.ru';
const TEST_PROPERTY = '7291';

const id = process.env.TRAVELLINE_CLIENT_ID ?? '';
const secret = process.env.TRAVELLINE_CLIENT_SECRET ?? '';

function scrub(text: string): string {
  let t = text;
  for (const s of [id, secret]) if (s) t = t.split(s).join('***');
  return t;
}

function line(s = ''): void {
  process.stdout.write(`${scrub(s)}\n`);
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: `сеть: ${(e as Error).message}` };
  }
}

interface OpenApi {
  openapi?: string; swagger?: string;
  info?: { title?: string; version?: string };
  servers?: Array<{ url?: string }>;
  host?: string; basePath?: string;
  paths?: Record<string, Record<string, { summary?: string; parameters?: Array<{ name?: string; in?: string; required?: boolean }> }>>;
  components?: { securitySchemes?: Record<string, unknown> };
  securityDefinitions?: Record<string, unknown>;
}

async function readSpecs(): Promise<Array<{ url: string; spec: OpenApi }>> {
  line('── 1. Спецификация (Swagger UI) ──');
  const init = await get(`${BASE}/docs/booking-process/swagger-initializer.js`);
  line(`swagger-initializer.js: HTTP ${init.status}, ${init.text.length} байт`);
  const found = new Set<string>();
  for (const m of init.text.matchAll(/url\s*:\s*["'`]([^"'`]+)["'`]/g)) found.add(m[1]);
  if (found.size === 0) line(init.text.slice(0, 1500));
  const out: Array<{ url: string; spec: OpenApi }> = [];
  for (const raw of found) {
    const url = new URL(raw, `${BASE}/docs/booking-process/`).toString();
    const r = await get(url);
    line(`спецификация ${url}: HTTP ${r.status}, ${r.text.length} байт`);
    try {
      out.push({ url, spec: JSON.parse(r.text) as OpenApi });
    } catch {
      line('  не JSON — начало:');
      line(r.text.slice(0, 1200));
    }
  }
  for (const { url, spec } of out) {
    line();
    line(`## ${url}`);
    line(`${spec.openapi ? `OpenAPI ${spec.openapi}` : `Swagger ${spec.swagger ?? '?'}`} · ${spec.info?.title ?? ''} ${spec.info?.version ?? ''}`);
    line(`servers: ${JSON.stringify(spec.servers ?? (spec.host ? [`${spec.host}${spec.basePath ?? ''}`] : []))}`);
    line(`security: ${JSON.stringify(spec.components?.securitySchemes ?? spec.securityDefinitions ?? {})}`);
    for (const [p, methods] of Object.entries(spec.paths ?? {})) {
      for (const [m, op] of Object.entries(methods)) {
        if (!/^(get|post|put|patch|delete)$/i.test(m)) continue;
        const req = (op.parameters ?? []).filter(x => x.required).map(x => `${x.name}@${x.in}`).join(',');
        line(`${m.toUpperCase().padEnd(6)} ${p}${req ? `  [обяз.: ${req}]` : ''}${op.summary ? ` — ${op.summary}` : ''}`);
      }
    }
  }
  return out;
}

async function getToken(): Promise<string | null> {
  line();
  line('── 2. Токен (client_credentials) ──');
  if (!id || !secret) {
    line('ключей нет в окружении — не проверено');
    return null;
  }
  let status = 0;
  let text = '';
  try {
    const res = await fetch(`${BASE}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
      signal: AbortSignal.timeout(30_000),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    line(`не смог спросить: ${(e as Error).message}`);
    return null;
  }
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* не JSON */ }
  const token = typeof body.access_token === 'string' ? body.access_token : null;
  if (token) process.stdout.write(`::add-mask::${token}\n`);
  line(`HTTP ${status}; поля ответа: ${Object.keys(body).join(', ') || '(не JSON)'}`);
  if (token) {
    line(`token_type: ${String(body.token_type ?? '?')}; expires_in: ${String(body.expires_in ?? '?')}; длина токена: ${token.length}`);
  } else {
    line(`тело (очищено): ${text.slice(0, 600)}`);
  }
  return token;
}

async function readProperty(specs: Array<{ url: string; spec: OpenApi }>, token: string): Promise<void> {
  line();
  line(`── 3. Чтение по тестовому объекту ${TEST_PROPERTY} (только GET) ──`);
  for (const { spec } of specs) {
    const server = spec.servers?.[0]?.url ?? (spec.host ? `https://${spec.host}${spec.basePath ?? ''}` : BASE);
    const base = new URL(server, BASE).toString().replace(/\/$/, '');
    for (const [p, methods] of Object.entries(spec.paths ?? {})) {
      const op = methods.get ?? methods.GET;
      if (!op) continue;
      const pathParams = (p.match(/\{[^}]+\}/g) ?? []);
      const requiredQuery = (op.parameters ?? []).filter(x => x.required && x.in === 'query');
      if (pathParams.length !== 1 || !/propert/i.test(pathParams[0]) || requiredQuery.length) continue;
      const url = `${base}${p.replace(pathParams[0], TEST_PROPERTY)}`;
      const r = await get(url, { Authorization: `Bearer ${token}` });
      let keys = '';
      try { keys = Object.keys(JSON.parse(r.text) as object).join(', '); } catch { /* не JSON */ }
      line(`GET ${url} → HTTP ${r.status}; поля: ${keys || '—'}`);
      line(`  ${r.text.slice(0, 1500).replace(/\s+/g, ' ')}`);
    }
  }
}

/**
 * Прогон 1 показал: swagger-initializer.js на /docs/booking-process/ ссылается
 * на демо Petstore — настоящей спецификации там нет. Ищем её в разметке
 * документации, а пути Partner API проверяем напрямую, только GET.
 */
async function readDocsIndex(): Promise<void> {
  line();
  line('── 1б. Разметка документации (ссылки на спецификации) ──');
  for (const page of ['/docs/', '/docs/booking-process/', '/docs/booking-process/swagger-initializer.js']) {
    const r = await get(`${BASE}${page}`);
    line(`${page}: HTTP ${r.status}, ${r.text.length} байт`);
    const refs = new Set<string>();
    for (const m of r.text.matchAll(/(?:href|src|url)\s*[:=]\s*["'`]([^"'`]+)["'`]/g)) refs.add(m[1]);
    for (const m of r.text.matchAll(/["'`]([^"'`\s]+\.(?:json|ya?ml))["'`]/g)) refs.add(m[1]);
    line(`  ссылки: ${[...refs].slice(0, 60).join(' | ') || '—'}`);
  }
}

function plusDays(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function readKnownPaths(token: string): Promise<void> {
  line();
  line(`── 3б. Пути Partner API (только GET), объект ${TEST_PROPERTY} ──`);
  const arrival = plusDays(30);
  const departure = plusDays(32);
  const paths = [
    '/api/content/v1/properties?count=5',
    `/api/content/v1/properties/${TEST_PROPERTY}`,
    '/api/content/v1/meal-plans',
    '/api/content/v1/room-type-categories',
    `/api/search/v1/properties/${TEST_PROPERTY}/room-stays?adults=2&arrivalDate=${arrival}&departureDate=${departure}`,
    `/api/search/v1/properties/room-stays?propertyIds=${TEST_PROPERTY}&adults=2&arrivalDate=${arrival}&departureDate=${departure}`,
    `/api/search/v1/properties/${TEST_PROPERTY}/services`,
  ];
  for (const p of paths) {
    const r = await get(`${BASE}${p}`, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
    let keys = '';
    try { keys = Object.keys(JSON.parse(r.text) as object).join(', '); } catch { /* не JSON */ }
    line(`GET ${p} → HTTP ${r.status}; поля: ${keys || '—'}`);
    line(`  ${r.text.slice(0, 2500).replace(/\s+/g, ' ')}`);
  }
}

async function main(): Promise<void> {
  const specs = await readSpecs();
  await readDocsIndex();
  const token = await getToken();
  const real = specs.filter(s => !/petstore/i.test(s.url));
  if (token && real.length > 0) await readProperty(real, token);
  if (token) await readKnownPaths(token);
}

main().catch((e) => {
  line(`проба упала: ${(e as Error).message}`);
  process.exitCode = 1;
});
