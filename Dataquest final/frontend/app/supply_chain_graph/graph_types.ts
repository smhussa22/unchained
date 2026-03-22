export type NodeType = "manufacturer" | "port" | "distribution" | "hospital";

export type Node = {
  id: string;
  name: string;
  position: [number, number];
  type: NodeType;
};

export type Edge = {
  id: string;
  from: string;
  to: string;
  active: boolean;
};
