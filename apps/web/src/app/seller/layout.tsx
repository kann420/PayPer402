import type { ReactNode } from 'react';
import { ConsoleShell } from '@/components/shell/console-shell';
import { sellerPage } from '@/lib/page';

export const dynamic = 'force-dynamic';

/** The seller console (design spec §9): any valid session; the seller key is the server's. */
export default async function SellerLayout({ children }: { children: ReactNode }) {
  await sellerPage();
  return <ConsoleShell console="seller">{children}</ConsoleShell>;
}
