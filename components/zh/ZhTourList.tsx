/**
 * Список туров на китайском входе /zh — вынесен из страницы, чтобы сторож
 * судил его рендером с данными, а не текстом исходника (CLAUDE.md §4,
 * «Сторож судит поведение, не текст»).
 *
 * Аудит 15.10 (CN-quick), §0: /zh — общая витрина. Порядок один для всех и
 * назван на странице по-китайски (ZH_TOURS_ORDER_NOTE, тот же файл, что у
 * подписи витрины компаний); рядом с туром — компания, по названию которой он
 * стоит на своём месте, иначе правило порядка не проверить глазами. Число в
 * заголовке — все туры витрины: среза нет (lib/zh/entry). Отказ базы и пустая
 * витрина — разные слова (§4.0).
 *
 * Серверный компонент: без хуков, данные приходят готовыми и упорядоченными.
 */
import Link from 'next/link';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { tourPath } from '@/lib/tours/tour-url';
import { priceZh, durationZh, type ZhTourRow } from '@/lib/zh/entry';
import { ZH_PAGE } from '@/lib/mcp/zh-layer';
import { ZH_TOURS_ORDER_NOTE } from '@/lib/operators/order-note';

export function ZhTourList({ tours }: { tours: ZhTourRow[] | null }) {
  return (
    <section className="space-y-3" aria-labelledby="zh-tours-heading">
      <h2 id="zh-tours-heading" className="ds-h2">当前团队游{tours ? `（${tours.length}）` : ''}</h2>
      {tours === null ? (
        <p className="ds-card p-4 text-sm" style={{ color: 'var(--warning)' }}>
          {ZH_PAGE.catalogUnavailable} <Link className="underline" href="/catalog">/catalog</Link>
        </p>
      ) : tours.length === 0 ? (
        <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>{ZH_PAGE.catalogEmpty}</p>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }} data-zh-order-note>{ZH_TOURS_ORDER_NOTE}</p>
          <ul className="space-y-2">
            {tours.map((t) => (
              <li key={t.id} className="ds-card p-4 text-sm" data-zh-tour={t.id}>
                <Link className="underline font-semibold" style={{ color: 'var(--ocean)' }} href={tourPath({ id: t.id, slug: t.slug })} lang="ru">
                  {t.title}
                </Link>
                <p style={{ color: 'var(--text-secondary)' }}>
                  旅行社：<span lang="ru"><OperatorNameLink name={t.operator_name} slug={t.operator_slug} isPublic={t.operator_public} /></span>
                </p>
                <p style={{ color: 'var(--text-secondary)' }}>
                  {[priceZh(t), durationZh(t)].filter(Boolean).join(' · ') || '价格与时长以旅行社确认为准'}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
