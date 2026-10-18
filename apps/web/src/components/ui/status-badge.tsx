import { TONES, type StatusEntry } from '@/lib/status';

/** The one way to show a status (design spec §8.4): colour, glyph and label together. */
export function StatusBadge({ entry, tooltip, size = 'md' }: { entry: StatusEntry; tooltip?: string | undefined; size?: 'md' | 'sm' }) {
  const tone = TONES[entry.tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold leading-normal ${size === 'sm' ? 'px-2 py-px text-[11px]' : 'px-2.5 py-[3px] text-xs'}`}
      style={{ background: tone.background, color: tone.ink }}
      title={tooltip}
    >
      <span aria-hidden="true">{entry.glyph}</span>
      {entry.label}
      {tooltip === undefined ? null : <span className="sr-only">: {tooltip}</span>}
    </span>
  );
}
