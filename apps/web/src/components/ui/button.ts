/** Button styles from the DesignSystem board, as class strings for buttons and links. */
const base = 'inline-flex items-center justify-center gap-2 font-semibold no-underline whitespace-nowrap disabled:cursor-not-allowed';

export const btn = {
  primary: `${base} h-11 rounded-[10px] border-0 bg-ink-950 px-[18px] text-white hover:text-white disabled:bg-line-300`,
  accent: `${base} h-11 rounded-[10px] border-0 bg-meter-400 px-[18px] text-ink-950 hover:text-ink-950 disabled:opacity-60`,
  secondary: `${base} h-11 rounded-[10px] border-[1.5px] border-ink-950 bg-white px-[18px] text-ink-950 hover:text-ink-950 disabled:border-line-200 disabled:text-ink-400`,
  ghost: `${base} h-11 rounded-[10px] border border-line-300 bg-white px-4 text-ink-950 hover:text-ink-950 disabled:text-ink-400`,
  destructive: `${base} h-11 rounded-[10px] border-[1.5px] border-red-700 bg-white px-[18px] text-red-700 hover:text-red-700 disabled:border-line-200 disabled:text-ink-400`,
  small: `${base} h-[30px] rounded-lg border border-ink-950 bg-white px-2.5 text-xs font-bold text-ink-950 disabled:border-line-200 disabled:bg-ground-50 disabled:text-ink-400`,
  /** The boards' small `.ghost` button. */
  ghostSm: `${base} h-9 rounded-lg border border-line-300 bg-white px-3 text-[13px] font-normal text-ink-950 hover:text-ink-950 disabled:text-ink-400`,
  ghostSmOn: `${base} h-9 rounded-lg border border-ink-950 bg-ink-950 px-3 text-[13px] font-normal text-white hover:text-white`,
  link: 'border-0 bg-transparent p-0 font-semibold text-meter-700 hover:text-meter-800',
} as const;
