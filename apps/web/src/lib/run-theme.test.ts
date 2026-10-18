import { describe, expect, it } from 'vitest';
import { parseRunTheme, readRunTheme, RUN_THEME_KEY, RUN_THEME_SCRIPT, writeRunTheme } from './run-theme';

describe('live run theme', () => {
  it('defaults to light, and only "dark" is dark', () => {
    expect(parseRunTheme(null)).toBe('light');
    expect(parseRunTheme('dark')).toBe('dark');
    expect(parseRunTheme('DARK')).toBe('light');
    expect(readRunTheme(undefined)).toBe('light');
  });

  it('survives storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRunTheme(throwing)).toBe('light');
    expect(() => writeRunTheme(throwing, 'dark')).not.toThrow();
  });

  it('round-trips through storage under its key', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    writeRunTheme(storage, 'dark');
    expect(map.get('pp402.liveRunTheme')).toBe('dark');
    expect(readRunTheme(storage)).toBe('dark');
  });

  it('has a pre-paint script that reads the same key inside try/catch', () => {
    expect(RUN_THEME_KEY).toBe('pp402.liveRunTheme');
    expect(RUN_THEME_SCRIPT).toContain('"pp402.liveRunTheme"');
    expect(RUN_THEME_SCRIPT.startsWith('try{')).toBe(true);
    expect(RUN_THEME_SCRIPT).toContain("setAttribute('data-run-theme','dark')");
  });
});
