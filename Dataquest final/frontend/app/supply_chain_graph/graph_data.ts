import { Node, Edge } from "./graph_types";

export const nodes: Node[] = [
{
id: "manufacturer",
name: "Manufacturer",
position: [-66.15, 18.44],
type: "manufacturer",
},
{
id: "port-miami",
name: "PortMiami",
position: [-80.1794, 25.7781],
type: "port",
},
{
id: "dc-us",
name: "US Distribution",
position: [-83.7205, 33.9926],
type: "distribution",
},
{
id: "dc-ca",
name: "CA Distribution",
position: [-79.746, 43.5986],
type: "distribution",
},
{
id: "hospital",
name: "LHSC",
position: [-81.2737, 43.0096],
type: "hospital",
},
];

export const edges: Edge[] = [
{ id: "e1", from: "manufacturer", to: "port-miami", active: true },
{ id: "e2", from: "port-miami", to: "dc-us", active: true },
{ id: "e3", from: "dc-us", to: "dc-ca", active: true },
{ id: "e4", from: "dc-ca", to: "hospital", active: true },
];
