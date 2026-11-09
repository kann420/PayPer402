#!/usr/bin/env node
// Registers tsx's ESM loader, because the workspace sources use extensionless imports that plain
// Node cannot resolve, then runs the command. It prints nothing itself: `payper402 mcp` keeps
// stdout clean for the protocol. `tsx` resolves from the repository's node_modules.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/payper402.ts');
await main();
