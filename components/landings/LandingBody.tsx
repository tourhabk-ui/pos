/**
 * Тело посадочной по блокам lib/articles/markdown — шаблон ТЗ Сыщика 21.11:
 * «Коротко» в рамке, якоря у H2, цветные блоки по явному списку абзацев
 * (lib/landings/design), фото перед разделом, FAQ в <details> (ответы в HTML
 * сервера, первый вопрос раскрыт), Кузьмич перед «Источниками».
 * Слова текста не меняются: блоки только оборачиваются.
 */
import type { ReactNode } from 'react';
import { inlineText, type Block } from '@/lib/articles/markdown';
import { CALLOUT_KICKER, type LandingCallout, type LandingFigure } from '@/lib/landings/design';
import { renderLandingInline as ri } from '@/components/landings/LandingInline';
import { LandingFigureView } from '@/components/landings/LandingMedia';

export const SOURCES_RE = /^источники$/i;

export function isLeadBlock(b: Block): boolean {
  if (b.t !== 'p') return false;
  const first = b.c[0];
  return first?.t === 'strong' && /^коротко\.?$/i.test(inlineText(first.c));
}

/** Какой цветной блок у абзаца (по началу его простого текста); нет — null. */
export function calloutFor(b: Block, callouts: readonly LandingCallout[]): LandingCallout | null {
  if (b.t !== 'p' || callouts.length === 0) return null;
  const text = inlineText(b.c);
  return callouts.find((c) => text.startsWith(c.starts)) ?? null;
}

export interface LandingBodyProps {
  blocks: Block[];
  /** id заголовков H2 (тот же объект блока). */
  ids: Map<Block, string>;
  callouts: readonly LandingCallout[];
  figures: readonly LandingFigure[];
  /** Сразу после «Коротко» (оглавление). */
  afterLead?: ReactNode;
  /** Перед H2 «Источники» (блок Кузьмича). */
  beforeSources?: ReactNode;
  /** Ключ первого вопроса FAQ на странице — он раскрыт. */
  openQa?: Block | null;
}

export function LandingBody({ blocks, ids, callouts, figures, afterLead, beforeSources, openQa }: LandingBodyProps) {
  let inSources = false;
  let leadDone = false;
  const out: ReactNode[] = [];
  if (afterLead && !blocks.some(isLeadBlock)) out.push(<div key="afterlead">{afterLead}</div>);
  blocks.forEach((b, i) => {
    const k = `b${i}`;
    switch (b.t) {
      case 'h2': {
        inSources = SOURCES_RE.test(b.text);
        const fig = figures.find((f) => f.beforeH2 === b.text);
        if (fig) out.push(<LandingFigureView key={`${k}f`} figure={fig} />);
        if (inSources && beforeSources) out.push(<div key={`${k}k`}>{beforeSources}</div>);
        out.push(<h2 key={k} id={ids.get(b)} className="ds-h2 landing-h2" style={{ fontFamily: 'var(--font-playfair)' }}>{ri(b.c, k)}</h2>);
        return;
      }
      case 'h3':
        out.push(<h3 key={k} className="text-lg font-semibold pt-2">{ri(b.c, k)}</h3>);
        return;
      case 'p': {
        if (!leadDone && isLeadBlock(b)) {
          leadDone = true;
          out.push(
            <div key={k} className="landing-lead" aria-label="Краткий ответ" data-landing-lead="" data-lead-answer="">
              <p className="text-[var(--text-primary)] leading-relaxed">{ri(b.c, k)}</p>
            </div>,
          );
          if (afterLead) out.push(<div key={`${k}toc`}>{afterLead}</div>);
          return;
        }
        const c = calloutFor(b, callouts);
        if (c) {
          out.push(
            <aside key={k} className={`landing-callout landing-callout--${c.kind}`} data-landing-callout={c.kind}>
              <p className="landing-kicker landing-callout-kicker">{c.kicker ?? CALLOUT_KICKER[c.kind]}</p>
              <p className="text-[var(--text-primary)] leading-relaxed">{ri(b.c, k)}</p>
            </aside>,
          );
          return;
        }
        out.push(<p key={k} className="landing-p text-[var(--text-primary)] leading-relaxed">{ri(b.c, k)}</p>);
        return;
      }
      case 'ul':
        out.push(
          <ul key={k} className="landing-list list-disc pl-6 space-y-1 text-[var(--text-primary)] leading-relaxed">
            {b.items.map((it, j) => <li key={j}>{ri(it, `${k}.${j}`)}</li>)}
          </ul>,
        );
        return;
      case 'ol':
        out.push(
          <ol key={k} className={`list-decimal pl-6 space-y-1 leading-relaxed ${inSources ? 'landing-sources text-sm text-[var(--text-secondary)] break-words [overflow-wrap:anywhere]' : 'landing-list text-[var(--text-primary)]'}`}>
            {b.items.map((it, j) => (
              <li key={j} id={inSources ? `source-${j + 1}` : undefined}>{ri(it, `${k}.${j}`)}</li>
            ))}
          </ol>,
        );
        return;
      case 'table':
        out.push(
          <div key={k} className="relative" data-table-scroll="">
            <p className="sm:hidden text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Таблица прокручивается вправо</p>
            <div className="landing-table-wrap overflow-x-auto">
              <table className="landing-table w-max min-w-full text-sm border-collapse">
                {b.head.length > 0 && (
                  <thead>
                    <tr>{b.head.map((c, j) => <th key={j} scope="col">{ri(c, `${k}.h${j}`)}</th>)}</tr>
                  </thead>
                )}
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>{r.map((c, x) => <td key={x}>{ri(c, `${k}.${j}.${x}`)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>,
        );
        return;
      case 'qa':
        out.push(
          <details key={k} className="landing-faq" open={b === openQa} data-landing-faq="">
            <summary><h3 className="landing-faq-q">{ri(b.q, `${k}.q`)}</h3></summary>
            <div className="landing-faq-a">
              {b.a.map((p, j) => <p key={j} className="text-[var(--text-primary)] leading-relaxed">{ri(p, `${k}.a${j}`)}</p>)}
            </div>
          </details>,
        );
        return;
    }
  });
  return <div className="landing-body space-y-4">{out}</div>;
}
