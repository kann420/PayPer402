/**
 * The live run's light/dark choice (design spec §10.10), remembered per browser. Light is the
 * default. The root layout runs `RUN_THEME_SCRIPT` before the first paint, and the toggle keeps
 * <html data-run-theme> and the stored value in step. Storage access is always in try/catch.
 */

export const RUN_THEME_KEY = 'pp402.liveRunTheme';
export type RunTheme = 'light' | 'dark';

export function parseRunTheme(value: string | null | undefined): RunTheme {
  return value === 'dark' ? 'dark' : 'light';
}

export function readRunTheme(storage: Pick<Storage, 'getItem'> | undefined): RunTheme {
  try {
    return parseRunTheme(storage?.getItem(RUN_THEME_KEY));
  } catch {
    return 'light';
  }
}

export function writeRunTheme(storage: Pick<Storage, 'setItem'> | undefined, theme: RunTheme): void {
  try {
    storage?.setItem(RUN_THEME_KEY, theme);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

/** Inline, before paint: only a stored "dark" changes anything. */
export const RUN_THEME_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(RUN_THEME_KEY)})==='dark')document.documentElement.setAttribute('data-run-theme','dark')}catch(e){}`;
