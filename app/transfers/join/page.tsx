import type { Metadata } from 'next';
import { RoleJoinPage } from '@/components/partners/RoleJoinPage';
import { JOIN_PAGES } from '@/lib/partners/join-pages';

const page = JOIN_PAGES.transfer;

export const metadata: Metadata = {
  title: page.metaTitle,
  description: page.metaDescription,
  alternates: { canonical: page.path },
};

export default function TransfersJoinPage() {
  return <RoleJoinPage page={page} />;
}
