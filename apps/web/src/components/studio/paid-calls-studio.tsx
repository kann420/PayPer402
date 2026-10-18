'use client';

// The AG Studio client module (design spec §11). Only the dashboard routes import it, so its
// ~1.5 MB bundle stays off every other route.
// The licence banner filter must load before ag-studio (development only).
import './licence-banner-filter';
import { useEffect, useMemo, useRef } from 'react';
import { AgStudioAiModule, createAiHarness, directLlmRunner, studioTheme } from 'ag-studio';
import type { AgAiHarnessSetupParams, AgStudioApi, AgWidgetField, AgWidgetsConfig } from 'ag-studio';
import { AgStudio, AgStudioProvider, GridWidget } from 'ag-studio-react';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { jakarta, jetbrains } from '@/app/fonts';
import { callEntryByLabel } from '@/lib/status';
import {
  AI_TEXT,
  DATA_DESCRIPTION,
  MONO_FIELDS,
  SOURCE_DESCRIPTION,
  SOURCE_ID,
  layoutFor,
  fieldDefinitions,
  initialState,
  themeParams,
  withRangeLabel,
  type AiScope,
  type PaidCallRow,
  type StudioKind,
} from '@/lib/studio-config';
import { StatusBadge } from '../ui/status-badge';
import { ASK_AI_EVENT, openAiPanel } from './ask-ai';
import { createServerLlmAdapter } from './llm-adapter';

const MODULES = [AgStudioAiModule];

function StatusCell(props: CustomCellRendererProps) {
  const label = typeof props.value === 'string' ? props.value : '';
  const entry = callEntryByLabel(label);
  return entry === undefined ? <>{label}</> : <StatusBadge entry={entry} size="sm" />;
}

function MonoCell(props: CustomCellRendererProps) {
  return <span className="font-mono tabular-nums">{props.valueFormatted ?? String(props.value ?? '')}</span>;
}

/** The time column never truncates: its cell keeps the width of `HH:MM:SS` (spike finding). */
function TimeCell(props: CustomCellRendererProps) {
  return <span className="inline-block min-w-[136px] font-mono tabular-nums">{props.valueFormatted ?? String(props.value ?? '')}</span>;
}

function chargeCell(links: Record<string, string>) {
  return function ChargeCell(props: CustomCellRendererProps) {
    const short = typeof props.value === 'string' ? props.value : '';
    const id = links[short];
    if (short === '') return <span className="text-ink-500">—</span>;
    return id === undefined ? (
      <span className="font-mono">{short}</span>
    ) : (
      <a className="font-mono" href={`/app/charges/${encodeURIComponent(id)}`}>
        {short}
      </a>
    );
  };
}

export interface PaidCallsStudioProps {
  kind: StudioKind;
  scope: AiScope;
  rows: PaidCallRow[];
  /** Show the read-only AI panel on the right (Overview and Seller overview). */
  ai?: boolean;
  /** Open the AI panel on load (`?ai=1`). */
  aiOpen?: boolean;
  licenseKey?: string | undefined;
  height: number;
  rangeLabel?: string;
  /** Short settlement id to full id, for the Charge column links. */
  chargeLinks?: Record<string, string>;
  onApi?: (api: AgStudioApi) => void;
}

export function PaidCallsStudio(props: PaidCallsStudioProps) {
  const { kind, scope, rows, ai = false, aiOpen = false, licenseKey, height, rangeLabel, chargeLinks, onApi } = props;
  const fontSans = jakarta.style.fontFamily;
  const fontMono = jetbrains.style.fontFamily;
  const apiRef = useRef<AgStudioApi | undefined>(undefined);
  const hostRef = useRef<HTMLDivElement>(null);

  const fields = useMemo(() => fieldDefinitions(scope), [scope]);
  const data = useMemo(
    () => ({
      description: DATA_DESCRIPTION[scope],
      sources: [{ id: SOURCE_ID, name: 'Paid calls', description: SOURCE_DESCRIPTION[scope], data: rows, fields }],
    }),
    [rows, fields, scope],
  );
  // `initialState`, `ai` and `localeText` are read once; keep them stable for the component's life.
  const state = useMemo(() => initialState(kind, fontMono, rangeLabel), [kind, fontMono]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = AI_TEXT[scope];
  const localeText = useMemo(() => ({ panelTitleAi: text.title, aiMessageInputPlaceholder: text.placeholder }), [text]);
  const aiSetup = useMemo(() => {
    if (!ai) return undefined;
    const adapter = createServerLlmAdapter(scope);
    const promptStarters = text.starters.map((s) => ({ label: s, prompt: s }));
    return ({ api }: AgAiHarnessSetupParams) =>
      createAiHarness(api, ({ tools: { studio } }) => ({
        agents: [
          directLlmRunner({
            id: 'analyst',
            name: text.agentName,
            description: 'Answers questions about this dashboard. Read-only.',
            adapter,
            instructions: () => text.instructions,
            tools: () => [studio.viewSchema(), studio.viewReport(), studio.viewPage(), studio.viewWidget(), studio.executeQuery()],
          }),
        ],
        primary: 'analyst',
        promptStarters,
      }));
  }, [ai, scope, text]);
  // The AI panel in view mode is not in Studio's types; the spike showed it works (design spec §12.1).
  const panels = useMemo(() => ({ view: { right: ai ? (['ai'] as unknown as 'filters'[]) : [] } }), [ai]);
  const theme = useMemo(() => studioTheme.withParams(themeParams(fontSans)), [fontSans]);
  const widgets = useMemo(() => {
    const links = chargeLinks ?? {};
    const ChargeCell = chargeCell(links);
    return (defaults: AgWidgetsConfig) => ({
      ...defaults,
      widgets: defaults.widgets.map((w) =>
        w.id === 'grid'
          ? {
              ...w,
              comp: GridWidget,
              options: {
                createCellRenderer: (field: AgWidgetField) => {
                  const id = String(field.fieldId).split('.').at(-1) ?? '';
                  if ('aggregation' in field && field.aggregation !== undefined) return undefined;
                  if (id === 'status') return StatusCell;
                  if (id === 'charge') return ChargeCell;
                  if (id === 'time') return TimeCell;
                  return MONO_FIELDS.has(id) ? MonoCell : undefined;
                },
              },
            }
          : w,
      ),
    });
  }, [chargeLinks]);

  // The range subtitle follows the range buttons; Studio's state is changed in place.
  const firstLabel = useRef(rangeLabel);
  useEffect(() => {
    const api = apiRef.current;
    if (api === undefined || rangeLabel === undefined || rangeLabel === firstLabel.current) return;
    firstLabel.current = rangeLabel;
    api.setState(withRangeLabel(api.getState(), rangeLabel));
  }, [rangeLabel]);

  useEffect(() => {
    if (!ai) return;
    const open = () => openAiPanel(apiRef.current, hostRef.current);
    window.addEventListener(ASK_AI_EVENT, open);
    return () => window.removeEventListener(ASK_AI_EVENT, open);
  }, [ai]);

  return (
    <AgStudioProvider modules={MODULES} {...(licenseKey === undefined ? {} : { licenseKey })}>
      <div ref={hostRef} className="studio-host w-full min-w-0" style={{ height }}>
        <AgStudio
          style={{ height: '100%', width: '100%' }}
          data={data as never}
          initialState={state}
          mode="view"
          theme={theme}
          layout={layoutFor(kind)}
          localeText={localeText}
          {...(aiSetup === undefined ? {} : { ai: aiSetup })}
          panels={panels}
          widgets={widgets as never}
          onApiReady={(event) => {
            apiRef.current = event.api;
            onApi?.(event.api);
            if (ai && aiOpen) openAiPanel(event.api, hostRef.current);
          }}
        />
      </div>
    </AgStudioProvider>
  );
}
