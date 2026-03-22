"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DeckGL } from "@deck.gl/react";
import { Map as MapboxMap } from "react-map-gl/mapbox";
import { IconLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { edges, nodes } from "../app/supply_chain_graph/graph_data";
import type { Edge, Node } from "../app/supply_chain_graph/graph_types";
import { edgeIsSeveredAtNode } from "../app/supply_chain_graph/graph_utils";
import { NODE_TYPE_ICON_DATA_URL } from "../app/supply_chain_graph/node_type_visuals";
import { forecast } from "../app/supply_chain_graph/forecast_data";
import DayDisplay from "./DayDisplay";
import DisasterMenu from "./DisasterMenu";

const INITIAL_VIEW_STATE = {
  longitude: -81.2745,
  latitude: 43.0125,
  zoom: 3,
  pitch: 0,
  bearing: 0,
};

const EDGE_WHITE: [number, number, number, number] = [255, 255, 255, 220];

/** Severed edge stack: dark base → deep body → thin highlight (“shine”). */
const EDGE_SEVERED_SHADOW: [number, number, number, number] = [42, 6, 6, 230];
const EDGE_SEVERED_CORE: [number, number, number, number] = [115, 22, 22, 255];
const EDGE_SEVERED_SHINE: [number, number, number, number] = [255, 214, 214, 255];

function healthToRgba(health: number, alpha: number): [number, number, number, number] {
  const h = Math.max(0, Math.min(1, health));
  let r: number, g: number, b: number;
  if (h > 0.7) {
    const t = (1 - h) / 0.3;
    r = 34 + t * (234 - 34);
    g = 197 + t * (179 - 197);
    b = 94 + t * (8 - 94);
  } else if (h > 0.4) {
    const t = (0.7 - h) / 0.3;
    r = 234 + t * (239 - 234);
    g = 179 + t * (68 - 179);
    b = 8 + t * (68 - 8);
  } else {
    r = 239; g = 68; b = 68;
  }
  return [Math.round(r), Math.round(g), Math.round(b), alpha];
}

export default function MapComponent() {
  const [time, setTime] = useState(0);
  const [disasterMenuOpen, setDisasterMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  /** Non-hospital node that was clicked — its incident edges render severed (red). */
  const [severedNodeId, setSeveredNodeId] = useState<string | null>(null);
  const [hoveredNetworkNode, setHoveredNetworkNode] = useState<{
    position: [number, number];
    type: string;
    health: number;
  } | null>(null);

  const networkNodeData = useMemo(() => {
    if (!forecast?.networkNodes) return [];

    const lerp = (arr: number[], t: number) => {
      const d = Math.min(Math.floor(t), 13);
      const f = t - d;
      const nx = Math.min(d + 1, 13);
      return arr[d] * (1 - f) + arr[nx] * f;
    };

    // Find the severed node's position for cascade distance
    let severedPos: [number, number] | null = null;
    if (severedNodeId) {
      const mainNode = nodes.find((n) => n.id === severedNodeId);
      if (mainNode) severedPos = mainNode.position as [number, number];
    }

    return forecast.networkNodes.map((n) => {
      const scenarioKey = severedNodeId ?? "";
      const scenarioPreds = n.scenarioForecasts?.[scenarioKey];
      const preds = scenarioPreds ?? n.forecasts;
      const baseline = n.forecasts;

      // Check if this node is actually affected by the disruption
      // (scenario predictions differ from baseline; missing key = unaffected)
      const isAffected = !!scenarioPreds && scenarioPreds.some(
        (v, i) => Math.abs(v - baseline[i]) > 0.005
      );

      let health: number;
      if (!isAffected || !severedPos) {
        // Unaffected by disruption — stay fully healthy (green)
        health = 1.0;
      } else {
        // Affected — apply cascade delay based on distance from severed node
        const dx = n.position[0] - severedPos[0];
        const dy = n.position[1] - severedPos[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        const normDist = Math.min(dist / 20, 1);
        const delayDays = normDist * 6;
        const effectiveTime = Math.max(0, time - delayDays);
        health = lerp(preds, effectiveTime);
      }

      return {
        position: n.position as [number, number],
        type: n.type as "manufacturer" | "port" | "distribution" | "hospital",
        health,
      };
    });
  }, [time, severedNodeId]);

  const networkNodeLayer = useMemo(() => new ScatterplotLayer({
    id: "network-nodes",
    data: networkNodeData,
    pickable: true,
    getPosition: (d: { position: [number, number]; type: string; health: number }) => d.position,
    getRadius: 6,
    radiusUnits: "pixels" as const,
    getFillColor: (d: { position: [number, number]; type: string; health: number }) => healthToRgba(d.health, 220),
    onHover: (info) => {
      setHoveredNetworkNode(info.object ? (info.object as { position: [number, number]; type: string; health: number }) : null);
    },
    updateTriggers: {
      getFillColor: [time],
    },
  }), [networkNodeData, time]);

  // Build a position → health lookup from networkNodeData for edge coloring
  const posHealthMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of networkNodeData) {
      m.set(`${n.position[0]},${n.position[1]}`, n.health);
    }
    return m;
  }, [networkNodeData]);

  const networkEdgeData = useMemo(() => {
    if (!forecast?.networkEdges) return [];
    return forecast.networkEdges.map((e) => {
      const srcKey = `${e.sourcePosition[0]},${e.sourcePosition[1]}`;
      const tgtKey = `${e.targetPosition[0]},${e.targetPosition[1]}`;
      const srcHealth = posHealthMap.get(srcKey) ?? 1;
      const tgtHealth = posHealthMap.get(tgtKey) ?? 1;
      return { ...e, health: Math.min(srcHealth, tgtHealth) };
    });
  }, [posHealthMap]);

  const networkEdgeLayer = useMemo(() => new LineLayer({
    id: "network-edges",
    data: networkEdgeData,
    getSourcePosition: (d: { sourcePosition: [number, number]; targetPosition: [number, number]; health: number }) => d.sourcePosition,
    getTargetPosition: (d: { sourcePosition: [number, number]; targetPosition: [number, number]; health: number }) => d.targetPosition,
    getWidth: 2.5,
    getColor: (d: { health: number }) => healthToRgba(d.health, 160),
    widthUnits: "pixels" as const,
    pickable: false,
    updateTriggers: {
      getColor: [time],
    },
  }), [networkEdgeData, time]);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  if (!mapboxToken) {
    throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN is not set");
  }

  const edgeLines = useMemo(() => {
    const byId = new globalThis.Map(nodes.map((n) => [n.id, n] as const));
    return edges
      .map((e: Edge) => {
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from || !to) return null;
        const severed =
          !e.active || edgeIsSeveredAtNode(e, severedNodeId);
        return {
          id: e.id,
          sourcePosition: from.position as [number, number],
          targetPosition: to.position as [number, number],
          severed,
        };
      })
      .filter(Boolean) as {
      id: string;
      sourcePosition: [number, number];
      targetPosition: [number, number];
      severed: boolean;
    }[];
  }, [severedNodeId]);

  const healthyEdges = useMemo(
    () => edgeLines.filter((d) => !d.severed),
    [edgeLines]
  );
  const severedEdges = useMemo(
    () => edgeLines.filter((d) => d.severed),
    [edgeLines]
  );

  const edgeLayerHealthy = useMemo(() => new LineLayer({
    id: "supply-edges-healthy",
    data: healthyEdges,
    getSourcePosition: (d) => d.sourcePosition,
    getTargetPosition: (d) => d.targetPosition,
    getWidth: 6,
    getColor: () => EDGE_WHITE,
    widthUnits: "pixels",
    pickable: false,
  }), [healthyEdges]);

  const severedEdgeShadowLayer = useMemo(() => new LineLayer({
    id: "supply-edges-severed-shadow",
    data: severedEdges,
    getSourcePosition: (d) => d.sourcePosition,
    getTargetPosition: (d) => d.targetPosition,
    getWidth: 14,
    getColor: () => EDGE_SEVERED_SHADOW,
    widthUnits: "pixels",
    pickable: false,
  }), [severedEdges]);

  const severedEdgeCoreLayer = useMemo(() => new LineLayer({
    id: "supply-edges-severed-core",
    data: severedEdges,
    getSourcePosition: (d) => d.sourcePosition,
    getTargetPosition: (d) => d.targetPosition,
    getWidth: 8,
    getColor: () => EDGE_SEVERED_CORE,
    widthUnits: "pixels",
    pickable: false,
  }), [severedEdges]);

  const severedEdgeShineLayer = useMemo(() => new LineLayer({
    id: "supply-edges-severed-shine",
    data: severedEdges,
    getSourcePosition: (d) => d.sourcePosition,
    getTargetPosition: (d) => d.targetPosition,
    getWidth: 2.75,
    getColor: () => EDGE_SEVERED_SHINE,
    widthUnits: "pixels",
    pickable: false,
  }), [severedEdges]);

  const shockwaveLayer = useMemo(() => {
    if (!severedNodeId || time <= 0) return null;
    const severedNode = nodes.find((n) => n.id === severedNodeId);
    if (!severedNode) return null;
    const alpha = Math.max(0, Math.floor(180 * (1 - time / 14)));
    return new ScatterplotLayer({
      id: "shockwave-ripple",
      data: [{ position: severedNode.position as [number, number] }],
      getPosition: (d: { position: [number, number] }) => d.position,
      getRadius: Math.min(time, 8) * 80000,
      radiusUnits: "meters" as const,
      filled: false,
      stroked: true,
      getLineColor: [239, 68, 68, alpha] as [number, number, number, number],
      getLineWidth: 3,
      lineWidthUnits: "pixels" as const,
      pickable: false,
    });
  }, [severedNodeId, time]);

  const nodeIconLayer = useMemo(() => new IconLayer({
    id: "nodes",
    data: nodes,
    pickable: true,
    billboard: true,
    sizeUnits: "pixels",
    getPosition: (d: Node) => d.position,
    getIcon: (d: Node) => ({
      url: NODE_TYPE_ICON_DATA_URL[d.type],
      width: 64,
      height: 64,
    }),
    getSize: 28,
    onClick: (info) => {
      const node = info.object as Node | undefined;
      if (!node) return;
      if (node.type === "hospital") return;
      setSeveredNodeId(node.id);
      setDisasterMenuOpen(true);
    },
  }), [setSeveredNodeId, setDisasterMenuOpen]);

  return (
    <div className="relative h-screen w-full">
      <div className="pointer-events-none absolute right-4 top-4 z-30 max-h-[calc(100dvh-5rem)] overflow-x-hidden overflow-y-visible">
        <div className="pointer-events-auto flex max-w-[min(90vw,52rem)] flex-col items-end gap-2">
          <DayDisplay time={time} />
          <AnimatePresence mode="wait">
            {disasterMenuOpen && (
              <motion.div
                key="disaster-menu"
                className="w-full max-w-[min(90vw,520px)]"
                initial={{ x: 48, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 48, opacity: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
              >
                <DisasterMenu
                  open={disasterMenuOpen}
                  severedNodeId={severedNodeId}
                  time={time}
                  setTime={setTime}
                  onClose={() => {
                    setTime(0);
                    setSeveredNodeId(null);
                    setDisasterMenuOpen(false);
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      {/* Legend */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-30 flex items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900/80 px-3 py-2 text-xs text-neutral-300 backdrop-blur-sm">
        <span>🏭 Manufacturer</span>
        <span className="text-neutral-600">→</span>
        <span>🚢 Port</span>
        <span className="text-neutral-600">→</span>
        <span>📦 Distribution</span>
        <span className="text-neutral-600">→</span>
        <span>🏥 Hospital</span>
      </div>

      {/* Instruction hint (shown when no simulation active) */}
      <AnimatePresence>
        {!disasterMenuOpen && (
          <motion.div
            key="instruction-hint"
            className="pointer-events-none absolute left-1/2 top-20 z-30 -translate-x-1/2"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
          >
            <div className="rounded-lg border border-neutral-600 bg-neutral-900/90 px-5 py-3 text-sm text-neutral-300 backdrop-blur-sm">
              Click any supply chain node to simulate a disruption
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Info button */}
      <button
        type="button"
        onClick={() => setInfoOpen((v) => !v)}
        aria-label="About Unchained"
        className="absolute bottom-4 right-4 z-30 flex size-10 items-center justify-center rounded-full border border-neutral-600 bg-neutral-900/80 text-lg font-bold text-white backdrop-blur-sm transition hover:bg-neutral-800"
      >
        i
      </button>

      {/* Info panel */}
      <AnimatePresence>
        {infoOpen && (
          <motion.div
            key="info-panel"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="absolute bottom-16 right-4 z-30 w-80 rounded-xl border border-neutral-700 bg-neutral-900/95 p-5 text-sm text-neutral-300 shadow-xl backdrop-blur-md"
          >
            <h3 className="mb-3 text-base font-bold text-white">About Unchained</h3>
            <p className="mb-3 leading-relaxed">
              AI-powered supply chain disruption forecasting for healthcare, built on a
              spatiotemporal Graph Neural Network (GAT + GRU).
            </p>
            <div className="mb-3 space-y-2 text-xs">
              <div className="flex justify-between border-b border-neutral-800 pb-1">
                <span className="text-neutral-500">Architecture</span>
                <span>Graph Attention Network + GRU</span>
              </div>
              <div className="flex justify-between border-b border-neutral-800 pb-1">
                <span className="text-neutral-500">Network</span>
                <span>500 nodes, 996 edges</span>
              </div>
              <div className="flex justify-between border-b border-neutral-800 pb-1">
                <span className="text-neutral-500">Forecast horizon</span>
                <span>14 days</span>
              </div>
              <div className="flex justify-between border-b border-neutral-800 pb-1">
                <span className="text-neutral-500">Scenarios</span>
                <span>4 disruption simulations</span>
              </div>
            </div>
            <div className="rounded-md bg-neutral-800/80 px-3 py-2 text-xs leading-relaxed text-neutral-400">
              <p className="mb-1 font-semibold text-neutral-300">Why this matters</p>
              <p>
                In 2024, a single flooded factory cut 60% of US IV supply. 80% of hospitals
                were affected. 100% of hospital pharmacists faced a critical shortage that year.
                The US loses $25.7B annually to supply chain inefficiency.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={[
          networkEdgeLayer,
          shockwaveLayer,
          networkNodeLayer,
          severedEdgeShadowLayer,
          severedEdgeCoreLayer,
          severedEdgeShineLayer,
          edgeLayerHealthy,
          nodeIconLayer,
        ]}
        getCursor={({ isDragging, isHovering }) =>
          isDragging ? "grabbing" : isHovering ? "pointer" : "grab"
        }
        style={{ width: "100%", height: "100%" }}
      >
        <MapboxMap
          mapboxAccessToken={mapboxToken}
          mapStyle="mapbox://styles/mapbox/dark-v11"
          projection="mercator"
        />
      </DeckGL>
      {hoveredNetworkNode && (
        <div
          className="pointer-events-none absolute z-40 rounded-lg border border-neutral-600 bg-neutral-900/90 px-3 py-2 text-sm text-white backdrop-blur-sm"
          style={{
            left: "50%",
            bottom: "2rem",
            transform: "translateX(-50%)",
          }}
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold capitalize">{hoveredNetworkNode.type}</span>
            <span className="text-neutral-400">·</span>
            <span className={hoveredNetworkNode.health > 0.6 ? "text-green-400" : hoveredNetworkNode.health > 0.3 ? "text-yellow-400" : "text-red-400"}>
              {Math.round(hoveredNetworkNode.health * 100)}% supply
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
