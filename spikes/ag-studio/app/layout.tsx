import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { jakarta, jetbrains } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'PayPer402 · AG Studio spike',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
