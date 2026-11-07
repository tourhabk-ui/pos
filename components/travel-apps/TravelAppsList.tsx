/**
 * «Приложения в дорогу» — сторонние приложения, которые пригодятся на
 * Камчатке (страница /ai-tools, таблица external_tools, миграция 1396).
 *
 * Прежде страница называлась «AI-арсенал Камчатки», обещала «48 проверенных
 * инструментов для безопасного путешествия — от лавинных прогнозов…»,
 * рисовала звёзды и молнию с числом, похожим на популярность, и сортировала по
 * этому числу. Проверки не было (668 отметила всё скопом), звёзд — оценок
 * (1341), а число считало попадания в ответ Кузьмича. Теперь (§0 CLAUDE.md):
 *   - сказано, чьи это приложения и что Ведар за место в списке не берёт;
 *   - порядок назван словами: по задаче, внутри — по алфавиту;
 *   - безопасность — не здесь: ссылка на обстановку Ведара и 112;
 *   - у определителей по фото — что они не про съедобность;
 *   - список не прочитался — так и сказано, а не «ничего не найдено».
 */
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { APP_CATEGORIES, NATURE_CAUTION, type ExternalTool } from '@/lib/travel-apps/catalog';
import { ExternalAppLink } from './ExternalAppLink';

function groupApps(apps: ExternalTool[]): Array<{ value: string; label: string; apps: ExternalTool[] }> {
  const known = new Set(APP_CATEGORIES.map((c) => c.value));
  const groups = APP_CATEGORIES.map((c) => ({ ...c, apps: apps.filter((a) => a.category === c.value) }));
  const other = apps.filter((a) => !known.has(a.category));
  if (other.length > 0) groups.push({ value: 'other', label: 'Другое', apps: other });
  return groups
    .filter((g) => g.apps.length > 0)
    .map((g) => ({ ...g, apps: [...g.apps].sort((a, b) => a.name.localeCompare(b.name, 'ru')) }));
}

export function TravelAppsList({ apps }: { apps: ExternalTool[] | null }) {
  const groups = apps ? groupApps(apps) : [];
  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">Сторонние приложения</p>
      <h1 className="font-playfair text-4xl md:text-5xl font-bold text-[var(--text-primary)] mb-4 leading-tight">
        Приложения в дорогу
      </h1>
      <p className="text-[var(--text-secondary)] text-lg mb-2">
        Пригодятся на Камчатке. Их делают другие компании: Ведар за них не отвечает и денег за место в списке не получает.
      </p>
      <p className="text-sm text-[var(--text-muted)] mb-8">Порядок — по задаче, внутри раздела — по алфавиту.</p>

      {apps === null ? (
        <p role="alert" className="ds-card text-[var(--text-secondary)]">
          Список не загрузился. Обновите страницу позже.
        </p>
      ) : groups.length === 0 ? (
        <p className="ds-card text-[var(--text-secondary)]">Список пока пуст.</p>
      ) : (
        <div className="space-y-10">
          {groups.map((g) => (
            <section key={g.value} aria-labelledby={`apps-${g.value}`}>
              <h2 id={`apps-${g.value}`} className="ds-h2 mb-4">{g.label}</h2>
              <ul className="space-y-3">
                {g.apps.map((app) => (
                  <li key={app.slug} className="ds-card">
                    <div className="flex flex-wrap items-baseline gap-2 mb-1">
                      <h3 className="font-semibold text-[var(--text-primary)]">{app.name}</h3>
                      {app.is_free && <span className="text-xs text-[var(--success)]">бесплатно</span>}
                    </div>
                    <p className="text-sm text-[var(--text-secondary)] mb-2">{app.description}</p>
                    <ExternalAppLink slug={app.slug} url={app.url} name={app.name} />
                  </li>
                ))}
              </ul>
              {g.value === 'nature' && <p className="text-sm text-[var(--text-secondary)] mt-3">{NATURE_CAUTION}</p>}
            </section>
          ))}
        </div>
      )}

      <aside className="ds-card mt-10 flex gap-3 items-start" aria-label="Безопасность">
        <ShieldAlert className="w-5 h-5 shrink-0 text-[var(--danger)] mt-0.5" aria-hidden="true" />
        <p className="text-sm text-[var(--text-secondary)]">
          Безопасность — не сторонние приложения. Обстановка в крае, вулканы и погода — на странице{' '}
          <Link href="/safety" className="text-[var(--ocean)] underline">«Обстановка»</Link>, экстренный вызов — <span className="font-semibold text-[var(--text-primary)]">112</span>.
        </p>
      </aside>
    </div>
  );
}
