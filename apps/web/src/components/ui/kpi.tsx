import type { ReactNode } from 'react';

/** The KPI card of the DesignSystem board. */
export function KpiCard({ label, value, children, className = '' }: { label: string; value: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 rounded-[14px] border border-line-200 bg-white p-[18px] ${className}`}>
      <span className="text-[13px] text-ink-500">{label}</span>
      <span className="tnum font-mono text-[28px] font-semibold tracking-[-0.02em]">{value}</span>
      {children}
    </div>
  );
}

/** A thin progress bar (`role="progressbar"`). */
export function Meter({ label, value, max, color, height = 6 }: { label: string; value: number; max: number; color: string; height?: number }) {
  const pct = max <= 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className="overflow-hidden rounded-full bg-ground-100"
      style={{ height }}
    >
      <div className="pg-fill h-full transition-[width] duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

/** Loading skeletons for KPI rows and widget frames (States board). */
export function KpiSkeletons({ count = 4 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2.5 rounded-[14px] border border-line-200 bg-white p-[18px]">
          <span className="sk h-3 w-1/2" />
          <span className="sk h-7 w-[70%]" />
          <span className="sk h-1.5 w-full" />
          <span className="sk h-2.5 w-[40%]" />
        </div>
      ))}
    </div>
  );
}

export function WidgetSkeletons() {
  return (
    <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
      <section className="rounded-[14px] border border-line-200 bg-white">
        <header className="border-b border-ground-100 px-4 py-3.5">
          <span className="sk h-3.5 w-[140px]" />
        </header>
        <div className="flex h-[180px] items-end gap-2.5 p-4">
          {[40, 65, 50, 85, 60, 75].map((h) => (
            <span key={h} className="sk flex-1" style={{ height: `${h}%` }} />
          ))}
        </div>
      </section>
      <section className="rounded-[14px] border border-line-200 bg-white">
        <header className="border-b border-ground-100 px-4 py-3.5">
          <span className="sk h-3.5 w-40" />
        </header>
        <div className="flex flex-col gap-3.5 p-4">
          <span className="sk h-4" />
          <span className="sk h-4" />
          <span className="sk h-4" />
          <span className="sk h-4 w-[70%]" />
        </div>
      </section>
    </div>
  );
}
