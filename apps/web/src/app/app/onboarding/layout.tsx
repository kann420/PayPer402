import type { ReactNode } from 'react';
import { SandboxStrip } from '@/components/shell/sandbox-strip';
import { ToastProvider } from '@/components/ui/toast';

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-ground-50 text-[15px] leading-normal text-ink-950">
        <SandboxStrip />
        {children}
      </div>
    </ToastProvider>
  );
}
