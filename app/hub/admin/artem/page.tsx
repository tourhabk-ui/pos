import type { Metadata } from 'next';
import { ArtemWorkspaceClient } from './_ArtemWorkspaceClient';

export const metadata: Metadata = {
  title: 'Рабочее место МЧС',
};

export default function ArtemWorkspacePage() {
  return <ArtemWorkspaceClient />;
}
