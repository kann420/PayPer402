/**
 * AG Studio configuration as plain data (design spec §11): the `paid_calls` fields, the widget
 * states of each screen, the theme parameters, and the AI assistant text. Pure, so it is shared by
 * the client module and tested without a DOM.
 */
import type { AgFieldDefinition, AgReportState } from 'ag-studio';

/** One paid call, as AG Studio sees it (design spec §11.2). */
export interface PaidCallRow {
  id: string;
  /** `YYYY-MM-DDTHH:MM:SS`, UTC, no zone. */
  time: string;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  agent: string;
  service: string;
  endpoint: string;
  /** The path without its query, for example `/v1/quote`: one bar per endpoint in the seller chart. */
  path: string;
  /** USD. */
  price: number;
  /** The status label (design spec §8.4). */
  status: string;
  /** Short settlement id, or ''. */
  charge: string;
}

export type StudioKind = 'overview' | 'agent' | 'charge' | 'seller';
export type AiScope = 'operator' | 'seller';

/** The design system's chart palette, light theme, in order (design spec §8.1). */
export const PALETTE = ['#0E9F5C', '#7C5CFF', '#F59E0B', '#0EA5A4', '#E5487D', '#64748B'] as const;

export const SOURCE_ID = 'paid_calls';

export const MONO_FIELDS: ReadonlySet<string> = new Set(['time', 'agent', 'price', 'endpoint', 'path', 'charge', 'id']);

export function fieldDefinitions(scope: AiScope): AgFieldDefinition[] {
  return [
    { id: 'id', name: 'Paid call', format: 'textFormat' },
    { id: 'time', name: 'Time', format: 'dateTimeFormat', formatOptions: { format: 'mmm d, hh:mm:ss' } },
    { id: 'day', name: 'Day', format: 'dateFormat', formatOptions: { format: 'mmm d' } },
    { id: 'agent', name: scope === 'seller' ? 'Agent reference' : 'Agent', format: 'textFormat' },
    { id: 'service', name: 'Service', format: 'textFormat' },
    { id: 'endpoint', name: 'Endpoint', format: 'textFormat' },
    { id: 'path', name: 'Path', format: 'textFormat' },
    { id: 'price', name: 'Price', format: 'currencyFormat', formatOptions: { format: '$#,##0.00' } },
    { id: 'status', name: 'Status', format: 'textFormat' },
    { id: 'charge', name: 'Charge', format: 'textFormat' },
  ];
}

export const DATA_DESCRIPTION: Record<AiScope, string> = {
  operator: 'Paid API calls made by AI agents. Every amount is in US dollars (USD); show it with a $ sign. Times are UTC.',
  seller:
    'Revenue from paid API calls made by AI agents to your endpoints. Every amount is in US dollars (USD); show it with a $ sign. ' +
    'Agents appear as agent references. Times are UTC.',
};

export const SOURCE_DESCRIPTION: Record<AiScope, string> = {
  operator: 'One row per paid call. price is the USD price of that call; status says whether it is charged yet.',
  seller:
    'One row per paid call to your API. price is the USD revenue of that call; agent is an agent reference; status says whether it is charged yet.',
};

export interface AiText {
  title: string;
  placeholder: string;
  agentName: string;
  starters: string[];
  instructions: string;
}

/**
 * The analyst's instructions (design spec §12.3, "Query reliability"): the field ids, and which
 * aggregations Studio's query tool accepts per field type, so queries validate the first time.
 */
function instructions(scope: AiScope): string {
  const agent = scope === 'seller' ? 'paid_calls.agent (text, an agent reference)' : 'paid_calls.agent (text, the agent name)';
  return [
    'You answer questions about this dashboard by querying its data with execute_query. Amounts are USD. Times are UTC. Do not change the dashboard.',
    `The data source is paid_calls, one row per paid call. Field ids: paid_calls.time (datetime, UTC), paid_calls.day (date: the call's UTC calendar day), ${agent}, paid_calls.service, paid_calls.endpoint, paid_calls.path, paid_calls.status, paid_calls.charge and paid_calls.id (text), and paid_calls.price (number, USD).`,
    'Aggregations: sum, avg, min and max work only on paid_calls.price. Dates, datetimes and text accept only count, countd, first and last; never use max or min on paid_calls.time or paid_calls.day.',
    'For the latest or earliest call, use a projection of paid_calls.time sorted descending or ascending with limit 1. For totals per day, group by paid_calls.day; for other buckets use a dateTrunc expression on paid_calls.time.',
    'paid_calls.day may come back as a local midnight timestamp; it still names the UTC day, so report it as that date. If a query is rejected, read the error, fix the query and try again.',
  ].join('\n');
}

export const AI_TEXT: Record<AiScope, AiText> = {
  operator: {
    title: 'Ask about your spend',
    placeholder: 'Ask about your spend…',
    agentName: 'Spend analyst',
    starters: ['Which agent spent the most this week?', 'Show spend by service for yesterday', 'How much is not yet charged?'],
    instructions: instructions('operator'),
  },
  seller: {
    title: 'Ask about your revenue',
    placeholder: 'Ask about your revenue…',
    agentName: 'Revenue analyst',
    starters: ['Which endpoint earned the most this week?', 'How many paid calls came in today?', 'How much is not yet charged?'],
    instructions: instructions('seller'),
  },
};

/** Read-only tools only: the assistant can never change the dashboard (design spec §12.2). */
export const ANALYST_TOOLS = ['viewSchema', 'viewReport', 'viewPage', 'viewWidget', 'executeQuery'] as const;

const f = (id: string) => ({ id: `${SOURCE_ID}.${id}` });
const sum = (id: string) => ({ id: `${SOURCE_ID}.${id}`, aggregation: 'sum' as const });
const count = (id: string) => ({ id: `${SOURCE_ID}.${id}`, aggregation: 'count' as const });

interface WidgetSpec {
  id: string;
  widget: Record<string, unknown>;
  layout: { xTrack: number; yTrack: number; xSpan: number; ySpan: number };
}

function axes(fontMono: string) {
  const label = { fontFamily: fontMono, fontSize: 11, color: '#5B635F' };
  return { categoryAxis: { label }, valueAxis: { label } };
}

function lineChart(title: string, subtitle: string, fontMono: string, category: string) {
  return {
    type: 'line-chart',
    format: {
      title: { enabled: true, text: title },
      subtitle: { enabled: true, text: subtitle },
      style: {
        theme: { common: { legend: { enabled: false } }, line: { series: { marker: { enabled: false } } } },
        custom: axes(fontMono),
      },
    },
    dataMapping: { categoryKey: [f(category)], valueKey: [sum('price')] },
  };
}

function barChart(title: string, subtitle: string, fontMono: string, category: string) {
  return {
    type: 'bar-chart-grouped',
    format: {
      title: { enabled: true, text: title },
      subtitle: { enabled: true, text: subtitle },
      style: {
        theme: {
          common: { legend: { enabled: false } },
          bar: { series: { label: { enabled: true, fontFamily: fontMono, fontSize: 12, color: '#FFFFFF' } } },
        },
        custom: axes(fontMono),
      },
    },
    dataMapping: { categoryKey: [f(category)], valueKey: [sum('price')] },
  };
}

/**
 * A grid of paid calls. `id` is always the last column, so two calls that look identical never
 * merge into one row (Milestone 1 finding). `showTitle: false` is for a grid that sits inside a
 * page card which already carries the title (agent and charge detail).
 */
function grid(title: string, cols: string[], showTitle = true) {
  return {
    type: 'grid',
    format: { title: { enabled: showTitle, text: title }, style: { columnAutoSize: true } },
    dataMapping: { cols: [...cols, 'id'].map(f) },
    sort: [{ field: f('time'), direction: 'desc' }],
  };
}

function widgets(kind: StudioKind, fontMono: string, rangeLabel: string): WidgetSpec[] {
  switch (kind) {
    case 'overview':
      return [
        { id: 'spendPerDay', widget: lineChart('Spend per day', rangeLabel, fontMono, 'day'), layout: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 16 } },
        { id: 'spendPerAgent', widget: barChart('Spend per agent', rangeLabel, fontMono, 'agent'), layout: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 16 } },
        {
          id: 'spendPerService',
          widget: {
            type: 'donut-chart',
            format: {
              title: { enabled: true, text: 'Spend per service' },
              subtitle: { enabled: true, text: rangeLabel },
              style: {
                theme: { common: { legend: { enabled: true, position: 'right' } } },
                custom: { totalLabel: { enabled: true, fontFamily: fontMono, fontSize: 18, fontWeight: 600, color: '#0C0F0E' } },
              },
            },
            dataMapping: { categoryKey: [f('service')], valueKey: [sum('price')] },
          },
          layout: { xTrack: 0, yTrack: 16, xSpan: 12, ySpan: 16 },
        },
        {
          id: 'recentCalls',
          widget: grid('Recent paid calls', ['time', 'agent', 'service', 'price', 'status']),
          layout: { xTrack: 12, yTrack: 16, xSpan: 12, ySpan: 16 },
        },
      ];
    case 'agent':
      return [
        {
          id: 'agentCalls',
          widget: grid('Recent paid calls', ['time', 'service', 'endpoint', 'price', 'status', 'charge'], false),
          layout: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 24 },
        },
      ];
    case 'charge':
      return [
        {
          id: 'chargeCalls',
          widget: grid('Included paid calls', ['time', 'agent', 'service', 'endpoint', 'price'], false),
          layout: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 24 },
        },
      ];
    case 'seller':
      return [
        { id: 'revenuePerEndpoint', widget: barChart('Revenue per endpoint', rangeLabel, fontMono, 'path'), layout: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 16 } },
        { id: 'revenuePerDay', widget: lineChart('Revenue per day', rangeLabel, fontMono, 'day'), layout: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 16 } },
        {
          id: 'callsByAgent',
          widget: {
            type: 'grid',
            format: { title: { enabled: true, text: 'Calls by agent' }, style: { columnAutoSize: true, grandTotalRow: { enabled: false } } },
            dataMapping: { cols: [f('agent'), count('id'), sum('price')] },
            sort: [{ field: sum('price'), direction: 'desc' }],
          },
          layout: { xTrack: 0, yTrack: 16, xSpan: 10, ySpan: 16 },
        },
        {
          id: 'recentCalls',
          widget: grid('Recent paid calls', ['time', 'agent', 'endpoint', 'price', 'status']),
          layout: { xTrack: 10, yTrack: 16, xSpan: 14, ySpan: 16 },
        },
      ];
  }
}

/** The widget state of a screen, built in code and never saved (design spec §11.4). */
export function initialState(kind: StudioKind, fontMono: string, rangeLabel = 'Last 14 days'): AgReportState {
  const specs = widgets(kind, fontMono, rangeLabel);
  const state = {
    selectedPageId: kind,
    pages: [
      {
        id: kind,
        widgets: Object.fromEntries(specs.map((s) => [s.id, s.widget])),
        widgetLayout: Object.fromEntries(specs.map((s) => [s.id, s.layout])),
      },
    ],
  };
  // The widget union of AG Studio's state type is too deep to spell out here; the shapes above
  // follow the spike and the state reference.
  return state as unknown as AgReportState;
}

/** Studio theme parameters from the design tokens (design spec §11.1). */
export function themeParams(fontSans: string): Record<string, unknown> {
  return {
    fontFamily: fontSans,
    fontSize: 14,
    textColor: '#0C0F0E',
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E4DE',
    accentColor: '#087A3D',
    studioWrapperBorder: false,
    studioWrapperBackgroundColor: 'transparent',
    studioWrapperSpacing: 0,
    studioCanvasBorder: false,
    studioCanvasShadow: false,
    studioCanvasPadding: 0,
    studioCanvasBackgroundColor: '#F4F5F1',
    studioCanvasFontFamily: fontSans,
    studioCanvasRowHeight: 16,
    studioWidgetBackgroundColor: '#FFFFFF',
    studioWidgetBorder: { width: 1, color: '#E2E4DE' },
    studioWidgetBorderRadius: 14,
    studioWidgetPadding: 16,
    studioWidgetTitleFontFamily: fontSans,
    studioWidgetTitleFontSize: 14,
    studioWidgetTitleFontWeight: 700,
    studioWidgetTitleTextColor: '#0C0F0E',
    studioWidgetSubtitleFontFamily: fontSans,
    studioWidgetSubtitleFontSize: 12,
    studioWidgetSubtitleTextColor: '#5B635F',
    studioAiPanelWidth: 340,
    chartFontFamily: fontSans,
    chartFontSize: 13,
    chartTextColor: '#5B635F',
    chartSubtleTextColor: '#5B635F',
    chartAxisLineColor: '#E2E4DE',
    chartGridLineColor: '#EEF0EB',
    ...Object.fromEntries(
      PALETTE.flatMap((c, i) => [
        [`chartPaletteFills${i + 1}Color`, c],
        [`chartPaletteStrokes${i + 1}Color`, c],
      ]),
    ),
    gridHeaderTextColor: '#5B635F',
    gridHeaderFontSize: 12,
    gridHeaderFontWeight: 500,
    gridHeaderBackgroundColor: '#FFFFFF',
    gridRowBorder: { width: 1, color: '#EEF0EB' },
    gridHeaderRowBorder: { width: 1, color: '#E2E4DE' },
    gridRowHeight: 44,
  };
}

export const STUDIO_LAYOUT = {
  columns: 24,
  pagePadding: 0,
  backgroundColor: '#F4F5F1',
  widgetBorderEnabled: true,
  widgetBorderColor: '#E2E4DE',
  widgetBorderWidth: 1,
  widgetBorderRadius: 14,
  widgetBackgroundColor: '#FFFFFF',
  // Space around each widget: the gap between two widgets is twice this (14px).
  widgetPadding: 7,
} as const;

/**
 * The layout of a single grid embedded in a page card (agent and charge detail): no canvas colour,
 * border or padding of its own, so the card does not show a second frame inside it.
 */
export const EMBEDDED_LAYOUT = {
  ...STUDIO_LAYOUT,
  backgroundColor: '#FFFFFF',
  widgetBorderEnabled: false,
  widgetPadding: 0,
} as const;

export function layoutFor(kind: StudioKind): typeof STUDIO_LAYOUT | typeof EMBEDDED_LAYOUT {
  return kind === 'agent' || kind === 'charge' ? EMBEDDED_LAYOUT : STUDIO_LAYOUT;
}

/** The state with every range subtitle ("Last N days") replaced, for the range buttons. */
export function withRangeLabel(state: AgReportState, label: string): AgReportState {
  const pages = (state as unknown as { pages?: { widgets?: Record<string, { format?: { subtitle?: { text?: string } } }> }[] }).pages ?? [];
  const next = pages.map((page) => ({
    ...page,
    widgets: Object.fromEntries(
      Object.entries(page.widgets ?? {}).map(([id, widget]) => {
        const text = widget.format?.subtitle?.text;
        if (text === undefined || !text.startsWith('Last ')) return [id, widget];
        return [id, { ...widget, format: { ...widget.format, subtitle: { ...widget.format?.subtitle, text: label } } }];
      }),
    ),
  }));
  return { ...(state as object), pages: next } as unknown as AgReportState;
}
