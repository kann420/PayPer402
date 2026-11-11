import { describe, expect, it } from 'vitest';
import { exportPrivateKeyRaw, generateAgentKey } from '@payper402/scheme-paypal';
import { decisionLayerWant, loadAgentConfig, parseCliArgs } from './config';

const raw = exportPrivateKeyRaw(generateAgentKey().privateKey);

describe('decision-layer configuration', () => {
  it('parses --no-spend-check', () => {
    expect(parseCliArgs(['--no-spend-check', 'task']).values['no-spend-check']).toBe(true);
    expect(parseCliArgs(['task']).values['no-spend-check']).toBeUndefined();
  });

  it('still rejects an unknown flag', () => {
    expect(() => loadAgentConfig({ AGENT_PRIVATE_KEY: raw }, ['--no-spend-checks'])).toThrow("Unknown option '--no-spend-checks'");
  });

  it('wants the layer with a key, trimmed; the flag wins over a missing key', () => {
    expect(loadAgentConfig({ AGENT_PRIVATE_KEY: raw, TYPESAFE_API_KEY: ' k-1 ' }).decisionLayer).toEqual({ want: true, apiKey: 'k-1' });
    expect(loadAgentConfig({ AGENT_PRIVATE_KEY: raw, TYPESAFE_API_KEY: 'k-1' }, ['--no-spend-check']).decisionLayer).toEqual({
      want: false,
      reason: '--no-spend-check',
    });
    expect(loadAgentConfig({ AGENT_PRIVATE_KEY: raw }, ['--no-spend-check']).decisionLayer).toEqual({ want: false, reason: '--no-spend-check' });
    expect(loadAgentConfig({ AGENT_PRIVATE_KEY: raw, TYPESAFE_API_KEY: ' \t' }).decisionLayer).toEqual({ want: false, reason: 'no TYPESAFE_API_KEY' });
    expect(decisionLayerWant({}, false)).toEqual({ want: false, reason: 'no TYPESAFE_API_KEY' });
  });

  it('the MCP form, loadAgentConfig(env, []), reports want: true with a key (the MCP entry ignores it)', () => {
    expect(loadAgentConfig({ AGENT_PRIVATE_KEY: raw, TYPESAFE_API_KEY: 'k-1' }, []).decisionLayer.want).toBe(true);
  });

  it('the --no-spend-check flag does not leak into the task', () => {
    expect(loadAgentConfig({ AGENT_PRIVATE_KEY: raw }, ['--no-spend-check', 'What', 'is', 'Kyoto?']).task).toBe('What is Kyoto?');
  });
});
