'use client';

import { useState } from 'react';
import { errorCopy } from '@/lib/copy';
import { agentNameError, envFile, jwkFile } from '@/lib/key-files';
import { callApi, handleEnded } from '../shell/session-client';
import { AgentSnippet, EnvSnippet } from '../ui/code';
import type { ClaimInfo } from './claim-panel';
import { useToast } from '../ui/toast';

export interface CreatedKey {
  agent: { id: string; name: string; keyFingerprint: string };
  key: { seed: string; jwk: { kty: string; crv: string; x: string; d: string }; fingerprint: string };
}

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const KBTN = 'inline-flex min-h-11 items-center gap-2 rounded-[10px] px-4 py-[11px] font-semibold';

/** The key, shown once (design spec §10.5): copy, `.env` and JWK downloads, and the snippets. */
export function KeyPanel({ created }: { created: CreatedKey }) {
  const toast = useToast();
  const { agent, key } = created;
  return (
    <>
      <div className="overflow-hidden rounded-2xl border-[1.5px] border-ink-950">
        <div role="alert" className="flex items-center gap-2.5 bg-amber-100 px-4 py-3 text-sm font-semibold text-amber-800">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3 2 20h20z" />
            <path d="M12 10v4M12 17h.01" />
          </svg>
          You won&apos;t see this again. Store the key somewhere safe.
        </div>
        <div className="flex flex-col gap-3.5 px-4 py-[18px]">
          <div className="flex flex-wrap justify-between gap-2.5 text-[13px] text-ink-500">
            <span>Agent private key · {agent.name}</span>
            <span className="font-mono">{key.fingerprint}</span>
          </div>
          <code className="block rounded-[10px] bg-ground-50 p-3.5 font-mono text-sm break-all">{key.seed}</code>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              className={`${KBTN} border-0 bg-ink-950 text-white`}
              onClick={() => {
                void navigator.clipboard
                  .writeText(key.seed)
                  .then(() => toast({ text: 'Key copied', icon: 'copy' }))
                  .catch(() => toast({ text: "Couldn't copy. Select the key and copy it.", icon: 'error' }));
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="8" y="8" width="12" height="12" rx="2" />
                <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
              </svg>
              Copy
            </button>
            <button type="button" className={`${KBTN} border-[1.5px] border-line-300 bg-white text-ink-950`} onClick={() => download(`${agent.name}.env`, envFile(agent.name, key.seed), 'text/plain')}>
              <DownloadIcon />
              Download .env
            </button>
            <button
              type="button"
              className={`${KBTN} border-[1.5px] border-line-300 bg-white text-ink-950`}
              onClick={() => download(`${agent.name}.jwk.json`, jwkFile(key.jwk), 'application/json')}
            >
              <DownloadIcon />
              Download key (JWK)
            </button>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <strong className="text-[15px]">Give your agent this environment variable</strong>
        <EnvSnippet name={agent.name} seed={key.seed} />
      </div>
      <div className="flex flex-col gap-2">
        <strong className="text-[15px]">Use it in your agent</strong>
        <AgentSnippet />
      </div>
      <p className="m-0 text-sm text-ink-700">This browser keeps the key so you can run the agent here. Clear the session to forget it.</p>
    </>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v12M6 11l6 6 6-6M4 20h16" />
    </svg>
  );
}

/**
 * Step one: the name field and "Create agent" (design spec §10.5, §10.8). With `onClaim`, a second
 * button, "Connect from a terminal", asks for a claim code instead (operator-cli.md §8.3).
 */
export function AgentNameForm({
  initialName = '',
  onCreated,
  onClaim,
}: {
  initialName?: string;
  onCreated: (created: CreatedKey) => void;
  onClaim?: (info: ClaimInfo) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initialName);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const error = touched || name !== '' ? agentNameError(name) : undefined;

  /** Validates the name, posts it, and maps a failure to the field or a toast. */
  const submit = async <T extends Record<string, unknown>>(path: string, done: (res: { ok: true } & T) => void) => {
    setTouched(true);
    if (agentNameError(name) !== undefined || busy) return;
    setBusy(true);
    setServerError(undefined);
    const res = await callApi<T>(path, { name });
    setBusy(false);
    if (!res.ok) {
      if (handleEnded(res)) return;
      if (res.error === 'validation_failed') setServerError(res.message);
      else toast({ text: errorCopy(res.error, res.message), icon: 'error' });
      return;
    }
    done(res);
  };
  const create = () =>
    submit<{ agent: CreatedKey['agent']; key: CreatedKey['key'] }>('/api/operator/agents', (res) => onCreated({ agent: res.agent, key: res.key }));
  const claim = () => submit<ClaimInfo>('/api/operator/agents/claims', (res) => onClaim?.({ claim: res.claim, command: res.command }));

  const shown = serverError ?? error;
  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <div className="flex w-full max-w-[360px] flex-col gap-1.5">
        <label htmlFor="ag-name" className="font-semibold">
          Agent name
        </label>
        <input
          id="ag-name"
          data-autofocus
          value={name}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={shown !== undefined}
          aria-describedby="ag-name-help"
          onChange={(event) => {
            setName(event.target.value);
            setServerError(undefined);
          }}
          onBlur={() => setTouched(true)}
          className={`h-12 rounded-[10px] border-[1.5px] px-3 font-mono text-base outline-none focus:border-ink-950 ${shown === undefined ? 'border-line-300' : 'border-red-700'}`}
        />
        <span id="ag-name-help" className={shown === undefined ? 'text-[13px] text-ink-500' : 'text-[13px] font-semibold text-red-700'} role={shown === undefined ? undefined : 'alert'}>
          {shown ?? 'Lowercase letters, digits and dashes, for example trip-planner.'}
        </span>
      </div>
      <button type="submit" disabled={busy} className="mb-6 h-12 rounded-[10px] border-0 bg-ink-950 px-[18px] font-semibold text-white disabled:opacity-70">
        {busy ? 'Creating…' : 'Create agent'}
      </button>
      {onClaim !== undefined && (
        <div className="w-full">
          <button
            type="button"
            disabled={busy}
            onClick={() => void claim()}
            className="h-12 rounded-[10px] border-[1.5px] border-ink-950 bg-white px-[18px] font-semibold text-ink-950 disabled:opacity-70"
          >
            Connect from a terminal
          </button>
        </div>
      )}
    </form>
  );
}
