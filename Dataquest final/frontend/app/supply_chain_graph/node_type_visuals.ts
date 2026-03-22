import type { IconType } from "react-icons";
import { GiCargoShip, GiFactory } from "react-icons/gi";
import { MdOutlineLocalHospital } from "react-icons/md";
import { PiPackageFill } from "react-icons/pi";
import type { NodeType } from "./graph_types";

/** Tailwind-aligned hex colors (match DisasterMenu `text-*-400` classes). */
const FILL = {
  hospital: "#c084fc",
  port: "#60a5fa",
  distribution: "#f87171",
  manufacturer: "#facc15",
} as const;

const DISK = "#171717";

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** React icon + class for the disaster menu chain UI. */
export const NODE_TYPE_VISUAL: Record<
  NodeType,
  { Icon: IconType; colorClass: string; fill: string }
> = {
  hospital: {
    Icon: MdOutlineLocalHospital,
    colorClass: "text-purple-400",
    fill: FILL.hospital,
  },
  port: {
    Icon: GiCargoShip,
    colorClass: "text-blue-400",
    fill: FILL.port,
  },
  distribution: {
    Icon: PiPackageFill,
    colorClass: "text-red-400",
    fill: FILL.distribution,
  },
  manufacturer: {
    Icon: GiFactory,
    colorClass: "text-yellow-400",
    fill: FILL.manufacturer,
  },
};

// Paths copied from react-icons (same glyphs as DisasterMenu).
const PATH_HOSPITAL =
  "M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-8.5-2h3v-3.5H17v-3h-3.5V7h-3v3.5H7v3h3.5z";

const PATH_SHIP =
  "M80 23v18h23v14h18V41h23V23zm-8.2 50L42.38 279H135V144.5H95.5v-49H135V73zM185 137v46h78v-46zm96 0v46h78v-46zm96 0v46h78v-46zm-192 64v46h78v-46zm96 0v46h78v-46zm96 0v46h78v-46zm-192 64v46h78v-46zm96 0v46h19.3l32-32H359v-14zm96 0v14h78v-14zM27.22 297l24.11 108.5C76.75 398.1 105.7 391 128 391c24.2 0 46.2 8.6 67.2 16.6 21 8 41 15.4 60.8 15.4 19.8 0 39.8-7.4 60.8-15.4 19-7.2 38.9-15 60.5-16.4l-44.1-14.7 5.6-17 36.2 12V345h-17v-18h17v-30h-35.3l-32 32H154.4l-16-32zM393 297v30h17v18h-17v26.5l36.2-12 5.6 17-44 14.7c12.1.7 25.7 3.1 39.4 6.2 5.4-7.1 10.8-15.3 16.1-24 14.9-24.9 28.2-53.9 36.8-76.4zM128 407c-24.2 0-56.26 8.3-83.09 16.4-10.02 3-19.26 6-26.91 8.7v19c8.36-3 19.57-6.7 32.11-10.5C76.28 432.7 108.2 425 128 425c19.8 0 39.8 7.4 60.8 15.4s43 16.6 67.2 16.6c24.2 0 46.2-8.6 67.2-16.6 21-8 41-15.4 60.8-15.4 19.8 0 51.7 7.7 77.9 15.6 12.5 3.8 23.7 7.5 32.1 10.5v-19c-7.7-2.6-16.9-5.7-26.9-8.7-26.8-8.1-58.9-16.4-83.1-16.4-24.2 0-46.2 8.6-67.2 16.6-21 8-41 15.4-60.8 15.4-19.8 0-39.8-7.4-60.8-15.4S152.2 407 128 407zm0 36c-24.2 0-56.26 8.3-83.09 16.4-10.02 3-19.26 6-26.91 8.7v19c8.36-3 19.57-6.7 32.11-10.5C76.28 468.7 108.2 461 128 461c19.8 0 39.8 7.4 60.8 15.4s43 16.6 67.2 16.6c24.2 0 46.2-8.6 67.2-16.6 21-8 41-15.4 60.8-15.4 19.8 0 51.7 7.7 77.9 15.6 12.5 3.8 23.7 7.5 32.1 10.5v-19c-7.7-2.6-16.9-5.7-26.9-8.7-26.8-8.1-58.9-16.4-83.1-16.4-24.2 0-46.2 8.6-67.2 16.6-21 8-41 15.4-60.8 15.4-19.8 0-39.8-7.4-60.8-15.4S152.2 443 128 443z";

const PATH_PACKAGE =
  "M223.68,66.15,135.68,18a15.88,15.88,0,0,0-15.36,0l-88,48.17a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.88,15.88,0,0,0,15.36,0l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15ZM128,32l80.35,44L178.57,92.29l-80.35-44Zm0,88L47.65,76,81.56,57.43l80.35,44Zm88,55.85h0l-80,43.79V133.83l32-17.51V152a8,8,0,0,0,16,0V107.56l32-17.51v85.76Z";

const PATH_FACTORY =
  "M384 64l.387 256H368l-96-128-16 128-96-128-16 128-96-128-16 128v160h448V64h-32v256h-32V64h-32zM64 352h48v32H64v-32zm80 0h48v32h-48v-32zm80 0h48v32h-48v-32zm80 0h48v32h-48v-32zM64 416h48v32H64v-32zm80 0h48v32h-48v-32zm80 0h48v32h-48v-32zm80 0h48v32h-48v-32z";

/** Raster-sized SVGs for deck.gl IconLayer (disk matches menu `bg-neutral-900`). */
export const NODE_TYPE_ICON_DATA_URL: Record<NodeType, string> = {
  hospital: svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 24 24">` +
      `<circle cx="12" cy="12" r="11" fill="${DISK}"/>` +
      `<path fill="none" stroke="${FILL.hospital}" stroke-width="1.15" stroke-linejoin="round" d="${PATH_HOSPITAL}"/>` +
      `</svg>`
  ),
  port: svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 512 512">` +
      `<circle cx="256" cy="256" r="248" fill="${DISK}"/>` +
      `<path fill="${FILL.port}" d="${PATH_SHIP}"/>` +
      `</svg>`
  ),
  distribution: svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 256 256">` +
      `<circle cx="128" cy="128" r="120" fill="${DISK}"/>` +
      `<path fill="${FILL.distribution}" d="${PATH_PACKAGE}"/>` +
      `</svg>`
  ),
  manufacturer: svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 512 512">` +
      `<circle cx="256" cy="256" r="248" fill="${DISK}"/>` +
      `<path fill="${FILL.manufacturer}" d="${PATH_FACTORY}"/>` +
      `</svg>`
  ),
};
