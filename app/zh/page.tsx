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
 * базы назван вслух, а не показан пустым списком (§4.0). Команда подключения
 * Qwen Code — из lib/mcp/connect, не вторая копия.
 *
 * Сторож: tests/unit/zh-entry.test.ts.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { tourPath } from '@/lib/tours/tour-url';
import { loadZhTours, priceZh, durationZh } from '@/lib/zh/entry';
import { MCP_DESCRIPTION_ZH, ZH_PAGE } from '@/lib/mcp/zh-layer';
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

          <section className="space-y-3">
            <h2 className="ds-h2">当前团队游{tours ? `（${tours.length}）` : ''}</h2>
            {tours === null ? (
              <p className="ds-card p-4 text-sm" style={{ color: 'var(--warning)' }}>
                {ZH_PAGE.catalogUnavailable} <Link className="underline" href="/catalog">/catalog</Link>
              </p>
            ) : tours.length === 0 ? (
              <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>{ZH_PAGE.catalogEmpty}</p>
            ) : (
              <ul className="space-y-2">
                {tours.map((t) => (
                  <li key={t.id} className="ds-card p-4 text-sm">
                    <Link className="underline font-semibold" style={{ color: 'var(--ocean)' }} href={tourPath({ id: t.id, slug: t.slug })} lang="ru">
                      {t.title}
                    </Link>
                    <p style={{ color: 'var(--text-secondary)' }}>
                      {[priceZh(t), durationZh(t)].filter(Boolean).join(' · ') || '价格与时长以旅行社确认为准'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

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
