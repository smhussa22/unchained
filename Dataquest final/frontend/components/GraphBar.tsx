type GraphBarProps = {
  value: number; // 0 → 1
  baseline?: number;
};

export default function GraphBar({ value, baseline }: GraphBarProps) {
  const threshold = 0.6;

  let r = 160;
  let g = 160;
  let b = 160;

  if (value < threshold) {
    // normalize 0 → threshold into 0 → 1
    const t = value / threshold;

    // interpolate from deep red (#400207) → grey
    const start = { r: 64, g: 2, b: 7 }; // #400207
    const end = { r: 160, g: 160, b: 160 }; // grey

    r = Math.floor(start.r + (end.r - start.r) * t);
    g = Math.floor(start.g + (end.g - start.g) * t);
    b = Math.floor(start.b + (end.b - start.b) * t);
  }

  return (
    <div className="relative w-full h-6 bg-neutral-800 rounded overflow-hidden">
      <div
        className="h-full"
        style={{
          width: `${value * 100}%`,
          backgroundColor: `rgb(${r}, ${g}, ${b})`,
        }}
      />
      {baseline !== undefined && Math.abs(baseline - value) > 0.01 && (
        <div
          className="absolute top-0 h-full w-1 bg-white/70 shadow-[0_0_6px_rgba(255,255,255,0.5)]"
          style={{ left: `${baseline * 100}%` }}
        />
      )}
    </div>
  );
}
