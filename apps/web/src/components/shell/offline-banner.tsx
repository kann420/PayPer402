'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatTime, nowSeconds } from '@/lib/time';

/** The offline banner, driven by `navigator.onLine` (design spec §10.14, fixes §2.17). */
export function OfflineBanner() {
  const router = useRouter();
  const [offlineSince, setOfflineSince] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setOfflineSince(navigator.onLine ? null : nowSeconds());
    const online = () => {
      setOfflineSince(null);
      router.refresh();
    };
    update();
    window.addEventListener('offline', update);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', update);
      window.removeEventListener('online', online);
    };
  }, [router]);

  if (offlineSince === null) return null;
  return (
    <div role="status" className="flex items-center gap-2.5 bg-ink-800 px-4 py-2.5 text-sm text-white">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18" />
      </svg>
      <span>
        You&apos;re offline. Showing data from {formatTime(offlineSince).slice(0, 5)}. Your agents keep running; this page will catch up when
        you&apos;re back online.
      </span>
      <button
        type="button"
        className="ml-auto rounded-lg border border-[#8A938E] bg-transparent px-2.5 py-1 text-[13px] text-white"
        onClick={() => router.refresh()}
      >
        Retry
      </button>
    </div>
  );
}
