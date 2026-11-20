/**
 * Утверждённый маршрут природного парка на карточке маршрута (20.11, слово
 * владельца «Сверка и пометка»). Слова — те же, что у Кузьмича и MCP
 * (lib/parks/approved-routes); статус «открыт / закрыт» здесь не утверждается.
 */
import { FileText, Route as RouteIcon } from 'lucide-react';
import {
  PARK_RULE_QUOTE, variantWords, type ApprovedRouteCase, type ApprovedVariant,
} from '@/lib/parks/approved-routes';

function readOnWords(d: string): string {
  return d.split('-').reverse().join('.');
}

const linkStyle = { color: 'var(--ocean)' } as const;

export function ParkApprovedRoute({ approved }: { approved: ApprovedRouteCase | null | undefined }) {
  if (!approved) return null;
  if (approved.kind === 'not_listed') {
    return (
      <section className="space-y-2" aria-labelledby="park-approved" data-park-approved="not_listed">
        <h2 id="park-approved" className="ds-h2">Маршрут в парке</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Среди утверждённых маршрутов парка ({approved.parkName}) мы этот маршрут не нашли. Парк пишет: «{PARK_RULE_QUOTE}»
        </p>
        <a className="text-sm underline" style={linkStyle} href={approved.sourceUrl} target="_blank" rel="noopener noreferrer">
          Список утверждённых маршрутов на сайте парка
        </a>
      </section>
    );
  }
  const groups = new Map<string, ApprovedVariant[]>();
  for (const v of approved.variants) {
    const key = `${v.parkName}|${v.title}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const first = approved.variants[0]!;
  return (
    <section className="space-y-3" aria-labelledby="park-approved" data-park-approved="linked">
      <h2 id="park-approved" className="ds-h2">Утверждённый маршрут парка</h2>
      {[...groups.values()].map((vs) => (
        <div key={`${vs[0]!.parkName}|${vs[0]!.title}`} className="ds-card p-4 text-sm space-y-2">
          <p style={{ color: 'var(--text-primary)' }}>
            <span className="font-semibold">«{vs[0]!.title}»</span> — {vs[0]!.parkName}
          </p>
          <ul className="space-y-1">
            {vs.map((v) => (
              <li key={v.season} style={{ color: 'var(--text-secondary)' }}>
                {variantWords(v)}
                {v.passportUrls.map((u, i) => (
                  <a key={u} className="ml-2 inline-flex items-center gap-1 underline" style={linkStyle} href={u} target="_blank" rel="noopener noreferrer">
                    <FileText className="w-3.5 h-3.5" aria-hidden="true" />паспорт{v.passportUrls.length > 1 ? ` ${i + 1}` : ''} (PDF)
                  </a>
                ))}
                {v.trackUrl && (
                  <a className="ml-2 inline-flex items-center gap-1 underline" style={linkStyle} href={v.trackUrl} target="_blank" rel="noopener noreferrer">
                    <RouteIcon className="w-3.5 h-3.5" aria-hidden="true" />трек парка
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Парк пишет: «{PARK_RULE_QUOTE}» Источник —{' '}
        <a className="underline" style={linkStyle} href={first.sourceUrl} target="_blank" rel="noopener noreferrer">страница парка «Туристические маршруты»</a>, прочитано {readOnWords(first.readOn)}. Открыт ли маршрут сейчас, уточняйте у парка.
      </p>
    </section>
  );
}
