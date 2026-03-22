type TimeSliderProps = {
  time: number;
  setTime: (t: number) => void;
  /** 14-element supply curve for the sparkline (optional). */
  supplyCurve?: number[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatShortDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export default function TimeSlider({ time, setTime, supplyCurve }: TimeSliderProps) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(today.getTime() + 14 * MS_PER_DAY);

  // Build sparkline SVG path from supply curve
  const sparklinePath = supplyCurve && supplyCurve.length > 0
    ? supplyCurve
        .map((v, i) => {
          const x = (i / (supplyCurve.length - 1)) * 100;
          const y = (1 - v) * 100; // invert: 1.0 = top, 0 = bottom
          return `${i === 0 ? "M" : "L"}${x},${y}`;
        })
        .join(" ")
    : null;

  // Scrubber position as percentage
  const scrubberPct = (time / 14) * 100;

  return (
    <div className="w-full flex flex-col gap-1">
      {/* Sparkline */}
      {sparklinePath && (
        <div className="relative h-10 w-full">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-full w-full"
          >
            {/* Gradient fill under the curve */}
            <defs>
              <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(239,68,68,0.3)" />
                <stop offset="100%" stopColor="rgba(239,68,68,0)" />
              </linearGradient>
            </defs>
            {/* Filled area */}
            <path
              d={`${sparklinePath} L100,100 L0,100 Z`}
              fill="url(#spark-fill)"
            />
            {/* Line */}
            <path
              d={sparklinePath}
              fill="none"
              stroke="rgba(239,68,68,0.7)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* Vertical scrubber line */}
          <div
            className="absolute top-0 h-full w-px bg-white/60"
            style={{ left: `${scrubberPct}%` }}
          />
        </div>
      )}

      {/* Slider */}
      <input
        type="range"
        min={0}
        max={14}
        step={0.1}
        value={time}
        onChange={(e) => setTime(Number(e.target.value))}
        className="
    w-full
    appearance-none
    h-2
    bg-neutral-700
    rounded
    outline-none

          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:h-4
          [&::-webkit-slider-thumb]:w-4
          [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-white
          [&::-webkit-slider-thumb]:cursor-pointer

          [&::-moz-range-thumb]:h-4
          [&::-moz-range-thumb]:w-4
          [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:bg-white
          [&::-moz-range-thumb]:cursor-pointer
        "
      />

      {/* Date endpoints */}
      <div className="flex justify-between text-xs text-neutral-400">
        <span>Disruption begins · {formatShortDate(today)}</span>
        <span>{formatShortDate(endDate)} · 2 weeks later</span>
      </div>
    </div>
  );
}
