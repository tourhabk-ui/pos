/**
 * /mcp — человекочитаемый первоисточник о MCP-сервере Ведара.
 *
 * Диагноз 15.08: MCP опубликован (манифест, llms.txt, robots), но поисковый
 * AI-ответ (Алиса) галлюцинировал «MCP нет» — поиск читает индексируемые
 * HTML-страницы, а не JSON-манифесты. Эта страница — индексируемый ответ:
 * факт сервера в первых строках, дальше живой список инструментов.
 *
 * Список инструментов — из того же реестра, что сервер и манифест
 * (lib/mcp/public-tools.ts): страница не может разойтись с сервером.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { PUBLIC_MCP_TOOLS, MCP_SERVER_INFO, MCP_READ_PER_MINUTE } from '@/lib/mcp/public-tools';
// Числа лимитов — из модуля без базы: страница пререндерится на сборке, где
// DATABASE_URL нет, а write-guard тянет lib/db-pool (no-build-time-db).
import { CLIENT_WINDOW_MINUTES, CLIENT_MAX_PER_WINDOW, CLIENT_MAX_PER_DAY } from '@/lib/mcp/write-limits';
import { MCP_CATALOGS, MCP_TITLE_EN, MCP_DESCRIPTION_EN } from '@/lib/mcp/catalogs';
import { MCP_TITLE_ZH, MCP_DESCRIPTION_ZH } from '@/lib/mcp/zh-layer';
import { MCP_CONNECT_OPTIONS, MCP_SYSTEM_PROMPT_LINE_EN, MCP_SYSTEM_PROMPT_LINE_RU, MCP_TRANSPORT_SPELLINGS } from '@/lib/mcp/connect';
import { defaultOgImages } from '@/lib/seo/og-image';
import { CopyButton } from '@/components/mcp/CopyButton';

const REGISTRY_NAME = MCP_CATALOGS.find((c) => c.catalog.startsWith('MCP Registry'))?.name ?? '';
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'MCP-сервер Ведара для ИИ-агентов — vedar-mcp',
  // До 160 знаков — длиннее выдача обрезает (аудит vedarai.ru 01.10).
  description:
    'Публичный MCP-сервер Ведара для ИИ-агентов: vedarai.ru/api/mcp, без авторизации. Туры, доступность, безопасность Камчатки, заявки с подтверждением человеком.',
  alternates: { canonical: `${SITE}/mcp`, languages: { ru: `${SITE}/mcp`, en: `${SITE}/mcp#en`, 'x-default': `${SITE}/mcp` } },
  keywords: ['MCP', 'Model Context Protocol', 'Камчатка', 'Kamchatka', 'Qwen', 'Kimi', 'Claude', 'ChatGPT', 'Cursor', 'Grok', 'Coze', 'GLM'],
  openGraph: {
    images: defaultOgImages(),
    title: 'MCP-сервер Ведара для ИИ-агентов',
    description:
      'Публичный MCP-сервер: туры, доступность, безопасность Камчатки, планирование. Endpoint: vedarai.ru/api/mcp, Streamable HTTP, без авторизации.',
    url: `${SITE}/mcp`,
  },
};

export default function McpLandingPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebAPI',
    name: MCP_SERVER_INFO.name,
    alternateName: MCP_TITLE_EN,
    version: MCP_SERVER_INFO.version,
    description: MCP_SERVER_INFO.description,
    // Английский текст — тот же, что в каталогах (server.json); идентификаторы
    // записей — чтобы поисковый ответ мог сверить «есть в реестре» с нами.
    disambiguatingDescription: MCP_DESCRIPTION_EN,
    sameAs: MCP_CATALOGS.map((c) => c.url),
    identifier: MCP_CATALOGS.map((c) => ({ '@type': 'PropertyValue', propertyID: c.catalog, value: c.name })),
    documentation: `${SITE}/llms.txt`,
    endpointUrl: `${SITE}/api/mcp`,
    termsOfService: `${SITE}/legal/terms`,
    provider: { '@type': 'Organization', name: 'Ведар', url: SITE },
  };

  // HowTo: шаги подключения по клиентам — для поисковых и чат-ответов.
  const howToLd = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: 'Как подключить MCP-сервер Ведара к ИИ-чату',
    inLanguage: ['ru', 'en'],
    tool: { '@type': 'HowToTool', name: 'https://vedarai.ru/api/mcp' },
    step: MCP_CONNECT_OPTIONS.map((o, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: o.label,
      text: o.value,
      url: `${SITE}/mcp#connect-${o.id}`,
    })),
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <JsonLd data={howToLd} />
      <Header />
      <main className="ds-page">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
          {/* Факт — в первых строках страницы, для поисковика и AI-ответов. */}
          <header className="space-y-3">
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
              У Ведара есть публичный MCP-сервер для ИИ-агентов
            </h1>
            <div className="ds-card p-5 space-y-1.5 text-sm" style={{ color: 'var(--text-primary)' }}>
              <p className="flex flex-wrap items-center gap-2">
                Endpoint: <code className="font-semibold">https://vedarai.ru/api/mcp</code>
                <CopyButton text="https://vedarai.ru/api/mcp" />
              </p>
              <p className="text-xs"><a className="underline" style={{ color: 'var(--ocean)' }} href="#en">English instructions ↓</a></p>
              <p>Transport: Streamable HTTP (JSON-RPC 2.0) · Auth: не требуется</p>
              <p>
                Возможности: туры, реальная доступность мест, безопасность маршрутов,
                погода, жильё, трансферы, планирование поездки и заявки с подтверждением
                человеком.
              </p>
              <p style={{ color: 'var(--text-secondary)' }}>
                Манифест: <a className="underline" style={{ color: 'var(--ocean)' }} href="/.well-known/mcp.json">/.well-known/mcp.json</a>
                {' · '}Описание для LLM: <a className="underline" style={{ color: 'var(--ocean)' }} href="/llms.txt">/llms.txt</a>
                {' · '}Версия: {MCP_SERVER_INFO.version}
              </p>
              <p lang="en" style={{ color: 'var(--text-secondary)' }}>
                {MCP_TITLE_EN}. {MCP_DESCRIPTION_EN}. Streamable HTTP, no auth.
              </p>
              {/* Китайский слой (12.10): текст в lib/mcp/zh-layer, тот же, что в манифесте и llms.txt. */}
              <p lang="zh-CN" style={{ color: 'var(--text-secondary)' }}>
                {MCP_TITLE_ZH}。{MCP_DESCRIPTION_ZH}
                {' '}<a href="/zh#connect" hrefLang="zh-CN">中文接入说明（Qwen、Kimi、扣子、GLM 等）</a>{' · '}<a href="/llms-zh.txt" hrefLang="zh-CN">llms-zh.txt</a>
              </p>
            </div>
          </header>

          {/* Где нас искать: агент, нашедший запись в каталоге, здесь сверяет её
              с первоисточником; агент без каталога — узнаёт, что запись есть. */}
          <section className="space-y-3">
            <h2 className="ds-h2">В каталогах MCP</h2>
            <div className="space-y-2">
              {MCP_CATALOGS.map((c) => (
                <div key={c.name} className="ds-card p-4 space-y-1 text-sm">
                  <p style={{ color: 'var(--text-secondary)' }}>{c.catalog}</p>
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                    <a className="underline" style={{ color: 'var(--ocean)' }} href={c.url} rel="noopener">
                      <code>{c.name}</code>
                    </a>
                  </p>
                  {c.install && (
                    <p style={{ color: 'var(--text-secondary)' }}>
                      Подключение: <code>{c.install}</code>
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Второй вход для агентов без MCP-клиента (A2A, 12.10): визитка и
              два биндинга поверх того же реестра инструментов. */}
          <section className="space-y-3">
            <h2 className="ds-h2">Для A2A-агентов</h2>
            <div className="ds-card p-4 space-y-2 text-sm">
              <p style={{ color: 'var(--text-secondary)' }}>
                Тот же агент по протоколу Agent2Agent (A2A 1.0) — для фреймворков и песочниц без MCP-клиента.
                Текстом отвечает Кузьмич с теми же инструментами; точный вызов инструмента — DataPart с полями
                <code> tool </code> и <code> arguments</code>. Заявки те же четыре, подтверждает человек.
              </p>
              <p style={{ color: 'var(--text-primary)' }}>
                Визитка:{' '}
                <a className="underline" style={{ color: 'var(--ocean)' }} href={`${SITE}/.well-known/agent-card.json`} rel="noopener">
                  <code>/.well-known/agent-card.json</code>
                </a>
                {' '}(для клиентов 0.3 — <code>/.well-known/agent.json</code>)
              </p>
              <p style={{ color: 'var(--text-secondary)' }}>
                JSON-RPC: <code>{SITE}/api/a2a</code> · REST: <code>{SITE}/api/a2a/v1</code> · версия — заголовок <code>A2A-Version</code>
              </p>
            </div>
          </section>

          {/* Третий вход (ступень 3, 12.10): агентам без MCP- и A2A-клиента —
              описание OpenAPI 3.1 и каталог API по RFC 9727 (lib/api/openapi). */}
          <section className="space-y-3">
            <h2 className="ds-h2">Без MCP и A2A: REST и OpenAPI</h2>
            <div className="ds-card p-4 space-y-2 text-sm">
              <p style={{ color: 'var(--text-secondary)' }}>
                GPT Actions, Copilot Studio и OpenAPI-наборы фреймворков читают описание OpenAPI 3.1: в нём REST-биндинг A2A
                (любой инструмент одним POST), публичные читающие эндпоинты и входы обнаружения. Авторизации нет; запись —
                те же четыре заявки, подтверждает человек.
              </p>
              <p style={{ color: 'var(--text-primary)' }}>
                OpenAPI:{' '}
                <a className="underline" style={{ color: 'var(--ocean)' }} href={`${SITE}/openapi.json`} rel="noopener">
                  <code>/openapi.json</code>
                </a>
                {' '}· каталог API (RFC 9727):{' '}
                <a className="underline" style={{ color: 'var(--ocean)' }} href={`${SITE}/.well-known/api-catalog`} rel="noopener">
                  <code>/.well-known/api-catalog</code>
                </a>
              </p>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="ds-h2">Инструменты ({PUBLIC_MCP_TOOLS.length})</h2>
            <div className="space-y-2">
              {PUBLIC_MCP_TOOLS.map((t) => (
                <div key={t.name} className="ds-card p-4">
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    <code>{t.name}</code>
                  </p>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                    {t.description}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Рычаг номер один — «человек добавил Vedar»: ссылка, команда или
              JSON под каждый клиент, без ручного набора адреса. */}
          <section className="space-y-3">
            <h2 className="ds-h2" id="connect">Подключить одним касанием</h2>
            <div className="flex flex-wrap gap-2">
              {MCP_CONNECT_OPTIONS.filter((o) => o.kind === 'link').map((o) => (
                <span key={o.id} id={`connect-${o.id}`} className="inline-flex items-center gap-1">
                  <a className="ds-btn ds-btn-primary" href={o.value} data-connect={o.id}>
                    {o.label}
                  </a>
                  <CopyButton text={o.value} label="Ссылка" />
                </span>
              ))}
            </div>
            {MCP_CONNECT_OPTIONS.filter((o) => o.kind === 'link' && o.note).map((o) => (
              <p key={o.id} className="text-xs" style={{ color: 'var(--text-secondary)' }} data-connect-note={o.id}>
                {o.client}: {o.note}
              </p>
            ))}
            <div className="space-y-2">
              {MCP_CONNECT_OPTIONS.filter((o) => o.kind !== 'link').map((o) => (
                <div key={o.id} id={`connect-${o.id}`} className="ds-card p-4 space-y-1" data-connect={o.id}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{o.label}</p>
                    <CopyButton text={o.value} />
                  </div>
                  <pre
                    className="text-xs overflow-x-auto rounded-lg p-3"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}
                  >
                    {o.value}
                  </pre>
                  {o.note && (
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }} data-connect-note={o.id}>
                      {o.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Написание транспорта у клиентов разное (сверка 16.10): чужое уводит в
              старый SSE, а наш сервер на GET-поток отвечает 405. */}
          <section className="space-y-3">
            <h2 className="ds-h2">Как клиенты называют Streamable HTTP</h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Общего написания нет. Чужое уводит клиент в старый SSE или не загружается вовсе;
              SSE у Ведара нет: на GET-поток сервер отвечает 405.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-transport-table>
                <thead>
                  <tr style={{ color: 'var(--text-secondary)' }}>
                    <th className="text-left font-semibold py-2 pr-4">Клиенты</th>
                    <th className="text-left font-semibold py-2">Как писать</th>
                  </tr>
                </thead>
                <tbody>
                  {MCP_TRANSPORT_SPELLINGS.map((t) => (
                    <tr key={t.clients} style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                      <td className="py-2 pr-4 align-top">
                        {t.clients}
                        {t.unverified && (
                          <span className="block text-xs" style={{ color: 'var(--text-secondary)' }}>
                            транспорт по url не документирован — проверьте, что инструменты появились
                          </span>
                        )}
                      </td>
                      <td className="py-2 align-top"><code>{t.spelling}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Рычаг номер два — строка системного промпта: сильнее любой
              карточки в каталоге, потому что решает выбор внутри набора. */}
          <section className="space-y-3">
            <h2 className="ds-h2">Строка для системного промпта</h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Каталоги помогают попасть в набор инструментов агента; какой инструмент
              он выберет внутри набора, решает промпт host&apos;а. Одна строка:
            </p>
            <div className="ds-card p-4 space-y-2" data-prompt-line="en">
              <pre className="text-xs whitespace-pre-wrap rounded-lg p-3" style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }} lang="en">
                {MCP_SYSTEM_PROMPT_LINE_EN}
              </pre>
              <pre className="text-xs whitespace-pre-wrap rounded-lg p-3" style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}>
                {MCP_SYSTEM_PROMPT_LINE_RU}
              </pre>
            </div>
          </section>

          {/* English section: the same options, short steps for non-Russian readers. */}
          <section id="en" lang="en" className="ds-card p-5 space-y-2">
            <h2 className="font-playfair text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Connect Vedar MCP (English)
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Endpoint <code>https://vedarai.ru/api/mcp</code> · transport Streamable HTTP · no authentication (no legacy SSE).
              Registry name: <code>{REGISTRY_NAME}</code>. Ready-made configs are above; copy them with the buttons.
            </p>
            <ul className="text-sm list-disc pl-5 space-y-1" style={{ color: 'var(--text-secondary)' }}>
              <li><b>Qwen Chat Desktop:</b> Settings → MCP → Add MCP → Streamable HTTP → paste the URL.</li>
              <li><b>Kimi:</b> Plugins → Create plugin → MCP server URL (or import <code>{REGISTRY_NAME}</code> from the MCP Registry).</li>
              <li><b>Claude:</b> Customize → Connectors → Add custom connector → URL, no sign-in.</li>
              <li><b>ChatGPT:</b> developer mode → Add custom MCP server → URL, no authentication.</li>
              <li><b>Cursor / VS Code:</b> one-click install buttons above.</li>
              <li><b>Gemini CLI:</b> <code>~/.gemini/settings.json</code> → <code>{'"httpUrl"'}</code> field.</li>
              <li><b>Grok:</b> custom connector by URL; xAI API — tool <code>{'{"type":"mcp"}'}</code> with <code>server_url</code>.</li>
              <li><b>Coze:</b> + Plugin → Create based on MCP → URL.</li>
              <li><b>Zhipu GLM API:</b> <code>tools: [{'{ "type": "mcp", ... }'}]</code> with the server URL.</li>
            </ul>
          </section>

          <section className="ds-card p-5 space-y-2">
            <h2 className="font-playfair text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Как подключить вручную
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              В любом MCP-клиенте (Yandex AI Studio и других без готового способа выше)
              укажите тип подключения Streamable HTTP, адрес
              {' '}<code>https://vedarai.ru/api/mcp</code> и «без авторизации».
              Чтение анонимно. Записей четыре — заявка на подбор тура, заявка оператору на тур
              и дату, заявка на машину целиком и заявка владельцу жилья; для каждой нужны согласие
              и телефон, подтверждает её человек. Мгновенной брони и оплаты через MCP нет.
              Лимиты с одного IP: чтение — {MCP_READ_PER_MINUTE} вызовов в минуту, заявки — {CLIENT_MAX_PER_WINDOW} за
              {' '}{CLIENT_WINDOW_MINUTES} минут и {CLIENT_MAX_PER_DAY} в сутки.
              Клиент умеет только stdio или уходит в SSE — мост:
              {' '}<code>npx -y mcp-remote https://vedarai.ru/api/mcp --transport http-only</code>.
            </p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Данные — из живой базы платформы: та же занятость туров и тот же
              статус безопасности, что видит турист на{' '}
              <Link className="underline" style={{ color: 'var(--ocean)' }} href="/safety">странице безопасности</Link>
              {' '}и в{' '}
              <Link className="underline" style={{ color: 'var(--ocean)' }} href="/planner">планировщике</Link>.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
