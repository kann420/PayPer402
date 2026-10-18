import { KpiSkeletons, WidgetSkeletons } from '@/components/ui/kpi';

/** Loading skeletons for KPI rows and widget frames (design spec §10.14). */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5 px-7 pt-6 pb-10">
      <KpiSkeletons />
      <WidgetSkeletons />
    </div>
  );
}
