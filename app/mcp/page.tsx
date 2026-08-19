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
    version: MCP_SERVER_INFO.version,
    description: MCP_SERVER_INFO.description,
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
            </div>
          </header>

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

          <section className="ds-card p-5 space-y-2">
            <h2 className="font-playfair text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Как подключить
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              В любом MCP-клиенте (Claude Desktop, Cursor, Yandex AI Studio и других)
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
