/**
 * /zh — индексируемый HTML-вход по-китайски (карт-бланш владельца 12.10:
 * «подключить китайцев»).
 *
 * Проба 12.10 (model-knowledge-probe): DeepSeek и Qwen о vedarai.ru не знают.
 * В веса модели не записаться; китайские чаты отвечают с поиском, а их
 * поисковики (Baidu, Sogou, Shenma, Toutiao) индексируют HTML — не llms.txt и
 * не манифест. До этой страницы китайской HTML-страницы у платформы не было.
 *
 * Текст — из lib/mcp/zh-layer: один источник на llms.txt, манифест, визитку
 * A2A и эту страницу (три копии разошлись бы). Список туров — живой, из той
 * же витрины и под тем же гейтом, что каталог и sitemap (lib/zh/entry); отказ
 * базы назван вслух, а не показан пустым списком (§4.0). Порядок туров один и
 * назван на странице, среза нет (§0, аудит 15.10, CN-quick —
 * components/zh/ZhTourList). Команда подключения
 * Qwen Code — из lib/mcp/connect, не вторая копия. Блок «如何在中文客户端中接入»
 * (аудит 15.10, CN-zh) — шаги, источник и дата из zh-layer, ссылки Trae из
 * connect; своего текста о клиентах страница не держит.
 *
 * Сторож: tests/unit/zh-entry.test.ts.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { ZhTourList } from '@/components/zh/ZhTourList';
import { loadZhTours } from '@/lib/zh/entry';
import { recordZhEntryHit } from '@/lib/analytics/agent-entry-hits';
import {
  MCP_DESCRIPTION_ZH, ZH_PAGE, ZH_CONNECT, ZH_CLIENT_GUIDES, ZH_GUIDE_BASIS_NOTE,
} from '@/lib/mcp/zh-layer';
import { MCP_CONNECT_OPTIONS } from '@/lib/mcp/connect';
import { defaultOgImages } from '@/lib/seo/og-image';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: ZH_PAGE.title,
  description: ZH_PAGE.description,
  alternates: {
    canonical: `${SITE}/zh`,
    languages: { ru: `${SITE}/`, 'zh-CN': `${SITE}/zh`, 'x-default': `${SITE}/` },
  },
  openGraph: {
    url: `${SITE}/zh`,
    title: ZH_PAGE.title,
    description: ZH_PAGE.description,
    images: defaultOgImages(),
    locale: 'zh_CN',
    type: 'website',
    siteName: 'Vedar',
  },
  robots: { index: true, follow: true },
};

export default async function ZhEntryPage() {
  // Перепись краулеров по семействам (аудит 15.10, CN-quick): читают ли
  // китайскую страницу Baiduspider, YisouSpider, Bytespider — до этого дня
  // ответить было нечем. Считается семейство по заголовку, люди не считаются
  // (lib/analytics/agent-entry-hits); запись не ждётся и ответ не роняет.
  recordZhEntryHit('/zh', (await headers()).get('user-agent'));
  const tours = await loadZhTours();
  const qwen = MCP_CONNECT_OPTIONS.find((o) => o.id === 'qwen_code')?.value ?? null;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: ZH_PAGE.h1,
    description: ZH_PAGE.description,
    inLanguage: 'zh-CN',
    url: `${SITE}/zh`,
    isPartOf: { '@type': 'WebSite', name: 'Ведар', url: SITE, inLanguage: 'ru' },
    about: { '@type': 'Place', name: '堪察加半岛（Камчатка）' },
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <Header />
      <main className="ds-page" lang="zh-CN">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
          <header className="space-y-3">
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {ZH_PAGE.h1}
            </h1>
            <div className="ds-card p-5 space-y-2 text-sm" style={{ color: 'var(--text-primary)' }}>
              <p>{MCP_DESCRIPTION_ZH}</p>
              <p style={{ color: 'var(--text-secondary)' }}>{ZH_PAGE.langNote} {ZH_PAGE.emergency}</p>
            </div>
          </header>

          <section className="space-y-3">
            <h2 className="ds-h2">平台能做什么</h2>
            <ul className="ds-card p-4 space-y-1 text-sm list-disc list-inside" style={{ color: 'var(--text-primary)' }}>
              {ZH_PAGE.capabilities.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </section>

          <ZhTourList tours={tours} />

          <section className="space-y-3">
            <h2 className="ds-h2">如何预订</h2>
            <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-primary)' }}>{ZH_PAGE.booking}</p>
          </section>

          <section className="space-y-3">
            <h2 className="ds-h2">AI 代理接口</h2>
            <div className="ds-card p-4 space-y-2 text-sm" style={{ color: 'var(--text-primary)' }}>
              <p>{ZH_PAGE.agents}</p>
              <p>
                MCP：<code>{SITE}/api/mcp</code>
                {' · '}清单：<a className="underline" style={{ color: 'var(--ocean)' }} href="/.well-known/mcp.json">/.well-known/mcp.json</a>
              </p>
              <p>
                A2A 代理卡：<a className="underline" style={{ color: 'var(--ocean)' }} href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>
                {' · '}OpenAPI：<a className="underline" style={{ color: 'var(--ocean)' }} href="/openapi.json">/openapi.json</a>
                {' · '}LLM 说明：<a className="underline" style={{ color: 'var(--ocean)' }} href="/llms.txt">/llms.txt</a>
              </p>
              {qwen && <p>Qwen Code：<code>{qwen}</code></p>}
            </div>
          </section>

          {/* Шаги под китайские клиенты (аудит 15.10, CN-zh): живого подключения
              не было, поэтому у каждого — источник, дата и пометка «界面可能不同». */}
          <section className="space-y-3" id="connect">
            <h2 className="ds-h2">{ZH_CONNECT.heading}</h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{ZH_CONNECT.intro}</p>
            <ul className="space-y-3">
              {ZH_CLIENT_GUIDES.map((g) => (
                <li key={g.id} className="ds-card p-4 space-y-2 text-sm" style={{ color: 'var(--text-primary)' }} data-zh-client={g.id}>
                  <h3 className="font-semibold">{g.client}</h3>
                  <ol className="list-decimal list-inside space-y-1">
                    {g.steps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  {g.code && (
                    <pre
                      className="text-xs overflow-x-auto rounded-lg p-3"
                      style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}
                    >
                      {g.code}
                    </pre>
                  )}
                  {g.links.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {g.links.map((l) => (
                        <a key={l.id} className="ds-btn ds-btn-primary" href={l.href} data-connect={l.id}>{l.label}</a>
                      ))}
                    </div>
                  )}
                  {g.caveat && <p style={{ color: 'var(--text-secondary)' }}>{g.caveat}</p>}
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {ZH_GUIDE_BASIS_NOTE[g.basis]}。{ZH_CONNECT.sourceLabel}：
                    {g.sources.map((src, i) => (
                      <span key={src.url}>
                        {i > 0 && '、'}
                        <a className="underline break-all" style={{ color: 'var(--ocean)' }} href={src.url} rel="nofollow noopener noreferrer">{src.url}</a>
                        {src.published && `（${src.published}）`}
                      </span>
                    ))}
                    （{g.checkedOn} {ZH_CONNECT.checkedLabel}）
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <footer className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            <Link className="underline" href="/">俄文首页</Link>
            {' · '}<Link className="underline" href="/catalog">俄文目录</Link>
            {' · '}<Link className="underline" href="/mcp">MCP 页面（俄文）</Link>
          </footer>
        </div>
      </main>
    </>
  );
}
