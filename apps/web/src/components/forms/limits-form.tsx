'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { capsToInput, issuesToFields, parseDollars, validateCaps, type CapsField, type CapsInput } from '@/lib/caps-form';
import { formatUsd } from '@/lib/money';
import { callApi, handleEnded } from '../shell/session-client';
import { useToast } from '../ui/toast';

export interface SavedCaps {
  perCall: number;
  daily: number;
  unsettled: number;
  total?: number | undefined;
}

function ErrorLine({ text }: { text: string }) {
  return (
    <span role="alert" className="flex items-center gap-1.5 text-[13px] font-semibold text-red-700">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 17h.01" />
      </svg>
      {text}
    </span>
  );
}

function MoneyField({
  id,
  label,
  value,
  onChange,
  error,
  disabled,
  tall,
  children,
  optional,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  disabled?: boolean;
  tall: boolean;
  children?: ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-semibold">
        {label}
        {optional ? <span className="font-normal text-ink-500"> (optional)</span> : null}
      </label>
      <div
        className={`flex items-center rounded-[10px] border-[1.5px] bg-white px-3 transition-colors focus-within:border-ink-950 ${tall ? 'h-12' : 'h-[46px]'} ${error === undefined ? 'border-line-300' : 'border-red-700'}`}
      >
        <span className="font-mono text-ink-500">$</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-help`}
          onChange={(event) => onChange(event.target.value)}
          className={`tnum w-full border-0 bg-transparent pl-1.5 font-mono outline-none disabled:text-ink-400 ${tall ? 'text-[17px]' : 'text-base'}`}
        />
      </div>
      {children}
    </div>
  );
}

/**
 * The limits form (design spec §10.4, §10.12): live validation, all four fields sent together,
 * facilitator issues mapped back to the fields.
 */
export function LimitsForm({
  variant,
  saved,
  usage,
}: {
  variant: 'onboarding' | 'settings';
  saved: SavedCaps;
  usage?: { spentToday: number; spentTotal: number; notYetCharged: number } | undefined;
}) {
  const router = useRouter();
  const toast = useToast();
  const initial = useMemo(() => capsToInput(saved), [saved]);
  const [input, setInput] = useState<CapsInput>(initial);
  const [serverErrors, setServerErrors] = useState<Partial<Record<CapsField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const result = validateCaps(input);
  const errors = { ...serverErrors, ...(result.ok ? {} : result.errors) };
  const tall = variant === 'onboarding';

  const set = (field: keyof CapsInput) => (value: string | boolean) => {
    setInput((current) => ({ ...current, [field]: value }));
    setServerErrors({});
    setSavedNote(false);
  };

  const dayCents = parseDollars(input.daily);
  const autoCents = parseDollars(input.autoCharge);
  const dayText = typeof dayCents === 'number' ? formatUsd(dayCents) : '$—';
  const autoText = typeof autoCents === 'number' ? formatUsd(autoCents) : '$—';

  const save = async () => {
    if (!result.ok || busy) return;
    setBusy(true);
    const res = await callApi<{ caps: SavedCaps }>('/api/operator/caps', result.caps, 'PUT');
    setBusy(false);
    if (!res.ok) {
      if (handleEnded(res)) return;
      const issues = Array.isArray(res.body['issues']) ? (res.body['issues'] as { path: string; message: string }[]) : [];
      if (res.error === 'validation_failed' && issues.length > 0) setServerErrors(issuesToFields(issues));
      else toast({ text: res.message, icon: 'error' });
      return;
    }
    if (variant === 'onboarding') {
      router.push('/app/onboarding/agent');
      return;
    }
    setSavedNote(true);
    toast({ text: 'Limits saved' });
    router.refresh();
  };

  const preview =
    variant === 'onboarding' ? (
      <div className="flex items-start gap-3.5 rounded-[14px] bg-ink-950 p-5 text-dark-text">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2BE38A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 flex-none">
          <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
        <p className="m-0 text-base">
          Your agents can spend up to <strong className="font-mono text-meter-400">{dayText}</strong> a day. We charge your PayPal account when unpaid
          usage nears <strong className="font-mono text-meter-400">{autoText}</strong>, and at least once a day.
        </p>
      </div>
    ) : (
      <div className="rounded-xl bg-ground-50 px-4 py-3.5 text-[15px]">
        Your agents can spend up to <strong className="font-mono">{dayText}</strong> a day. We charge your PayPal account when unpaid usage nears{' '}
        <strong className="font-mono">{autoText}</strong>, and at least once a day.
      </div>
    );

  const help = 'text-[13px] text-ink-500';
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className={
        variant === 'onboarding'
          ? 'flex flex-col gap-6 rounded-[20px] border border-line-200 bg-white p-9 max-sm:p-6'
          : 'flex flex-col gap-[18px] rounded-2xl border border-line-200 bg-white p-6'
      }
    >
      {variant === 'onboarding' ? (
        <div className="flex flex-col gap-2">
          <div className="font-mono text-[13px] text-ink-500">STEP 2 OF 3</div>
          <h1 className="m-0 text-[30px] tracking-[-0.02em]">Set spending limits</h1>
          <p className="m-0 text-base text-ink-800">Agents are refused before they can go over any of these.</p>
        </div>
      ) : (
        <h2 className="m-0 text-lg">Limits</h2>
      )}
      <div className={`grid ${variant === 'onboarding' ? 'gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]' : 'gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr))]'}`}>
        <MoneyField id="lim-call" label="Max per call" value={input.perCall} onChange={set('perCall')} error={errors.perCall} tall={tall}>
          {errors.perCall === undefined ? null : <ErrorLine text={errors.perCall} />}
          <span id="lim-call-help" className={help}>
            The highest price an agent may accept for one call. At least $0.01.
          </span>
        </MoneyField>
        <MoneyField id="lim-day" label="Daily limit" value={input.daily} onChange={set('daily')} error={errors.daily} tall={tall}>
          {errors.daily === undefined ? null : <ErrorLine text={errors.daily} />}
          <span id="lim-day-help" className={help}>
            All agents together, resets at midnight UTC.
            {usage === undefined ? null : <span className="tnum font-mono"> {formatUsd(usage.spentToday)} used today</span>}
          </span>
        </MoneyField>
        <MoneyField
          id="lim-total"
          label="Total limit"
          optional
          value={input.total}
          onChange={set('total')}
          error={errors.total}
          disabled={input.noTotal}
          tall={tall}
        >
          <label className="inline-flex min-h-7 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={input.noTotal} onChange={(event) => set('noTotal')(event.target.checked)} className="size-[18px] accent-ink-950" />
            No total limit
          </label>
          {errors.total === undefined ? null : <ErrorLine text={errors.total} />}
          <span id="lim-total-help" className={help}>
            Lifetime cap for this account. Raise it any time.
            {usage === undefined ? null : <span className="tnum font-mono"> {formatUsd(usage.spentTotal)} used</span>}
          </span>
        </MoneyField>
        <MoneyField id="lim-auto" label="Auto-charge at" value={input.autoCharge} onChange={set('autoCharge')} error={errors.autoCharge} tall={tall}>
          {errors.autoCharge === undefined ? null : <ErrorLine text={errors.autoCharge} />}
          <span id="lim-auto-help" className={help}>
            When usage not yet charged nears this amount, we charge your PayPal account. Agents pause at this amount until the charge goes through.
            {usage === undefined ? null : <span className="tnum font-mono"> {formatUsd(usage.notYetCharged)} not yet charged</span>}
          </span>
        </MoneyField>
      </div>
      {preview}
      {variant === 'onboarding' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/app/onboarding/link" className="px-1 py-3 text-ink-800">
            ← Back
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/app/onboarding/agent" className="px-1 py-3 text-sm text-ink-700">
              Skip for now
            </Link>
            {result.ok ? (
              <button type="submit" disabled={busy} className="rounded-xl border-0 bg-ink-950 px-[22px] py-3.5 text-base font-semibold text-white">
                {busy ? 'Saving…' : 'Save and continue'}
              </button>
            ) : (
              <span aria-disabled="true" className="cursor-not-allowed rounded-xl bg-line-250 px-[22px] py-3.5 text-base font-semibold text-ink-700">
                Fix the errors to continue
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          {savedNote ? (
            <span role="status" className="mr-auto text-sm font-semibold text-meter-800">
              ✓ Limits saved. Agents follow them within a minute.
            </span>
          ) : null}
          <button
            type="button"
            className="h-11 rounded-[10px] border border-line-300 bg-white px-4 font-semibold"
            onClick={() => {
              setInput(initial);
              setServerErrors({});
              setSavedNote(false);
            }}
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={!result.ok || busy}
            className="h-11 rounded-[10px] border-0 bg-ink-950 px-5 font-semibold text-white disabled:cursor-not-allowed disabled:bg-line-250 disabled:text-ink-700"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </form>
  );
}
