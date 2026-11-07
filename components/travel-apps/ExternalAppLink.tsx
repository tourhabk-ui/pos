'use client';

/**
 * Ссылка на стороннее приложение. Щелчок человека считается (POST
 * /api/tools/[slug], click_count) — это единственный счётчик каталога, который
 * значит то, что говорит: человек открыл сайт приложения.
 */
import { ExternalLink } from 'lucide-react';

export function ExternalAppLink({ slug, url, name }: { slug: string; url: string; name: string }) {
  function countClick() {
    // keepalive — запрос переживает уход на чужой сайт; отказ счётчика человеку не мешает.
    void fetch(`/api/tools/${encodeURIComponent(slug)}`, { method: 'POST', keepalive: true }).catch(() => null);
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={countClick}
      className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-[var(--ocean)] hover:text-[var(--accent)] transition-colors"
      aria-label={`Открыть сайт ${name} (в новой вкладке)`}
    >
      Открыть сайт <ExternalLink size={14} aria-hidden="true" />
    </a>
  );
}
