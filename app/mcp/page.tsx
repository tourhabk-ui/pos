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
import { PUBLIC_MCP_TOOLS, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { MCP_CATALOGS, MCP_TITLE_EN, MCP_DESCRIPTION_EN } from '@/lib/mcp/catalogs';
import { MCP_CONNECT_OPTIONS, MCP_SYSTEM_PROMPT_LINE_EN, MCP_SYSTEM_PROMPT_LINE_RU } from '@/lib/mcp/connect';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'MCP-сервер Ведара для ИИ-агентов — vedar-mcp',
  description:
    'У Ведара есть публичный MCP-сервер для ИИ-агентов: endpoint https://vedarai.ru/api/mcp, Streamable HTTP, без авторизации. Туры, реальная доступность, безопасность Камчатки, погода, планирование и заявки с подтверждением человеком.',
  alternates: { canonical: `${SITE}/mcp` },
  openGraph: {
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

  return (
    <>
      <JsonLd data={jsonLd} />
      <Header />
      <main className="ds-page">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
          {/* Факт — в первых строках страницы, для поисковика и AI-ответов. */}
          <header className="space-y-3">
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
              У Ведара есть публичный MCP-сервер для ИИ-агентов
            </h1>
            <div className="ds-card p-5 space-y-1.5 text-sm" style={{ color: 'var(--text-primary)' }}>
              <p>Endpoint: <code className="font-semibold">https://vedarai.ru/api/mcp</code></p>
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
            <h2 className="ds-h2">Подключить одним касанием</h2>
            <div className="flex flex-wrap gap-2">
              {MCP_CONNECT_OPTIONS.filter((o) => o.kind === 'link').map((o) => (
                <a key={o.id} className="ds-btn ds-btn-primary" href={o.value} data-connect={o.id}>
                  {o.label}
                </a>
              ))}
            </div>
            <div className="space-y-2">
              {MCP_CONNECT_OPTIONS.filter((o) => o.kind !== 'link').map((o) => (
                <div key={o.id} className="ds-card p-4 space-y-1" data-connect={o.id}>
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{o.label}</p>
                  <pre
                    className="text-xs overflow-x-auto rounded-lg p-3"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}
                  >
                    {o.value}
                  </pre>
                </div>
              ))}
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

          <section className="ds-card p-5 space-y-2">
            <h2 className="font-playfair text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Как подключить вручную
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              В любом MCP-клиенте (Yandex AI Studio и других без кнопки выше)
              укажите тип подключения Streamable HTTP, адрес
              {' '}<code>https://vedarai.ru/api/mcp</code> и «без авторизации».
              Чтение анонимно; записи две — заявка на подбор тура и заявка на бронь,
              обе подтверждает живой оператор по телефону. Мгновенной оплаты через
              MCP нет сознательно. Действует rate-limit по IP.
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
