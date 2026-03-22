"use client";

import { useMemo, useState } from "react";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type DayDisplayProps = {
  /** Simulation time in seconds; each second adds one calendar day from the start date. */
  time: number;
};

export default function DayDisplay({ time }: DayDisplayProps) {
  const [baseDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const dateLabel = useMemo(() => {
    const d = new Date(baseDate.getTime() + time * MS_PER_DAY);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(d);
  }, [baseDate, time]);

  return (
    <div className="w-full rounded-xl border border-neutral-700 bg-neutral-900/80 px-4 py-3 text-center text-lg font-extrabold tracking-tight text-mainwhite backdrop-blur-md">
      {dateLabel || "\u00a0"}
    </div>
  );
}
