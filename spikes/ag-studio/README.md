# Spike: AG Studio in Next.js, themed from the PayPer402 design

Question for the Phase 4 spec: how closely can the operator Overview mockup (Claude Design canvas
"PayPer402 UI Design", board `Overview.dc.html`) be rebuilt when its four chart and table frames
are AG Studio widgets and its "Ask about your spend" panel is the AG Studio AI assistant?

**Result: it works, and it gets close.** Everything outside AG Studio is ordinary React and
CSS, so it can match the mockup exactly. Inside AG Studio the theme params cover the card, the
fonts, the palette, the grid lines and the table, and a React cell renderer draws the status
badges. What differs is listed under **Fidelity**. The AI panel works in view mode with Claude
behind our own server route, but only through a cast the types do not allow.

## Run it

```bash
npm install
npm run dev -w spikes/ag-studio
```

Open http://localhost:3402. The AI assistant reads `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` from
the repo root `.env`. URL switches (spike only):

| Switch | Effect |
|---|---|
| `?mode=edit` | Opens in edit mode |
| `?ai=view` | Shows the AI panel in view mode too |
| `?agent=analyst` | One read-only agent instead of AG Studio's five dashboard-building agents |

The sample data in `app/sample-data.ts` is deterministic: 14 days ending Nov 2, 2026, three
agents and three services, about 3,000 paid calls.

## Findings

### Embedding (tested)

- Next 16.4.2 (Turbopack), React 19.3.1, `ag-studio` and `ag-studio-react` 3.0.0 pinned to the same
  version.
- One `'use client'` file. No `dynamic(..., { ssr: false })` is needed, and there is no CSS import:
  the theme injects its styles at run time.
- `next build` passes. The largest client chunk is 5.5 MB raw, 1.5 MB gzipped (AG Studio with the
  enterprise Grid and Charts it bundles). Load it only on dashboard routes.
- Studio fills its parent, so the host element needs an explicit height.
- `ai` and `initialState` are initial-only props. The spike reads the URL first and creates
  Studio afterwards.

### Theming from the design tokens (tested)

- Theme params set: the fonts (Plus Jakarta Sans for the UI, JetBrains Mono for numbers through
  per-axis label fonts), text and border colours, the card (`studioWidget*`), the title and
  subtitle, the chart palette (the design system's six colours, fills and strokes), the chart grid
  lines, and the table header and rows.
- Studio's own frame (wrapper and canvas border, background and padding) is removed with
  `studioWrapper*` and `studioCanvas*` params, so the widgets sit on the page background like the
  mockup's frames.
- `layout.widgetPadding` is the space **around** each widget, so the gap between two widgets is
  twice the value. 7 gives the design's 14px gap.
- Per-widget format: line markers off, legends off where the mockup has none, the donut total in
  the ring centre with the legend on the right, bar value labels.

### Fidelity against the mockup

| Element | Result |
|---|---|
| Sandbox banner, sidebar, top bar, KPI cards, PayPal link card, section header | Exact. These are our own React and CSS. |
| Widget card: white, 1px `#E2E4DE` border, 14px radius, 14px gap | Exact |
| Widget title and subtitle typography | Same fonts and sizes. The subtitle sits under the title, not right-aligned in the header row, and the header has no divider line. |
| Spend per day | Same colour, mono axis labels and grid. No area fill under the line: there is no fill-opacity param, and making palette fill 1 translucent would also fade the bars. The y axis shows `5`, not `$5`. |
| Spend per agent | Horizontal bars with mono labels and value labels. All bars are one colour. Colouring each agent needs `legendKey`, which turns the bars into thin grouped slots. |
| Spend per service | Close: donut, total in the centre, legend on the right in the sans face. The legend has no percentages. |
| Recent paid calls | Status pills, mono time, agent and price cells, and uppercase muted headers all work. Column auto-size measures the plain text, so the mono time column truncates (`10:42:…`). Needs a fixed width or a smaller cell font. With the AI panel open the table is narrower and the price column clips. The endpoint sub-line under the service name is not done. |
| "Ask about your spend" panel | AG Studio's own panel UI: header "AI Assistant", a "New chat" thread picker, starter chips, and an input with a Send button. It sits inside Studio, beside the widget grid, not as a full-height column beside the whole page. The header and placeholder text can be renamed through `localeText`. |

### Grid widget

- Swapping the grid widget's component for `GridWidget` from `ag-studio-react` and returning a
  React component from `options.createCellRenderer` works. That is how the status badges are drawn.
- Per the docs (not tested here), columns without aggregation group by their values, so identical
  rows would merge. The real table should include a unique column such as the commitment id.

### AI assistant (tested with Claude Sonnet 5.5)

- **Panel placement.** The types allow the `ai` panel only in edit mode
  (`AgViewModePanelType = 'filters'`). At run time, `panels.view.right = ['ai']` cast past the type
  renders it in view mode, and it works. This is unsupported: the fallback is edit mode with only
  the AI panel listed.
- **Adapter.** The browser adapter posts each `AgLlmRequest` to `POST /api/ai/turn`. The route
  calls the Messages API the way `apps/agent` does: beta client, `fallbacks: 'default'`, effort
  `medium`, model from `ANTHROPIC_MODEL`. The route is non-streaming. The adapter replays the
  finished turn as AG-UI events, and Studio takes the tool calls to run from `complete.output`.
  The key never reaches the browser.
- **History handling in the route.**
  - AG Studio's history cannot carry Claude's thinking blocks. The route caches each Claude turn
    by message id and replays the original blocks, so the history stays append-only.
  - It sanitises Studio's `<runId>-preflight-N` tool-call ids.
  - Forced `toolChoice` becomes a prompt instruction, because forced tool choice is a 400 on
    current models.
  - When the conversation ends on an assistant turn (a delegated run), the route adds a short user
    nudge instead of sending a prefill.
  - The replay is checked: the route logs how many cached turns each request replays. A
    five-turn question on the production build logged 0, 1, 2, 3 and 4, so every earlier Claude
    turn went back with its original blocks.
- **Runs.** On the dev server, three questions took 18 turns. Every turn returned 200, in 0.9 to 2.7
  seconds. A fourth question on the production build ("Which service earned the most on Nov 1,
  and what share of that day's spend was it?") took 5 turns and used the right day total ($8.10).

  | Question | Agents | Turns | Result |
  |---|---|---|---|
  | "Which agent spent the most in the last 14 days, and how much?" | Default, five agents | 6 (about 13 s) | Correct, matches the bar chart |
  | "Add a column chart showing total spend by status." | Default, five agents | about 9 | Added and configured the widget |
  | "How much is not yet charged, and across how many paid calls?" | Read-only `analyst` | 3 (about 5 s) | Correct. Gave the dollar sign once the data source had a description saying amounts are USD. |

- The read-only agent is a `directLlmRunner` with only `viewSchema`, `viewReport`, `viewPage`,
  `viewWidget` and `executeQuery`. Nothing in Studio's AI service checks the mode, so a view-mode
  assistant must not be given the write tools.

### Licence

- With no key, every feature works, AI included. Studio logs a "License Key Not Found" banner with
  `console.error`; in dev, Strict Mode mounts it twice.
- No watermark appears on localhost. Per the package source (not checked in a browser), a
  "For Trial Use Only" watermark shows on other hosts and fades out after about 5 seconds.

## Open for the spec

- Streaming turns, so the panel types as Claude writes.
- Auth, rate limit, body-size cap and a cost cap on the AI route before it is public.
- The turn cache is in-process memory. After a restart the route rebuilds earlier turns from AG
  Studio's history without their thinking blocks. That fallback was not exercised.
- An "Ask AI" top-bar button that opens and closes the panel (`initialState.panels.ai.collapsed`,
  or the API). Not tried.
- Widget toolbars in view mode (CSV export, PNG download) and their `createWidgets` overrides. Not
  checked.
- The `$` on the value axis, the per-agent bar colours, and the table column widths (see
  **Fidelity**).
