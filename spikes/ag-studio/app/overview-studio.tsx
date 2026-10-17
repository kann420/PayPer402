'use client';

import { useEffect, useMemo, useState } from 'react';
import { AgStudioAiModule, createAiHarness, directLlmRunner, studioTheme } from 'ag-studio';
import type {
  AgAiHarnessSetupParams,
  AgFieldDefinition,
  AgReportState,
  AgStudioMode,
  AgWidgetField,
  AgWidgetsConfig,
} from 'ag-studio';
import { AgStudio, AgStudioProvider, GridWidget } from 'ag-studio-react';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { createServerLlmAdapter } from './llm-adapter';
import { buildPaidCalls } from './sample-data';
import type { PaidCallStatus } from './sample-data';

// Chart palette from the design system, light theme, in order.
const PALETTE = ['#0E9F5C', '#7C5CFF', '#F59E0B', '#0EA5A4', '#E5487D', '#64748B'];

const BADGE: Record<PaidCallStatus, { glyph: string; className: string }> = {
  'Not yet charged': { glyph: '◷', className: 'badge badge-pending' },
  Charged: { glyph: '✓', className: 'badge badge-ok' },
  Charging: { glyph: '↻', className: 'badge badge-warn' },
  'Not collected': { glyph: '✕', className: 'badge badge-bad' },
};

function StatusCell(props: CustomCellRendererProps) {
  const value = props.value as PaidCallStatus | null | undefined;
  if (value == null || !(value in BADGE)) return <>{String(props.value ?? '')}</>;
  const badge = BADGE[value];
  return (
    <span className={badge.className}>
      <span aria-hidden="true">{badge.glyph}</span>
      {value}
    </span>
  );
}

function MonoCell(props: CustomCellRendererProps) {
  return <span className="mono tnum">{props.valueFormatted ?? String(props.value ?? '')}</span>;
}

const FIELDS: AgFieldDefinition[] = [
  { id: 'id', name: 'Paid call', format: 'textFormat', hide: true },
  { id: 'time', name: 'Time', format: 'dateTimeFormat', formatOptions: { format: 'HH:mm:ss' } },
  { id: 'day', name: 'Day', format: 'dateFormat', formatOptions: { format: 'MMM d' } },
  { id: 'agent', name: 'Agent', format: 'textFormat' },
  { id: 'service', name: 'Service', format: 'textFormat' },
  { id: 'endpoint', name: 'Endpoint', format: 'textFormat' },
  { id: 'price', name: 'Price', format: 'currencyFormat', formatOptions: { format: '$#,##0.00' } },
  { id: 'status', name: 'Status', format: 'textFormat' },
];

const MODULES = [AgStudioAiModule];
const MONO_FIELDS = new Set(['time', 'agent', 'price', 'endpoint']);
const f = (id: string) => ({ id: `paid_calls.${id}` });
const sum = (id: string) => ({ id: `paid_calls.${id}`, aggregation: 'sum' as const });

function initialState(fontMono: string): AgReportState {
  // Axis labels in mono, as the mockup draws them; legends stay in the sans face.
  const axisLabel = { fontFamily: fontMono, fontSize: 11, color: '#5B635F' };
  const axes = { categoryAxis: { label: axisLabel }, valueAxis: { label: axisLabel } };
  return {
    selectedPageId: 'overview',
    pages: [
      {
        id: 'overview',
        widgets: {
          spendPerDay: {
            type: 'line-chart',
            format: {
              title: { enabled: true, text: 'Spend per day' },
              subtitle: { enabled: true, text: 'Last 14 days' },
              style: {
                theme: { common: { legend: { enabled: false } }, line: { series: { marker: { enabled: false } } } },
                custom: axes,
              },
            },
            dataMapping: { categoryKey: [f('day')], valueKey: [sum('price')] },
          },
          spendPerAgent: {
            type: 'bar-chart-grouped',
            format: {
              title: { enabled: true, text: 'Spend per agent' },
              subtitle: { enabled: true, text: 'Total' },
              style: {
                theme: {
                  common: { legend: { enabled: false } },
                  bar: { series: { label: { enabled: true, fontFamily: fontMono, fontSize: 12, color: '#FFFFFF' } } },
                },
                custom: axes,
              },
            },
            dataMapping: { categoryKey: [f('agent')], valueKey: [sum('price')] },
          },
          spendPerService: {
            type: 'donut-chart',
            format: {
              title: { enabled: true, text: 'Spend per service' },
              subtitle: { enabled: true, text: 'Last 14 days' },
              style: {
                theme: { common: { legend: { enabled: true, position: 'right' } } },
                custom: { totalLabel: { enabled: true, fontFamily: fontMono, fontSize: 18, fontWeight: 600, color: '#0C0F0E' } },
              },
            },
            dataMapping: { categoryKey: [f('service')], valueKey: [sum('price')] },
          },
          recentCalls: {
            type: 'grid',
            format: { title: { enabled: true, text: 'Recent paid calls' }, style: { columnAutoSize: true } },
            dataMapping: { cols: [f('time'), f('agent'), f('service'), f('price'), f('status')] },
            sort: [{ field: f('time'), direction: 'desc' }],
          },
        },
        widgetLayout: {
          spendPerDay: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 16 },
          spendPerAgent: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 16 },
          spendPerService: { xTrack: 0, yTrack: 16, xSpan: 12, ySpan: 16 },
          recentCalls: { xTrack: 12, yTrack: 16, xSpan: 12, ySpan: 16 },
        },
      },
    ],
  } as unknown as AgReportState;
}

export function OverviewStudio({ fontSans, fontMono }: { fontSans: string; fontMono: string }) {
  const [mode, setMode] = useState<AgStudioMode>('view');
  // Spike switches, read once on the client before Studio is created (`ai` is an initial-only prop):
  //   ?mode=edit       open in edit mode
  //   ?ai=view         put the AI panel in view mode too (the types allow it only in edit mode)
  //   ?agent=analyst   one read-only agent instead of the five built-in dashboard-building agents
  const [params, setParams] = useState<URLSearchParams | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('mode') === 'edit') setMode('edit');
    setParams(p);
  }, []);
  const data = useMemo(
    () => ({
      description: 'Paid API calls made by AI agents. Every amount is in US dollars (USD); show it with a $ sign.',
      sources: [
        {
          id: 'paid_calls',
          name: 'Paid calls',
          description: 'One row per paid call. price is the USD price of that call; status says whether it is charged yet.',
          data: buildPaidCalls(),
          fields: FIELDS,
        },
      ],
    }),
    [],
  );
  const state = useMemo(() => initialState(fontMono), [fontMono]);
  const ai = useMemo(() => {
    if (params === null) return undefined;
    const adapter = createServerLlmAdapter();
    const promptStarters = [
      { label: 'Which agent spent the most this week?', prompt: 'Which agent spent the most this week?' },
      { label: 'Show spend by service for yesterday', prompt: 'Show spend by service for yesterday.' },
      { label: 'How much is not yet charged?', prompt: 'How much is not yet charged?' },
    ];
    if (params.get('agent') !== 'analyst') {
      return ({ api }: AgAiHarnessSetupParams) => createAiHarness(api, { adapter, promptStarters });
    }
    return ({ api }: AgAiHarnessSetupParams) =>
      createAiHarness(api, ({ tools: { studio } }) => ({
        agents: [
          directLlmRunner({
            id: 'analyst',
            name: 'Spend analyst',
            description: 'Answers questions about agent spend. Read-only.',
            adapter,
            instructions: () =>
              'You answer questions about this spend dashboard by querying its data. Amounts are USD. ' +
              'Do not change the dashboard.',
            tools: () => [studio.viewSchema(), studio.viewReport(), studio.viewPage(), studio.viewWidget(), studio.executeQuery()],
          }),
        ],
        primary: 'analyst',
        promptStarters,
      }));
  }, [params]);
  const panels = useMemo(
    () => ({
      edit: { right: ['ai' as const] },
      view: { right: params?.get('ai') === 'view' ? (['ai'] as unknown as 'filters'[]) : [] },
    }),
    [params],
  );

  const theme = useMemo(
    () =>
      studioTheme.withParams({
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
      }),
    [fontSans, fontMono],
  );

  const layout = useMemo(
    () => ({
      columns: 24,
      pagePadding: 0,
      backgroundColor: '#F4F5F1',
      widgetBorderEnabled: true,
      widgetBorderColor: '#E2E4DE',
      widgetBorderWidth: 1,
      widgetBorderRadius: 14,
      widgetBackgroundColor: '#FFFFFF',
      // Space around each widget, so the gap between two widgets is twice this (14px, as designed).
      widgetPadding: 7,
    }),
    [],
  );

  // Swap the grid widget's component for the React one, so cells can render status badges.
  const widgets = useMemo(
    () => (defaults: AgWidgetsConfig) => ({
      ...defaults,
      widgets: defaults.widgets.map((w) =>
        w.id === 'grid'
          ? {
              ...w,
              comp: GridWidget,
              options: {
                createCellRenderer: (field: AgWidgetField) => {
                  const id = String(field.fieldId).split('.').at(-1) ?? '';
                  return id === 'status' ? StatusCell : MONO_FIELDS.has(id) ? MonoCell : undefined;
                },
              },
            }
          : w,
      ),
    }),
    [],
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button type="button" onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}>
          Spike: switch to {mode === 'view' ? 'edit' : 'view'} mode
        </button>
      </div>
      <AgStudioProvider modules={MODULES}>
        <div className="studio-host" style={{ height: 530 }}>
          {ai !== undefined && (
            <AgStudio
              style={{ height: '100%', width: '100%' }}
              data={data as never}
              initialState={state}
              mode={mode}
              theme={theme}
              layout={layout}
              ai={ai}
              panels={panels}
              widgets={widgets as never}
            />
          )}
        </div>
      </AgStudioProvider>
    </div>
  );
}
