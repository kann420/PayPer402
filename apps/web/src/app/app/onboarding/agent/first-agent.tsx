'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AgentNameForm, KeyPanel, type CreatedKey } from '@/components/agents/agent-creator';

/** Onboarding step 3: the name, then the key shown once (design spec §10.5). */
export function FirstAgent() {
  const [created, setCreated] = useState<CreatedKey | null>(null);
  return (
    <section className="pg-enter flex flex-col gap-[22px] rounded-[20px] border border-line-200 bg-white p-9 max-sm:p-6">
      <div className="flex flex-col gap-2">
        <div className="font-mono text-[13px] text-ink-500">STEP 3 OF 3</div>
        <h1 className="m-0 text-[30px] tracking-[-0.02em]">Create your first agent</h1>
        <p className="m-0 text-ink-800">Each agent gets its own key. Budgets are set per run, when you start the agent.</p>
      </div>
      {created === null ? <AgentNameForm initialName="research-bot" onCreated={setCreated} /> : <KeyPanel created={created} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/app/onboarding/limits" className="px-1 py-3 text-ink-800">
          ← Back
        </Link>
        {created === null ? (
          <Link href="/app" className="px-1 py-3 text-sm text-ink-700">
            Skip for now
          </Link>
        ) : (
          <Link
            href={`/app/onboarding/done?agent=${encodeURIComponent(created.agent.name)}`}
            className="rounded-xl bg-ink-950 px-[22px] py-3.5 text-base font-semibold text-white hover:text-white"
          >
            I saved the key
          </Link>
        )}
      </div>
    </section>
  );
}
