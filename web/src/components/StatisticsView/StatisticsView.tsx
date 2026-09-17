import dayjs from "dayjs";
import { useState } from "react";
import { calculateMaxCount, MonthCalendar } from "@/components/ActivityCalendar";
import { useDateFilterNavigation } from "@/hooks";
import type { StatisticsData } from "@/types/statistics";
import { MonthNavigator } from "./MonthNavigator";

interface Props {
  itemLabel?: string;
  statisticsData: StatisticsData;
}

const StatisticsView = (props: Props) => {
  const { statisticsData, itemLabel } = props;
  const { activityStats, timeBasis } = statisticsData;
  const navigateToDateFilter = useDateFilterNavigation();
  const [visibleMonthString, setVisibleMonthString] = useState(dayjs().format("YYYY-MM"));

  return (
    <div className="group w-full mt-2 flex flex-col text-muted-foreground animate-fade-in">
      <MonthNavigator
        visibleMonth={visibleMonthString}
        onMonthChange={setVisibleMonthString}
        activityStats={activityStats}
        timeBasis={timeBasis}
        itemLabel={itemLabel}
      />

      <div className="w-full animate-scale-in">
        <MonthCalendar
          month={visibleMonthString}
          data={activityStats}
          maxCount={calculateMaxCount(activityStats)}
          onClick={navigateToDateFilter}
          timeBasis={timeBasis}
          itemLabel={itemLabel}
        />
      </div>
    </div>
  );
};

export default StatisticsView;
