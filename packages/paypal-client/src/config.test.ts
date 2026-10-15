import { describe, expect, it } from 'vitest';
import { SANDBOX_API_BASE, resolveApiBase } from './config';

describe('resolveApiBase', () => {
  it('defaults to the sandbox host', () => {
    expect(resolveApiBase()).toBe(SANDBOX_API_BASE);
    expect(resolveApiBase('')).toBe(SANDBOX_API_BASE);
  });

  it('accepts the sandbox host with a trailing slash', () => {
    expect(resolveApiBase(`${SANDBOX_API_BASE}/`)).toBe(SANDBOX_API_BASE);
  });

  it('accepts a localhost mock', () => {
    expect(resolveApiBase('http://localhost:4010')).toBe('http://localhost:4010');
    expect(resolveApiBase('http://127.0.0.1:4010/')).toBe('http://127.0.0.1:4010');
  });

  it('refuses the live host and anything else', () => {
    expect(() => resolveApiBase('https://api-m.paypal.com')).toThrow(/Refusing/);
    expect(() => resolveApiBase('https://api-m.sandbox.paypal.com.evil.test')).toThrow(/Refusing/);
    expect(() => resolveApiBase('http://localhost.evil.test')).toThrow(/Refusing/);
  });
});
