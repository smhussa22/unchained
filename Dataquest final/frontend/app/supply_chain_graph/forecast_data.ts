export type NetworkNode = {
  position: [number, number];
  type: "manufacturer" | "port" | "distribution" | "hospital";
  forecasts: number[];
  scenarioForecasts?: Record<string, number[]>;
};

export type NetworkEdge = {
  sourcePosition: [number, number];
  targetPosition: [number, number];
};

export type ChainNodeForecast = {
  baseline: number[];
  scenarios: Record<string, number[]>;
};

export type ForecastData = {
  chainForecasts: Record<string, ChainNodeForecast>;
  networkNodes: NetworkNode[];
  networkEdges: NetworkEdge[];
};

let forecast: ForecastData | null = null;
try {
  forecast = require("../../public/forecast.json") as ForecastData;
} catch {
  /* forecast.json not generated yet */
}
export { forecast };
