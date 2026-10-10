/**
 * /oauth/partner/authorize — экран согласия OAuth MCP партнёра.
 *
 * Сюда приложение Claude приводит партнёра, когда тот нажал «Подключить» у
 * коннектора https://vedarai.ru/api/mcp/partner. Экран:
 *  1. проверяет запрос подключения (checkAuthorizeRequest): клиент и адрес
 *     возврата не проверены — ошибка здесь, без перенаправления; запрос
 *     неверен — ошибка уходит клиенту на проверенный адрес;
 *  2. требует входа в кабинет партнёра; после входа страница входа
 *     возвращает сюда же (safePartnerOAuthReturn);
 *  3. спрашивает согласие: кто просит, куда уйдёт код, что агент увидит;
 *     право записи — флажок, по умолчанию выключен.
 *
 * Живёт вне /hub намеренно: Edge-гейт /hub при входе теряет параметры
 * запроса, а без них подключение не довести. middleware.ts не тронут —
 * его matcher этот путь не покрывает, вход проверяется здесь.
 */
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { partnerContextFor } from '@/lib/crm/partner-context';
import { partnerDisplayName, switchablePartnerRoles } from '@/lib/crm/partner-oauth';
import { ROLE_LABELS } from '@/lib/auth/role-switch';
import { PARTNER_OAUTH_AUTHORIZE_PATH } from '@/lib/crm/partner-oauth-public';
import {
  AUTHORIZE_PARAM_NAMES,
  checkAuthorizeRequest,
  denyRedirect,
  type AuthorizeParams,
} from '@/lib/crm/partner-oauth-request';
import { ConsentClient, type CommonProps } from './_ConsentClient';

export const metadata: Metadata = {
  title: 'Подключение агента к CRM',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/** Параметры запроса. Повтор параметра — ошибка (RFC 6749 §3.1), а не «взять первый». */
function readParams(sp: SearchParams): AuthorizeParams | null {
  const out: AuthorizeParams = {};
  for (const name of AUTHORIZE_PARAM_NAMES) {
    const v = sp[name];
    if (Array.isArray(v)) return null;
    out[name] = v ?? null;
  }
  return out;
}

function noneMessage(reason: 'role' | 'profile' | 'not_approved', roleLabel: string): string {
  if (reason === 'role') return `Сейчас вы вошли в роли «${roleLabel}» — у неё нет CRM партнёра.`;
  if (reason === 'profile') return `В роли «${roleLabel}» профиль партнёра ещё не заполнен — CRM появится после заполнения.`;
  return 'Кабинет агента ещё не одобрен администратором — CRM откроется после одобрения.';
}

export default async function PartnerOAuthAuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = readParams(await searchParams);
  const check = params
    ? checkAuthorizeRequest(params)
    : { kind: 'fatal' as const, message: 'В ссылке подключения повторяется параметр. Начните подключение заново в Claude.' };

  if (check.kind === 'fatal') return <ConsentClient mode="fatal" message={check.message} />;
  if (check.kind === 'error') redirect(check.redirect);

  const request = check.request;
  const base: CommonProps = {
    clientName: request.client.name,
    destination: request.client.destination,
    denyHref: denyRedirect(request),
    loopback: !request.redirectUri.startsWith('https://'),
  };

  // Вход возвращает сюда же: тот же запрос подключения, тот же экран.
  const query = new URLSearchParams(
    Object.entries(params ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  const loginHref = `/auth/login?next=${encodeURIComponent(`${PARTNER_OAUTH_AUTHORIZE_PATH}?${query.toString()}`)}`;

  const cookieStore = await cookies();
  const user = await getUserFromRequest({ cookies: { get: (name) => cookieStore.get(name) } });
  if (!user) return <ConsentClient mode="login" {...base} loginHref={loginHref} />;

  const ctx = await partnerContextFor(user.userId, user.role);
  if (ctx.outcome === 'unavailable') return <ConsentClient mode="unavailable" {...base} />;
  if (ctx.outcome === 'none') {
    // Тупика быть не должно: войти другим аккаунтом можно всегда, а
    // переключиться — в роль партнёра, профиль которой у аккаунта уже есть.
    return (
      <ConsentClient
        mode="none"
        {...base}
        message={noneMessage(ctx.reason, ROLE_LABELS[user.role] ?? user.role)}
        loginHref={loginHref}
        switchTo={await switchablePartnerRoles(user.userId)}
      />
    );
  }

  const decision: Record<string, string> = {};
  for (const name of AUTHORIZE_PARAM_NAMES) {
    const v = params?.[name];
    if (typeof v === 'string') decision[name] = v;
  }
  return (
    <ConsentClient
      mode="consent"
      {...base}
      partnerName={await partnerDisplayName(ctx.partnerId)}
      wantsWrite={request.wantsWrite}
      decision={decision}
    />
  );
}
