import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Banner } from '@/lib/banners';

function Svg({ children, spin = false }: { children: ReactNode; spin?: boolean }) {
  return (
    <svg className={`flex-none ${spin ? 'pg-spin' : ''}`} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const WRAP = 'flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[14px] px-[18px] py-4';

/** The overview banners of the boards (design spec §10.7, fixes §2.7). */
export function OverviewBanner({ banner }: { banner: Banner }) {
  const body = (title: string, text: string, muted = false) => (
    <div className="flex-[1_1_320px]">
      <strong className="text-base">{title}</strong>
      <div className={`text-sm ${muted ? 'text-ink-800' : 'opacity-95'}`}>{text}</div>
    </div>
  );
  switch (banner.kind) {
    case 'stopped':
      return (
        <div role="alert" className={`${WRAP} bg-red-700 text-white`}>
          <Svg>
            <circle cx="12" cy="12" r="9" />
            <path d="M5.6 5.6l12.8 12.8" />
          </Svg>
          {body('Stopped by payer', banner.text)}
          <Link href="/app/onboarding/link" className="rounded-[10px] bg-white px-4 py-2.5 font-semibold text-red-700 hover:text-red-800">
            Re-link PayPal account
          </Link>
        </div>
      );
    case 'unlinking':
      return (
        <div role="status" className={`${WRAP} border border-line-250 bg-ground-100 text-ink-900`}>
          <Svg spin>
            <path d="M12 3a9 9 0 1 0 9 9" />
          </Svg>
          {body('Unlinking…', banner.text)}
        </div>
      );
    case 'collecting':
      return (
        <div role="status" className={`${WRAP} border border-[#B7EFD0] bg-meter-100 text-meter-800`}>
          <Svg spin>
            <path d="M12 3a9 9 0 1 0 9 9" />
          </Svg>
          {body('Collecting earlier usage', banner.text)}
        </div>
      );
    case 'not_linked':
      return (
        <div role="alert" className={`${WRAP} border-[1.5px] border-ink-950 bg-white text-ink-950`}>
          <Svg>
            <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
            <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            <path d="M4 4l16 16" />
          </Svg>
          {body('No PayPal account linked', banner.text, true)}
          <Link href="/app/onboarding/link" className="rounded-[10px] bg-ink-950 px-4 py-2.5 font-semibold text-white hover:text-white">
            Link PayPal account
          </Link>
        </div>
      );
    case 'declined':
      return (
        <div role="alert" className={`${WRAP} border border-red-300 bg-red-100 text-red-800`}>
          <Svg>
            <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
            <path d="m10 9 4 4M14 9l-4 4" />
          </Svg>
          {body('Last PayPal charge failed', banner.text)}
          <Link href={`/app/charges/${encodeURIComponent(banner.settlementId)}`} className="rounded-[10px] border-[1.5px] border-red-800 px-4 py-[9px] font-semibold text-red-800 hover:text-red-800">
            View charge
          </Link>
        </div>
      );
    case 'review':
      return (
        <div role="alert" className={`${WRAP} border border-amber-300 bg-amber-100 text-amber-800`}>
          <Svg>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4M11 8v3M11 14h.01" />
          </Svg>
          {body('Charge needs review', banner.text)}
          <Link href={`/app/charges/${encodeURIComponent(banner.settlementId)}`} className="rounded-[10px] border-[1.5px] border-amber-800 px-4 py-[9px] font-semibold text-amber-800 hover:text-amber-800">
            View charge
          </Link>
        </div>
      );
    case 'daily':
    case 'total':
    case 'unsettled': {
      const title = banner.kind === 'daily' ? 'Daily limit reached' : banner.kind === 'total' ? 'Total limit reached' : 'Waiting for the PayPal charge';
      return (
        <div role="alert" className={`${WRAP} border border-amber-300 bg-amber-100 text-amber-800`}>
          <Svg>
            <path d="M12 3 2 20h20z" />
            <path d="M12 10v4M12 17h.01" />
          </Svg>
          {body(title, banner.text)}
          {banner.kind === 'unsettled' ? null : (
            <Link href="/app/settings" className="rounded-[10px] border-[1.5px] border-amber-800 px-4 py-[9px] font-semibold text-amber-800 hover:text-amber-800">
              {banner.kind === 'daily' ? 'Raise daily limit' : 'Raise total limit'}
            </Link>
          )}
        </div>
      );
    }
  }
}
