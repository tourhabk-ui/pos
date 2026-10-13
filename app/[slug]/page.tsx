/**
 * Короткий адрес партнёра: vedarai.ru/<slug> (решение владельца 13.10:
 * «адрес vedarai.ru/<slug>»). Это та же страница оператора, что и
 * /operators/<slug>: тот же модуль, те же данные, тот же canonical
 * (/operators/<slug>) — короткий адрес для Авито, мессенджеров и QR, а
 * индексируется по-прежнему одна страница, без дубля в поиске.
 *
 * Чужую форму (точки, заглавные, кириллица) не пускаем в базу вовсе —
 * lib/partners/short-address.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import OperatorProfilePage, { generateMetadata as operatorMetadata } from '@/app/operators/[slug]/page';
import { isShortSlug } from '@/lib/partners/short-address';

export const dynamic = 'force-dynamic';

type Params = { slug: string };
type Props = { params: Promise<Params> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug } = await props.params;
  if (!isShortSlug(slug)) {
    return { title: 'Страница не найдена', robots: { index: false, follow: false } };
  }
  return operatorMetadata(props);
}

export default async function PartnerShortAddressPage(props: Props) {
  const { slug } = await props.params;
  if (!isShortSlug(slug)) notFound();
  return <OperatorProfilePage params={props.params} />;
}
