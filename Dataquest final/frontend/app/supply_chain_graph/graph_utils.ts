import type { Edge, Node } from "./graph_types";

/** Hospital-first chain walking upstream (toward manufacturer). */
export function buildSupplyChainChain(nodes: Node[], edges: Edge[]): Node[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string>();
  for (const e of edges) {
    incoming.set(e.to, e.from);
  }

  const hospital =
    nodes.find((n) => n.type === "hospital") ?? nodes.find((n) => n.id === "hospital");
  if (!hospital) return [];

  const chain: Node[] = [];
  let current: Node | undefined = hospital;
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const fromId = incoming.get(current.id);
    if (!fromId) break;
    current = nodeMap.get(fromId);
  }

  return chain;
}

/**
 * Gap index `i` is between chain[i] (hospital-side / downstream) and chain[i + 1] (upstream).
 * Returns the directed edge from upstream → downstream.
 */
export function edgeForGap(chain: Node[], gapIndex: number, edges: Edge[]): Edge | undefined {
  const downstream = chain[gapIndex];
  const upstream = chain[gapIndex + 1];
  if (!downstream || !upstream) return undefined;
  return edges.find((e) => e.from === upstream.id && e.to === downstream.id);
}

/** Endpoint closer to hospital (chain[0]); chain order is hospital → … → manufacturer. */
export function downstreamEndpointId(edge: Edge, chain: Node[]): string {
  const iFrom = chain.findIndex((n) => n.id === edge.from);
  const iTo = chain.findIndex((n) => n.id === edge.to);
  if (iFrom < 0 || iTo < 0) return edge.to;
  const i = Math.min(iFrom, iTo);
  return chain[i]!.id;
}

export function incidentEdges(nodeId: string, edges: Edge[]): Edge[] {
  return edges.filter((e) => e.from === nodeId || e.to === nodeId);
}

/**
 * True when this edge is the disrupted link **leaving** `severedNodeId` (downstream toward hospital).
 * The incoming edge from upstream stays healthy — only the “next” segment is severed.
 */
export function edgeIsSeveredAtNode(
  edge: Edge,
  severedNodeId: string | null
): boolean {
  if (!severedNodeId) return false;
  return edge.from === severedNodeId;
}

export function nodeNameMap(nodes: Node[]): Map<string, string> {
  return new Map(nodes.map((n) => [n.id, n.name]));
}
