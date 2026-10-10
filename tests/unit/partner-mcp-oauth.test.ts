/**
 * Сторож OAuth MCP партнёра — вход кнопкой «Подключить» в приложении Claude
 * (CRM #2325, 1д-2; требования Claude — документация Anthropic
 * «Authentication for connectors», сверено 10.10).
 *
 * Держит связку целиком, а не половину:
 *  - обнаружение: 401 роута MCP указывает на метаданные ресурса, `resource`
 *    побуквенно равен адресу, который партнёр вводит в Claude, а сервер
 *    авторизации объявляет ОБА условия CIMD — без любого из них Claude ищет
 *    регистрацию клиентов, которой нет, и вход не начинается;
 *  - доверие: client_id — только с claude.ai, код уходит только туда, где его
 *    заберёт сам Claude (claude.ai/api/mcp/auth_callback или loopback Claude
 *    Code); чужой адрес возврата — ошибка на нашем экране, без
 *    перенаправления;
 *  - код одноразовый (DELETE ... RETURNING), привязан к клиенту, адресу
 *    возврата и PKCE S256; негодный — `invalid_grant`, отказ базы — не он;
 *  - токены: в базе только хеши; обновление с ротацией одним UPDATE и только
 *    для неотозванного, неистёкшего подключения того же клиента; истёкший
 *    доступ не пускает;
 *  - условия владельца: право записи — только если клиент просил И партнёр
 *    отметил; по умолчанию — чтение;
 *  - вход возвращает на экран согласия, и только на него.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const query = vi.fn();
const requirePartner = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/crm/partner-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/partner-context')>()),
  requirePartner: (...a: unknown[]) => requirePartner(...a),
}));

const pub = await import('@/lib/crm/partner-oauth-public');
const meta = await import('@/lib/crm/partner-oauth-metadata');
const reqmod = await import('@/lib/crm/partner-oauth-request');
const oauth = await import('@/lib/crm/partner-oauth');
const keys = await import('@/lib/crm/agent-keys');
const { CANONICAL_BASE_URL } = await import('@/lib/config');
const partnerRoute = await import('@/app/api/mcp/partner/route');
const decisionRoute = await import('@/app/api/mcp/partner/oauth/authorize/route');
const tokenRoute = await import('@/app/api/mcp/partner/oauth/token/route');
const prmRoute = await import('@/app/.well-known/oauth-protected-resource/api/mcp/partner/route');
const asRoute = await import('@/app/.well-known/oauth-authorization-server/route');

const read = (p: string) => readFileSync(p, 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const P = 'aaaaaaaa-0000-4000-8000-000000000001';
const U = 'bbbbbbbb-0000-4000-8000-000000000001';
const APP = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CODE_CLIENT = pub.CLAUDE_CODE_CLIENT_ID;
// RFC 7636, приложение B: эталонная пара verifier/challenge.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function authorizeParams(over: Record<string, string | null> = {}) {
  return {
    response_type: 'code',
    client_id: APP,
    redirect_uri: pub.CLAUDE_APP_CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'crm.read crm.write',
    resource: pub.PARTNER_MCP_RESOURCE,
    ...over,
  };
}

beforeEach(() => {
  query.mockReset();
  requirePartner.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('обнаружение: Claude находит сервер авторизации', () => {
  it('издатель — канон сайта; resource — ровно адрес, который партнёр вводит в Claude', () => {
    expect(pub.OAUTH_ISSUER).toBe(CANONICAL_BASE_URL);
    expect(pub.PARTNER_MCP_RESOURCE).toBe('https://vedarai.ru/api/mcp/partner');
    const prm = meta.protectedResourceMetadata();
    expect(prm.resource).toBe(pub.PARTNER_MCP_RESOURCE);
    // Claude берёт только первый сервер из списка.
    expect(prm.authorization_servers[0]).toBe(pub.OAUTH_ISSUER);
  });

  it('сервер авторизации объявляет оба условия CIMD, PKCE S256 и не обещает регистрацию клиентов', () => {
    const as = meta.authorizationServerMetadata() as Record<string, unknown>;
    expect(as.issuer).toBe(pub.OAUTH_ISSUER);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toContain('none');
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.response_types_supported).toEqual(['code']);
    expect(as.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(as.authorization_endpoint).toBe(`${pub.OAUTH_ISSUER}${pub.PARTNER_OAUTH_AUTHORIZE_PATH}`);
    expect(as.token_endpoint).toBe(`${pub.OAUTH_ISSUER}${pub.PARTNER_OAUTH_TOKEN_PATH}`);
    expect(as).not.toHaveProperty('registration_endpoint');
  });

  it('документы отдаются по тем адресам, что объявлены; файлы роутов стоят на этих путях', async () => {
    expect(existsSync(`app${pub.PARTNER_OAUTH_PRM_PATH}/route.ts`)).toBe(true);
    expect(existsSync(`app${pub.PARTNER_OAUTH_AS_PATH}/route.ts`)).toBe(true);
    expect(existsSync(`app${pub.PARTNER_OAUTH_AUTHORIZE_PATH}/page.tsx`)).toBe(true);
    expect(existsSync(`app${pub.PARTNER_OAUTH_TOKEN_PATH}/route.ts`)).toBe(true);
    expect(existsSync(`app${pub.PARTNER_OAUTH_DECISION_API}/route.ts`)).toBe(true);
    expect(await prmRoute.GET().json()).toEqual(meta.protectedResourceMetadata());
    expect(await asRoute.GET().json()).toEqual(meta.authorizationServerMetadata());
  });

  it('401 роута MCP несёт resource_metadata; присланный негодный токен — ещё и invalid_token', async () => {
    query.mockResolvedValue({ rows: [] });
    const call = (auth: string | null) => partnerRoute.POST(new NextRequest('http://localhost/api/mcp/partner', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    }));
    const bare = await call(null);
    expect(bare.status).toBe(401);
    const h = bare.headers.get('www-authenticate') ?? '';
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(`resource_metadata="${pub.OAUTH_ISSUER}${pub.PARTNER_OAUTH_PRM_PATH}"`);
    expect(h).not.toContain('invalid_token');
    const stale = await call(`Bearer ${keys.generateAgentKey(() => Buffer.alloc(32, 1))}`);
    expect(stale.status).toBe(401);
    expect(stale.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

describe('доверие: кто клиент и куда уходит код', () => {
  it('client_id — только https на claude.ai и с путём', () => {
    expect(pub.trustedOAuthClient(APP)?.name).toBe('Claude');
    expect(pub.trustedOAuthClient(CODE_CLIENT)?.name).toBe('Claude Code');
    for (const bad of [
      'http://claude.ai/oauth/x', 'https://claude.ai.evil.com/oauth/x', 'https://evil.com/claude.ai/x',
      'https://claude.ai/', 'https://user@claude.ai/oauth/x', 'https://claude.ai/oauth/x#frag', 'claude', '', null,
    ]) {
      expect(pub.trustedOAuthClient(bad), String(bad)).toBeNull();
    }
  });

  it('приложение Claude — только на свой обратный адрес; Claude Code — только loopback /callback на любом порту', () => {
    expect(pub.resolvePartnerOAuthClient(APP, pub.CLAUDE_APP_CALLBACK)?.destination).toBe('claude.ai');
    for (const ok of ['http://localhost:3118/callback', 'http://127.0.0.1:55001/callback', 'http://[::1]:4000/callback', 'http://localhost/callback']) {
      expect(pub.resolvePartnerOAuthClient(CODE_CLIENT, ok), ok).not.toBeNull();
    }
    for (const [client, uri] of [
      [APP, 'https://evil.com/api/mcp/auth_callback'],
      [APP, 'http://localhost:3118/callback'],
      [APP, 'https://claude.ai/api/mcp/auth_callback?x=1'],
      [CODE_CLIENT, pub.CLAUDE_APP_CALLBACK],
      [CODE_CLIENT, 'http://localhost.evil.com/callback'],
      [CODE_CLIENT, 'https://localhost/callback'],
      [CODE_CLIENT, 'http://localhost:3118/other'],
      [CODE_CLIENT, 'http://user@localhost:3118/callback'],
      ['https://evil.com/doc', pub.CLAUDE_APP_CALLBACK],
    ] as const) {
      expect(pub.resolvePartnerOAuthClient(client, uri), `${client} → ${uri}`).toBeNull();
    }
  });

  it('непроверенный клиент или адрес — ошибка на нашем экране, без перенаправления', () => {
    for (const over of [{ client_id: 'https://evil.com/doc' }, { redirect_uri: 'https://evil.com/cb' }, { redirect_uri: null }]) {
      expect(reqmod.checkAuthorizeRequest(authorizeParams(over)).kind).toBe('fatal');
    }
  });

  it('неверный запрос при проверенном адресе — ошибка уходит клиенту, с его state и нашим iss', () => {
    for (const [over, code] of [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: null }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ resource: 'https://vedarai.ru/api/mcp' }, 'invalid_target'],
      [{ scope: 'crm.read admin' }, 'invalid_scope'],
    ] as const) {
      const r = reqmod.checkAuthorizeRequest(authorizeParams(over));
      expect(r.kind, JSON.stringify(over)).toBe('error');
      if (r.kind !== 'error') continue;
      const u = new URL(r.redirect);
      expect(`${u.origin}${u.pathname}`).toBe(pub.CLAUDE_APP_CALLBACK);
      expect(u.searchParams.get('error')).toBe(code);
      expect(u.searchParams.get('state')).toBe('st-1');
      expect(u.searchParams.get('iss')).toBe(pub.OAUTH_ISSUER);
    }
  });

  it('годный запрос: право записи — то, что клиент просил; без scope — только чтение', () => {
    const r = reqmod.checkAuthorizeRequest(authorizeParams());
    expect(r.kind === 'ok' && r.request.wantsWrite).toBe(true);
    const ro = reqmod.checkAuthorizeRequest(authorizeParams({ scope: null }));
    expect(ro.kind === 'ok' && ro.request.wantsWrite).toBe(false);
  });
});

describe('решение партнёра: «Разрешить»', () => {
  const okCtx = { outcome: 'ok', partnerId: P, category: 'operator', userId: U };
  const post = (body: unknown, headers: Record<string, string> = {}) => decisionRoute.POST(new NextRequest('http://localhost/api/mcp/partner/oauth/authorize', {
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));

  it('с чужого сайта, без Origin и не JSON — отказ до входа и до базы', async () => {
    expect((await post(authorizeParams(), { origin: 'https://evil.com' })).status).toBe(403);
    const noOrigin = new NextRequest('http://localhost/api/mcp/partner/oauth/authorize', {
      method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(authorizeParams()),
    });
    expect((await decisionRoute.POST(noOrigin)).status).toBe(403);
    expect((await post(authorizeParams(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect(requirePartner).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('за прокси с внутренним host канон сайта проходит, двойник домена — нет', async () => {
    requirePartner.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));
    // Прошёл проверку Origin — дошёл до входа (401 гарда), а не 403.
    expect((await post(authorizeParams(), { host: '127.0.0.1:3000', origin: 'https://vedarai.ru' })).status).toBe(401);
    expect((await post(authorizeParams(), { host: '127.0.0.1:3000', origin: 'https://vedarai.ru.evil.com' })).status).toBe(403);
    expect((await post(authorizeParams(), { host: 'localhost', origin: 'http://localhost.evil.com' })).status).toBe(403);
  });

  it('без входа партнёра — ответ гарда, кода нет', async () => {
    requirePartner.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));
    expect((await post(authorizeParams())).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('по умолчанию — только чтение; запись — если клиент просил И партнёр отметил', async () => {
    requirePartner.mockResolvedValue(okCtx);
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const canWriteOf = () => {
      const insert = query.mock.calls.find((c) => /INSERT INTO partner_oauth_codes/.test(String(c[0])));
      return (insert?.[1] as unknown[])[6];
    };

    await post(authorizeParams());
    expect(canWriteOf()).toBe(false);
    query.mockClear();
    await post({ ...authorizeParams({ scope: 'crm.read' }), can_write: true });
    expect(canWriteOf()).toBe(false);
    query.mockClear();
    const res = await post({ ...authorizeParams(), can_write: true });
    expect(canWriteOf()).toBe(true);

    const json = await res.json() as { data: { redirect: string } };
    const u = new URL(json.data.redirect);
    expect(`${u.origin}${u.pathname}`).toBe(pub.CLAUDE_APP_CALLBACK);
    expect(u.searchParams.get('code')).toMatch(/^vdr_ac_[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')).toBe('st-1');
    expect(u.searchParams.get('iss')).toBe(pub.OAUTH_ISSUER);
    // В базу ушёл хеш кода, а не код.
    const insert = query.mock.calls.find((c) => /INSERT INTO partner_oauth_codes/.test(String(c[0])));
    const params = insert?.[1] as unknown[];
    expect(params).not.toContain(u.searchParams.get('code'));
    expect(params[0]).toBe(sha(u.searchParams.get('code') ?? ''));
    expect(params[1]).toBe(P);
  });

  it('подделанный запрос в теле — тот же суд, что у экрана: чужой адрес возврата не получает кода', async () => {
    requirePartner.mockResolvedValue(okCtx);
    const res = await post(authorizeParams({ redirect_uri: 'https://evil.com/cb' }));
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('код и токены', () => {
  const codeRow = (over: Record<string, unknown> = {}) => ({
    partner_id: P, user_id: U, client_id: APP, redirect_uri: pub.CLAUDE_APP_CALLBACK,
    code_challenge: CHALLENGE, can_write: false, expired: false, ...over,
  });
  const CODE = `vdr_ac_${Buffer.alloc(32, 3).toString('base64url')}`;
  const exchange = (over: Partial<Parameters<typeof oauth.exchangeAuthorizationCode>[0]> = {}) =>
    oauth.exchangeAuthorizationCode({ code: CODE, clientId: APP, redirectUri: pub.CLAUDE_APP_CALLBACK, codeVerifier: VERIFIER, ...over });

  it('PKCE S256 — эталон RFC 7636; чужой verifier и plain не проходят', () => {
    expect(oauth.verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
    expect(oauth.verifyPkce(`${VERIFIER.slice(0, -1)}A`, CHALLENGE)).toBe(false);
    expect(oauth.verifyPkce(CHALLENGE, CHALLENGE)).toBe(false);
    expect(oauth.verifyPkce(null, CHALLENGE)).toBe(false);
  });

  it('код расходуется одним DELETE ... RETURNING по хешу; второй раз — invalid_grant', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await exchange()).toEqual({ outcome: 'invalid_grant', reason: expect.any(String) });
    expect(query.mock.calls[0][0]).toMatch(/DELETE FROM partner_oauth_codes WHERE code_hash = \$1\s+RETURNING/);
    expect(query.mock.calls[0][1]).toEqual([sha(CODE)]);
    // Код неправильной формы до базы не доходит.
    query.mockClear();
    expect((await exchange({ code: 'nope' })).outcome).toBe('invalid_grant');
    expect(query).not.toHaveBeenCalled();
  });

  it('просроченный, чужой клиент, чужой адрес возврата, неверный verifier — invalid_grant, токенов нет', async () => {
    for (const [row, over] of [
      [codeRow({ expired: true }), {}],
      [codeRow(), { clientId: CODE_CLIENT }],
      [codeRow(), { redirectUri: 'http://localhost:1/callback' }],
      [codeRow(), { codeVerifier: 'x'.repeat(43) }],
    ] as const) {
      query.mockReset();
      query.mockResolvedValueOnce({ rows: [row] });
      expect((await exchange(over)).outcome, JSON.stringify(over)).toBe('invalid_grant');
      expect(query.mock.calls.some((c) => /INSERT INTO partner_api_keys/.test(String(c[0])))).toBe(false);
    }
  });

  it('годный код — токены; в базу уходят хеши, сроки и client_id; старые подключения сверх предела вытесняются', async () => {
    query.mockResolvedValueOnce({ rows: [codeRow({ can_write: true })] }).mockResolvedValue({ rows: [], rowCount: 1 });
    const r = await exchange();
    expect(r.outcome).toBe('ok');
    if (r.outcome !== 'ok') return;
    expect(r.tokens.access_token).toMatch(/^vdr_pk_[A-Za-z0-9_-]{43}$/);
    expect(r.tokens.refresh_token).toMatch(/^vdr_rt_[A-Za-z0-9_-]{43}$/);
    expect(r.tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'crm.read crm.write' });
    const insert = query.mock.calls.find((c) => /INSERT INTO partner_api_keys/.test(String(c[0])));
    const params = insert?.[1] as unknown[];
    expect(params).not.toContain(r.tokens.access_token);
    expect(params).not.toContain(r.tokens.refresh_token);
    expect(params).toContain(sha(r.tokens.access_token));
    expect(params).toContain(sha(r.tokens.refresh_token));
    expect(params).toContain(APP);
    const prune = query.mock.calls.find((c) => /UPDATE partner_api_keys SET revoked_at = NOW\(\)/.test(String(c[0])));
    expect(prune?.[0]).toMatch(/oauth_client_id IS NOT NULL AND revoked_at IS NULL/);
    expect(prune?.[1]).toEqual([P, oauth.MAX_OAUTH_CONNECTIONS]);
  });

  it('база не ответила при обмене — unavailable, а не invalid_grant', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '08006' }));
    expect((await exchange()).outcome).toBe('unavailable');
  });

  it('обновление: один UPDATE с ротацией — только неотозванное, неистёкшее, того же клиента; хеши вместо токенов', async () => {
    const RT = `vdr_rt_${Buffer.alloc(32, 9).toString('base64url')}`;
    query.mockResolvedValueOnce({ rows: [] });
    expect((await oauth.refreshAccessToken({ refreshToken: RT, clientId: APP })).outcome).toBe('invalid_grant');
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/WHERE refresh_hash = \$1 AND oauth_client_id = \$5/);
    expect(sql).toMatch(/revoked_at IS NULL AND refresh_expires_at > NOW\(\)/);
    expect(sql).toMatch(/SET key_hash = \$2, key_prefix = \$3, refresh_hash = \$4/);
    expect((query.mock.calls[0][1] as unknown[])[0]).toBe(sha(RT));

    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ can_write: false }] });
    const ok = await oauth.refreshAccessToken({ refreshToken: RT, clientId: APP });
    expect(ok.outcome).toBe('ok');
    if (ok.outcome !== 'ok') return;
    expect(ok.tokens.refresh_token).not.toBe(RT);
    expect(ok.tokens.scope).toBe('crm.read');
    const params = query.mock.calls[0][1] as unknown[];
    expect(params).not.toContain(ok.tokens.access_token);
    expect(params).not.toContain(ok.tokens.refresh_token);
    expect(params).toContain(sha(ok.tokens.refresh_token));
  });

  it('истёкший доступ OAuth не пускает: проверка ключа сверяет срок', () => {
    expect(read('lib/crm/agent-keys.ts')).toMatch(/AND \(k\.access_expires_at IS NULL OR k\.access_expires_at > NOW\(\)\)/);
  });
});

describe('токен-эндпоинт', () => {
  const form = (body: string, type = 'application/x-www-form-urlencoded') => tokenRoute.POST(new NextRequest('http://localhost/api/mcp/partner/oauth/token', {
    method: 'POST', headers: { 'content-type': type }, body,
  }));

  it('форма, как шлёт Claude; ответ не кэшируется; негодный код — invalid_grant', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await form(new URLSearchParams({
      grant_type: 'authorization_code', code: `vdr_ac_${'A'.repeat(43)}`, redirect_uri: pub.CLAUDE_APP_CALLBACK,
      client_id: APP, code_verifier: VERIFIER, resource: pub.PARTNER_MCP_RESOURCE,
    }).toString());
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('чужой грант, повтор параметра, чужой ресурс — по кодам RFC; отказ базы — 503, не invalid_grant', async () => {
    expect(await (await form('grant_type=client_credentials')).json()).toMatchObject({ error: 'unsupported_grant_type' });
    expect(await (await form('grant_type=refresh_token&refresh_token=a&refresh_token=b&client_id=x')).json()).toMatchObject({ error: 'invalid_request' });
    expect(await (await form(new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: `vdr_rt_${'A'.repeat(43)}`, client_id: APP, resource: 'https://vedarai.ru/api/mcp',
    }).toString())).json()).toMatchObject({ error: 'invalid_target' });

    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '08006' }));
    const down = await form(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: `vdr_rt_${'A'.repeat(43)}`, client_id: APP }).toString());
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: 'temporarily_unavailable' });
  });
});

describe('экран согласия и возврат после входа', () => {
  it('вход возвращает только на экран согласия этого сайта', () => {
    const ok = `${pub.PARTNER_OAUTH_AUTHORIZE_PATH}?client_id=x&state=1`;
    expect(pub.safePartnerOAuthReturn(ok)).toBe(ok);
    for (const bad of [
      '//evil.com/oauth/partner/authorize?x', 'https://evil.com/oauth/partner/authorize?x', '/hub/operator',
      '/oauth/partner/authorizeX?x', '/oauth/partner/authorize/../../hub?x', '/\\evil.com', `${pub.PARTNER_OAUTH_AUTHORIZE_PATH}?a=\n`,
      pub.PARTNER_OAUTH_AUTHORIZE_PATH, null, '',
    ]) {
      expect(pub.safePartnerOAuthReturn(bad), String(bad)).toBeNull();
    }
  });

  it('каждый путь входа уважает возврат, и только через safePartnerOAuthReturn', () => {
    const src = read('app/auth/login/_AuthPageClient.tsx');
    expect(src).toMatch(/setReturnTo\(safePartnerOAuthReturn\(search\.get\('next'\)\)\)/);
    // Пароль, MFA, Telegram, MAX.
    expect(src.match(/router\.push\(returnTo \?\? /g)?.length).toBe(4);
  });

  it('экран — вне /hub, вход проверяется с живой сессией, отказ — ссылкой, запись по умолчанию выключена, адрес кода показан', () => {
    expect(pub.PARTNER_OAUTH_AUTHORIZE_PATH.startsWith('/hub')).toBe(false);
    const page = read(`app${pub.PARTNER_OAUTH_AUTHORIZE_PATH}/page.tsx`);
    // getUserFromRequest сверяет сессию с user_sessions; голый verifyToken пустил бы после выхода.
    expect(page).toMatch(/getUserFromRequest\(/);
    expect(page).not.toMatch(/verifyToken\(/);
    expect(page).toMatch(/checkAuthorizeRequest\(/);
    const client = read(`app${pub.PARTNER_OAUTH_AUTHORIZE_PATH}/_ConsentClient.tsx`);
    expect(client).toMatch(/const \[canWrite, setCanWrite\] = useState\(false\)/);
    expect(client).toMatch(/props\.destination/);
    expect(client).toMatch(/href=\{props\.denyHref\}|<Deny href=\{props\.denyHref\}/);
  });

  it('middleware.ts этим не тронут: /api/mcp пропускается целиком, /oauth — вне matcher', () => {
    const mw = read('middleware.ts');
    expect(mw).toMatch(/if \(pathname\.startsWith\('\/api\/mcp'\)\)/);
    expect(mw).not.toMatch(/'\/oauth/);
  });
});
