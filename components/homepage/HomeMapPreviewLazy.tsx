'use client';

import dynamic from 'next/dynamic';

// ssr:false is only allowed inside 'use client' components in Next.js 15.
// app/page.tsx (Server Component) imports this wrapper, which then loads
// HomeMapPreview (which uses Leaflet) only on the client.
const HomeMapPreviewInner = dynamic(
  () => import('./HomeMapPreview').then(m => ({ default: m.HomeMapPreview })),
  { ssr: false, loading: () => null }
);

export function HomeMapPreviewLazy() {
  return <HomeMapPreviewInner />;
}
