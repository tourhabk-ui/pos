import { Metadata } from 'next';
import PartnerApplicationsClient from './_PartnerApplicationsClient';

export const metadata: Metadata = {
  title: 'Заявки на подключение | Admin',
  robots: 'noindex, nofollow',
};

export default function PartnerApplicationsPage() {
  return <PartnerApplicationsClient />;
}
