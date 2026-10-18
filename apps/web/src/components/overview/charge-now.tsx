'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { chargeToast } from '@/lib/charge';
import { errorCopy } from '@/lib/copy';
import { formatUsd } from '@/lib/money';
import { callApi, handleEnded } from '../shell/session-client';
import { btn } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { useToast } from '../ui/toast';

/** "Charge now" with its confirm dialog (design spec §10.7). Amounts come from `chargeable`. */
export function ChargeNowButton({
  enabled,
  amount,
  title,
  body,
  size = 'small',
}: {
  enabled: boolean;
  amount: number;
  title: string;
  body: string;
  size?: 'small' | 'dark';
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    const res = await callApi<{ settlement: { status: string } }>('/api/operator/settlements');
    setBusy(false);
    setOpen(false);
    if (res.ok) {
      toast({ text: chargeToast(res.settlement.status) });
      router.refresh();
      return;
    }
    if (!handleEnded(res)) toast({ text: errorCopy(res.error, res.message), icon: 'error' });
    router.refresh();
  };

  return (
    <>
      <button
        type="button"
        disabled={!enabled}
        onClick={() => setOpen(true)}
        className={
          size === 'small'
            ? `${btn.small} ml-auto`
            : 'h-10 rounded-[10px] border-0 bg-meter-400 px-4 text-sm font-bold text-ink-950 disabled:cursor-not-allowed disabled:border disabled:border-[#34403B] disabled:bg-transparent disabled:text-code-comment'
        }
      >
        Charge now
      </button>
      <Dialog
        open={open}
        title={title}
        onClose={() => setOpen(false)}
        actions={
          <>
            <button type="button" className={btn.ghost} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className={btn.primary} disabled={busy} onClick={() => void confirm()}>
              {busy ? 'Charging…' : `Charge ${formatUsd(amount)}`}
            </button>
          </>
        }
      >
        <p className="m-0 text-sm text-ink-800">{body}</p>
      </Dialog>
    </>
  );
}
