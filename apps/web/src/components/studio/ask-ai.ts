// The "Ask AI" link between the top bar and the Studio AI panel (design spec §12.4). Kept apart from
// the Studio module, so the top bar never pulls AG Studio into a page's bundle.
import type { AgStudioApi } from 'ag-studio';

/** Fired by the top bar's "Ask AI" button; the Studio with an AI panel opens it. */
export const ASK_AI_EVENT = 'pp402:ask-ai';

/** Opens the AI panel: Studio's state first (Milestone 1 finding), then focuses its input. */
export function openAiPanel(api: AgStudioApi | undefined, host: HTMLElement | null): void {
  if (api !== undefined) {
    const state = api.getState();
    const panels = (state as { panels?: Record<string, { collapsed?: boolean }> }).panels ?? {};
    api.setState({ ...state, panels: { ...panels, ai: { ...panels['ai'], collapsed: false } } } as typeof state);
  }
  window.setTimeout(() => {
    host?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const input = host?.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type="text"]');
    input?.focus({ preventScroll: true });
  }, 150);
}
