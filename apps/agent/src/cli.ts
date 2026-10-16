import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from './agent';
import { CatalogError } from './catalog';
import { ConfigError, loadAgentConfig } from './config';
import { formatEvent, formatReport } from './format';
import { openSession } from './session';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  /** Defaults to `new Anthropic()`, which resolves credentials itself. */
  anthropic?: Anthropic;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * The agent CLI (design spec §7). Returns the exit code: 0 when the run completed, 1 otherwise.
 * Configuration errors print a message and no secrets.
 */
export async function runCli(argv: string[], env: Record<string, string | undefined>, io: CliIo, deps: CliDeps = {}): Promise<number> {
  let config;
  try {
    config = loadAgentConfig(env, argv);
  } catch (err) {
    io.err(err instanceof ConfigError ? err.message : 'Invalid configuration');
    return 1;
  }
  let session;
  try {
    session = await openSession({
      sellerUrl: config.sellerUrl,
      privateKey: config.privateKey,
      budgetCents: config.budgetCents,
      maxPerCallCents: config.maxPerCallCents,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      onEvent: (event) => {
        if (event.type !== 'result') io.out(formatEvent(event));
      },
    });
  } catch (err) {
    io.err(err instanceof CatalogError ? err.message : 'Could not open the session');
    return 1;
  }
  const result = await runAgent({
    task: config.task,
    session,
    anthropic: deps.anthropic ?? new Anthropic(),
    model: config.model,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  io.out(`[result] ${result.status}`);
  io.out('');
  io.out(result.answer === '' ? '(no answer)' : result.answer);
  io.out('');
  io.out(formatReport(result.report));
  return result.status === 'completed' ? 0 : 1;
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('/src/cli.ts')) {
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  runCli(
    process.argv.slice(2),
    process.env,
    { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) },
    { signal: abort.signal },
  )
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('The agent failed unexpectedly\n');
      process.exitCode = 1;
    });
}
