'use client';

import { CodeBlock } from '../ui/code';
import { useToast } from '../ui/toast';

/** What the claim route returns (operator-cli.md §8.2). */
export type ClaimInfo = {
  claim: { code: string; name: string; expiresAt: number };
  command: string;
};

const MCP_COMMAND = 'claude mcp add -s user payper402 -- npx -y payper402 mcp';
const MCP_COMMAND_WINDOWS = 'claude mcp add -s user payper402 -- cmd /c npx -y payper402 mcp';
const KBTN = 'inline-flex min-h-11 items-center gap-2 rounded-[10px] px-4 py-[11px] font-semibold';

/** "Connect from a terminal" (operator-cli.md §8.3): the command to run on the agent's machine. */
export function ClaimPanel({ info }: { info: ClaimInfo }) {
  const toast = useToast();
  const repo = process.env['NEXT_PUBLIC_REPO_URL']?.trim();
  const expires = new Date(info.claim.expiresAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <>
      <div className="flex flex-col gap-3">
        <strong className="text-[15px]">Run this on the agent&apos;s machine</strong>
        <p className="m-0 text-sm text-ink-700">
          One command, nothing to install first: it needs Node.js 22 or later. In Windows PowerShell, use <code>npx.cmd</code> instead of{' '}
          <code>npx</code>.
        </p>
        <CodeBlock label="Command to run on the agent's machine">{info.command}</CodeBlock>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={`${KBTN} border-0 bg-ink-950 text-white`}
            onClick={() => {
              void navigator.clipboard
                .writeText(info.command)
                .then(() => toast({ text: 'Command copied', icon: 'copy' }))
                .catch(() => toast({ text: "Couldn't copy. Select the command and copy it.", icon: 'error' }));
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
            </svg>
            Copy
          </button>
          <span className="font-mono text-[13px] text-ink-500">
            Code {info.claim.code} · expires at {expires} (15 minutes)
          </span>
        </div>
        <p className="m-0 text-sm text-ink-700">The agent creates its own key. PayPer402 only receives the public key.</p>
      </div>
      <div className="flex flex-col gap-2">
        <strong className="text-[15px]">Optional: let Claude Code pay per call</strong>
        <p className="m-0 text-sm text-ink-700">After the agent is connected, add its tools to Claude Code. macOS and Linux:</p>
        <CodeBlock size={12.5} label="Add the payper402 tools to Claude Code on macOS and Linux">
          {MCP_COMMAND}
        </CodeBlock>
        <p className="m-0 text-sm text-ink-700">Windows:</p>
        <CodeBlock size={12.5} label="Add the payper402 tools to Claude Code on Windows">
          {MCP_COMMAND_WINDOWS}
        </CodeBlock>
        <p className="m-0 text-sm text-ink-700">
          Then Claude Code can pay for APIs within your limits. Check the agent any time with <code>npx payper402 status</code>.
        </p>
      </div>
      {repo !== undefined && repo !== '' && (
        <a href={`${repo.replace(/\/+$/, '')}#connect-your-own-agent-from-a-terminal`} target="_blank" rel="noreferrer" className="text-sm font-semibold">
          More about the payper402 command
        </a>
      )}
    </>
  );
}
