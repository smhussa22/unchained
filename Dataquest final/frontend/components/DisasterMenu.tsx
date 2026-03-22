"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import GraphBar from "./GraphBar";
import TimeSlider from "./TimeSlider";
import { CgPlayButtonO } from "react-icons/cg";
import { FaRegPauseCircle } from "react-icons/fa";
import { IoIosClose } from "react-icons/io";
import { edges, nodes } from "@/app/supply_chain_graph/graph_data";
import {
  buildSupplyChainChain,
  edgeIsSeveredAtNode,
} from "@/app/supply_chain_graph/graph_utils";
import { NODE_TYPE_VISUAL } from "@/app/supply_chain_graph/node_type_visuals";
import { forecast } from "@/app/supply_chain_graph/forecast_data";

const NODE_DISPLAY_NAME: Record<string, string> = {
  manufacturer: "Puerto Rico Manufacturer",
  "port-miami": "Miami Port",
  "dc-us": "US Distribution Center",
  "dc-ca": "Canadian Distribution Center",
};

const RESPONSE_ACTIONS = [
  { threshold: 80, label: "Centralize Inventory", detail: "Move all IV stock to pharmacy for controlled distribution", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  { threshold: 70, label: "IV-to-Oral Conversion", detail: "Switch eligible patients to oral hydration and medication", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  { threshold: 70, label: "Conservation Protocols", detail: "Reduce flow rates, use gravity drips, minimize waste", color: "text-yellow-400", bg: "bg-yellow-400/10" },
  { threshold: 60, label: "Activate Alternate Suppliers", detail: "Contact Group Purchasing Organization (GPO) for emergency sourcing", color: "text-yellow-400", bg: "bg-yellow-400/10" },
  { threshold: 50, label: "503B Outsourced Compounding", detail: "Contract FDA-registered facilities to compound IV solutions", color: "text-orange-400", bg: "bg-orange-400/10" },
  { threshold: 40, label: "FDA Emergency Import", detail: "Petition FDA for temporary importation of foreign-approved IV fluids", color: "text-red-400", bg: "bg-red-400/10" },
  { threshold: 30, label: "Clinical Rationing", detail: "Cancel elective surgeries, triage IV access to critical patients only", color: "text-red-500", bg: "bg-red-500/10" },
] as const;

const NODE_REAL_WORLD_CONTEXT: Record<string, string> = {
  manufacturer:
    "This mirrors the 2017 Hurricane Maria crisis — 43% of US IV solutions were manufactured in Puerto Rico. 80% of hospitals were affected nationwide.",
  "port-miami":
    "Miami is the primary entry point for Caribbean pharmaceutical imports. A port disruption delays supplies to the entire US eastern seaboard.",
  "dc-us":
    "In 2024, Hurricane Helene flooded Baxter's North Cove facility — responsible for 60% of US IV fluids. Hospitals received only 40% of normal orders for months.",
  "dc-ca":
    "Canadian distribution hubs serve Ontario hospitals directly. A disruption here isolates facilities from US supply chains.",
};

type DisasterMenuProps = {
  time: number;
  setTime: Dispatch<SetStateAction<number>>;
  /** Clicked supply-chain node (non-hospital); its edges show as severed. */
  severedNodeId: string | null;
  /** When false (e.g. menu closing), simulation stops so time isn’t advanced during exit animation. */
  open?: boolean;
  onClose?: () => void;
};

export default function DisasterMenu({
  time,
  setTime,
  severedNodeId,
  open = true,
  onClose,
}: DisasterMenuProps) {
  const [playing, setPlaying] = useState(false);
  const prevOpenRef = useRef(open);

  // D. Auto-play on open
  useEffect(() => {
    if (open && !prevOpenRef.current && severedNodeId) {
      setTime(0);
      setPlaying(true);
    }
    if (!open) setPlaying(false);
    prevOpenRef.current = open;
  }, [open, severedNodeId, setTime]);

const chain = useMemo(
() => [...buildSupplyChainChain(nodes, edges)].reverse(),
[]
);

const { supply, baseline } = useMemo(() => {
  const fallback = Math.max(0, 1 - time / 14);
  if (!severedNodeId || !forecast?.chainForecasts) {
    return { supply: fallback, baseline: 1 };
  }
  // Show the hospital's supply — that's what the dashboard represents
  const chainNode = forecast.chainForecasts["hospital"];
  if (!chainNode) return { supply: fallback, baseline: 1 };

  const day = Math.min(Math.floor(time), 13);
  const frac = time - day;
  const next = Math.min(day + 1, 13);
  const lerp = (arr: number[]) =>
    Math.max(0, Math.min(1, arr[day] * (1 - frac) + arr[next] * frac));

  const scenarioPreds = chainNode.scenarios?.[severedNodeId];
  const supplyVal = scenarioPreds ? lerp(scenarioPreds) : lerp(chainNode.baseline);
  const baselineVal = lerp(chainNode.baseline);

  return { supply: supplyVal, baseline: baselineVal };
}, [severedNodeId, time]);

  // 14-point supply curve for the sparkline
  const supplyCurve = useMemo(() => {
    if (!severedNodeId || !forecast?.chainForecasts) return undefined;
    const chainNode = forecast.chainForecasts["hospital"];
    if (!chainNode) return undefined;
    const scenarioPreds = chainNode.scenarios?.[severedNodeId];
    const arr = scenarioPreds ?? chainNode.baseline;
    return arr.map((v) => Math.max(0, Math.min(1, v)));
  }, [severedNodeId]);

  useEffect(() => {
    if (!playing || !open) return;

    const interval = setInterval(() => {
      setTime((prev) => {
        if (prev >= 14) {
          setPlaying(false);
          return 14;
        }
        return prev + 0.1;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [playing, setTime, open]);

  const nodeName = severedNodeId ? (NODE_DISPLAY_NAME[severedNodeId] ?? severedNodeId) : "Unknown Node";
  const realWorldContext = severedNodeId ? NODE_REAL_WORLD_CONTEXT[severedNodeId] : null;
  const supplyPct = Math.round(supply * 100);
  const isCritical = supply < 0.3;
  const supplyColor = isCritical ? "text-red-500" : supply < 0.6 ? "text-amber-400" : "text-emerald-400";

  const activeActions = useMemo(
    () => RESPONSE_ACTIONS.filter((a) => supplyPct <= a.threshold),
    [supplyPct]
  );

  // Days until hospital supply drops below 30% (critical threshold)
  const daysUntilCritical = useMemo(() => {
    if (!supplyCurve) return null;
    const idx = supplyCurve.findIndex((v, i) => i > 0 && v < 0.3);
    return idx >= 0 ? idx : null;
  }, [supplyCurve]);

return ( <div className="relative flex w-[520px] flex-col gap-5 rounded-xl border border-neutral-700 bg-neutral-900/80 p-6 pt-6 shadow-md backdrop-blur-md">
{onClose && ( <button
       type="button"
       onClick={onClose}
       className="absolute right-3 top-3 z-10 rounded-md p-1 text-white transition hover:bg-white/10"
     > <IoIosClose className="size-7" /> </button>
)}

  {/* A. Scenario Title Banner */}
  <div className={onClose ? "pr-10" : ""}>
    <h2 className="text-2xl font-bold leading-snug text-white">
      What if the <span className="text-orange-400">{nodeName}</span> goes offline?
    </h2>
  </div>

  <div>
    <h3 className="text-base font-semibold leading-snug text-white">
      University Hospital — London Health Sciences Centre
    </h3>
    <p className="mt-0.5 text-sm text-neutral-400">
      339 Windermere Rd, London, ON
    </p>
  </div>

  {/* Real-world context */}
  {realWorldContext && (
    <p className="rounded-md border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-xs leading-relaxed text-neutral-400 italic">
      {realWorldContext}
    </p>
  )}

  {/* Days until critical */}
  {daysUntilCritical !== null && (
    <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
      <span>Hospital reaches critical supply in {daysUntilCritical} {daysUntilCritical === 1 ? "day" : "days"}</span>
    </div>
  )}

  {/* E. Critical Alert */}
  {isCritical && (
    <div
      className="animate-pulse rounded-md bg-red-700/90 px-4 py-2 text-center text-sm font-semibold text-white"
    >
      ⚠ CRITICAL: Hospital supply below safe threshold
    </div>
  )}

  {/* F. Recommended Actions */}
  {activeActions.length > 0 && (
    <div>
      <div className="mb-2 text-sm font-semibold text-neutral-300">
        Recommended Actions
      </div>
      <div className="flex flex-col gap-1.5">
        {activeActions.map((a, i) => (
          <div
            key={`${a.threshold}-${i}`}
            className={`rounded-md border border-neutral-700/50 ${a.bg} px-3 py-1.5`}
          >
            <span className={`text-xs font-semibold ${a.color}`}>{a.label}</span>
            <span className="ml-2 text-xs text-neutral-400">{a.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )}

  <div>
    <div className="mb-4 text-sm font-semibold text-neutral-300">
      Supply Chain
    </div>

    <div className="flex items-center">
      {chain.map((node, i) => {
        const { Icon, colorClass } = NODE_TYPE_VISUAL[node.type];

        const nextNode = chain[i + 1];
        const edge = edges.find(
          (e) => e.from === node.id && e.to === nextNode?.id
        );

        const isActive =
          !!edge &&
          edge.active &&
          !edgeIsSeveredAtNode(edge, severedNodeId);

        return (
          <div key={node.id} className="flex items-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-neutral-900">
              <Icon className={`${colorClass} size-5`} />
            </div>

            {i < chain.length - 1 && (
              <div
                className={`h-[2px] w-12 mx-2 ${
                  isActive ? "bg-white/40" : "bg-red-600"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  </div>

  {/* B. Animated Supply Counter + IV Supply bar */}
  <div>
    <div className="mb-2 flex items-end justify-between">
      <span className="text-sm font-semibold text-neutral-300">IV Supply</span>
      <span
        className={`text-3xl font-bold tabular-nums ${supplyColor} ${isCritical ? "animate-pulse" : ""}`}
      >
        {supplyPct}%
      </span>
    </div>
    <GraphBar value={supply} baseline={baseline} />
  </div>

  {/* C. Day Counter with Context */}
  <div>
    <p className="mb-1 text-sm text-neutral-400">
      <span className="font-semibold text-neutral-200">Day {Math.min(Math.floor(time) + 1, 14)} of 14</span>
      {" — "}Supply chain disrupted at <span className="text-orange-400">{nodeName}</span>
    </p>
    <TimeSlider
      time={time}
      setTime={playing ? () => {} : setTime}
      supplyCurve={supplyCurve}
    />
  </div>

  <button
    type="button"
    onClick={() => {
      if (time >= 14) setTime(0);
      setPlaying((p) => !p);
    }}
    className="flex items-center justify-center gap-3 rounded-md border border-neutral-600 py-4 text-lg font-semibold text-white transition hover:bg-neutral-800"
  >
    {playing ? (
      <FaRegPauseCircle size={26} />
    ) : (
      <CgPlayButtonO size={26} />
    )}
    <span>
      {playing ? "Pause Disruption" : "Simulate Disruption"}
    </span>
  </button>
</div>

);
}
