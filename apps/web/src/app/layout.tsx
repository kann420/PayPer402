import type { ReactNode } from 'react';
import { jakarta, jetbrains } from './fonts';
import { RUN_THEME_SCRIPT } from '@/lib/run-theme';
import './globals.css';

/** The tab icon is the same replaceable logo asset as everywhere else (`public/logo.png`). */
export const metadata = { title: 'PayPer402', icons: { icon: '/logo.png' } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        {/* The live run's remembered theme, applied before the first paint (design spec §10.10).
            Browser extensions may insert their own script ahead of it before hydration. */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: RUN_THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
