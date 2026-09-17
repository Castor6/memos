import type { MemoTimeBasis } from "@/contexts/ViewContext";

export interface StatisticsViewProps {
  className?: string;
}

export interface MonthNavigatorProps {
  visibleMonth: string;
  onMonthChange: (month: string) => void;
  activityStats: Record<string, number>;
  itemLabel?: string;
  timeBasis: MemoTimeBasis;
}

export interface StatisticsData {
  activityStats: Record<string, number>;
  itemLabel?: string;
  timeBasis: MemoTimeBasis;
}
