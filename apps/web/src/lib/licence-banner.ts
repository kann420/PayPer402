/**
 * AG Studio's licence banner in development (design spec §11.1). Without a key, Studio prints
 * about seven `console.error` lines, and the Next dev overlay counts each one as an issue. In
 * development only, those lines go to `console.info`; every other `console.error` passes through.
 * Production is untouched. The matcher is pure; `installLicenceBannerFilter` wraps the console.
 */

const BANNER_TEXT = /AG Studio|License Key|trial license|unlocked for trial|hide the watermark/i;

/** True for one line of the licence banner: an asterisk border, or a boxed line with its text. */
export function isLicenceBannerLine(args: readonly unknown[]): boolean {
  if (args.length !== 1 || typeof args[0] !== 'string') return false;
  const line = args[0].trim();
  if (/^\*{20,}$/.test(line)) return true;
  return line.length > 2 && line.startsWith('*') && line.endsWith('*') && BANNER_TEXT.test(line);
}

const INSTALLED = Symbol.for('pp402.licenceBannerFilter');

/** Wraps `console.error` once, outside production. Safe to call more than once. */
export function installLicenceBannerFilter(target: Console = console, env: string | undefined = process.env.NODE_ENV): void {
  if (env === 'production') return;
  const marked = target as Console & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  const original = target.error.bind(target);
  target.error = (...args: unknown[]) => {
    if (isLicenceBannerLine(args)) target.info(...args);
    else original(...args);
  };
  marked[INSTALLED] = true;
}
