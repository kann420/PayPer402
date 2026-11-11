/**
 * Builds the `payper402` npm package into `apps/agent/dist/npm`, ready for `npm publish`.
 *
 * The workspace sources (this app and `@payper402/scheme-paypal`) are bundled into one file, so the
 * package needs no clone and no `tsx`. Third-party packages stay normal dependencies. The bundle
 * defaults `--api` to the hosted facilitator and calls itself `npx payper402`.
 *
 *   npm run build:npm -w apps/agent                     # hosted facilitator by default
 *   PAYPER402_NPM_API=https://pay.example.test npm run build:npm -w apps/agent
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(APP, '../..');
const OUT = path.join(APP, 'dist/npm');
const HOSTED_API = 'https://api.payper402.xyz';
const WEB = 'https://payper402.xyz';
const REPO = 'https://github.com/kann420/PayPer402';

/** The third-party packages the bundle imports; versions come from `apps/agent/package.json`. */
const RUNTIME_DEPS = ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk', '@typesafe-ai/sdk', '@x402/core', 'zod'];

function httpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`PAYPER402_NPM_API must be https (or localhost): ${value}`);
  }
  return value.replace(/\/+$/, '');
}

const api = httpsUrl(process.env['PAYPER402_NPM_API']?.trim() || HOSTED_API);
const app = JSON.parse(await readFile(path.join(APP, 'package.json'), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'bin'), { recursive: true });

const result = await build({
  stdin: { contents: "import { main } from './payper402';\nawait main();\n", resolveDir: path.join(APP, 'src'), loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(OUT, 'bin/payper402.mjs'),
  banner: { js: '#!/usr/bin/env node' },
  define: { __PAYPER402_NPM_API__: JSON.stringify(api) },
  metafile: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'external-third-party',
      setup(b) {
        // Bare imports stay external, except the workspace packages, which are bundled.
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@payper402/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});

// Every external import must be a node built-in or a declared dependency.
const externals = new Set<string>();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) if (imported.external) externals.add(imported.path);
}
const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
const undeclared = [...externals].filter((spec) => !spec.startsWith('node:') && !RUNTIME_DEPS.includes(packageOf(spec)));
if (undeclared.length > 0) throw new Error(`The bundle imports undeclared packages: ${undeclared.join(', ')}`);

const dependencies = Object.fromEntries(
  RUNTIME_DEPS.map((name) => {
    const range = app.dependencies[name];
    if (range === undefined) throw new Error(`${name} is missing from apps/agent/package.json`);
    return [name, range];
  }),
);

const pkg = {
  name: 'payper402',
  version: app.version,
  description: 'Pay-per-call for AI agents over HTTP 402, settled with PayPal. Connect an agent, check its limits, and let Claude Code pay per call over MCP.',
  license: 'MIT',
  type: 'module',
  bin: { payper402: 'bin/payper402.mjs' },
  files: ['bin', 'README.md', 'LICENSE'],
  engines: { node: '>=22' },
  repository: { type: 'git', url: `git+${REPO}.git` },
  homepage: REPO,
  keywords: ['x402', 'http-402', 'ai-agents', 'mcp', 'micropayments', 'paypal', 'claude'],
  dependencies,
};
await writeFile(path.join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
await copyFile(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
await writeFile(
  path.join(OUT, 'README.md'),
  `# payper402

Pay-per-call for AI agents, settled with PayPal (sandbox). This is the terminal command of
[PayPer402](${REPO}): it connects an agent to your PayPer402 account, shows what it may spend, and
lets Claude Code pay for APIs per call over MCP.

Requires Node.js 22 or later.

## Connect an agent

1. Open the PayPer402 web app (the hosted demo is [${WEB}](${WEB})), sign in and link PayPal.
2. Go to **Agents → New agent → Connect from a terminal**. The app shows a one-time claim code,
   valid for 15 minutes, inside a ready-made command.
3. Copy that command and run it on the agent's machine. It looks like this, with your own code:

\`\`\`bash
npx -y payper402 onboard --claim <your-claim-code>
\`\`\`

Running it again with a new claim code switches this machine to the new agent; the previous
config is moved aside, not deleted.

The agent's Ed25519 key is generated on this machine and saved in \`~/.payper402/config.json\`
(\`PAYPER402_HOME\` changes the folder). Only the public key is sent. Treat the file like a \`.env\`.

By default it connects to \`${api}\`. Pass \`--api <url>\` for another facilitator.

## Use it

\`\`\`bash
npx payper402 status
\`\`\`

Let Claude Code pay per call (optional):

\`\`\`bash
claude mcp add -s user payper402 -- npx -y payper402 mcp
\`\`\`

On Windows (not WSL):

\`\`\`bash
claude mcp add -s user payper402 -- cmd /c npx -y payper402 mcp
\`\`\`

Run the built-in Claude agent on a task (needs \`ANTHROPIC_API_KEY\`):

\`\`\`bash
npx payper402 run --budget 0.50 "Find a quiet hotel in Kyoto near Gion for March 30 to April 2, 2027"
\`\`\`

Spending is always bounded by the limits the operator set in the web app.

## License

MIT
`,
);

console.log(`Built payper402@${app.version} in ${path.relative(ROOT, OUT)} (default API ${api}).`);
