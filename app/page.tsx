"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { FeatureGroup, Map as LeafletMap } from "leaflet";
import {
  Check, ChevronRight, CircleHelp, Download, Eye, EyeOff, FileText,
  FolderOpen, LocateFixed, Map as MapIcon, Mountain, Navigation,
  PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Route, ShieldCheck, Trash2,
  UploadCloud, X,
} from "lucide-react";

type GeoFeature = Feature<Geometry, Record<string, unknown>>;
type ImportableGeoFile = {
  name: string;
  size: number;
  text: () => Promise<string>;
};
type DesktopGeoFile = {
  name: string;
  size: number;
  text: string;
};
type Dataset = {
  id: string;
  name: string;
  format: "KML" | "GPX";
  size: number;
  features: GeoFeature[];
  visible: boolean;
  color: string;
};
type GeoStats = {
  points: number;
  lines: number;
  areas: number;
  coordinateCount: number;
  distanceKm: number;
  ascent: number;
  minEle: number | null;
  maxEle: number | null;
  startTime: Date | null;
  endTime: Date | null;
};

const COLORS = ["#ef6b4a", "#187f77", "#dca63a", "#465c86", "#b65b81", "#66864f"];
const GEO_GRID_STEPS = [
  0.0001, 0.0002, 0.0005,
  0.001, 0.002, 0.005,
  0.01, 0.02, 0.05,
  0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30, 45, 90,
];

function gridStep(span: number) {
  const target = Math.max(span / 8, GEO_GRID_STEPS[0]);
  return GEO_GRID_STEPS.find((step) => step >= target) ?? 180;
}

function coordinateLabel(value: number, axis: "lat" | "lon", step: number) {
  const normalized = axis === "lon"
    ? ((value + 180) % 360 + 360) % 360 - 180
    : Math.max(-90, Math.min(90, value));
  const precision = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  const absolute = Math.abs(normalized).toFixed(precision);
  if (Math.abs(normalized) < step / 100) return `${absolute}°`;
  const hemisphere = axis === "lat"
    ? (normalized > 0 ? "N" : "S")
    : (normalized > 0 ? "E" : "W");
  return `${absolute}°${hemisphere}`;
}

function directText(element: Element, tagName: string) {
  return Array.from(element.children)
    .find((node) => node.localName.toLowerCase() === tagName.toLowerCase())
    ?.textContent?.trim() ?? "";
}

function byLocalName(root: ParentNode, name: string) {
  return Array.from(root.querySelectorAll("*"))
    .filter((node) => node.localName.toLowerCase() === name.toLowerCase());
}

function parseCoordinates(text: string): number[][] {
  return text.trim().replace(/\s*,\s*/g, ",").split(/[\s;]+/)
    .map((tuple) => tuple.split(",").map(Number))
    .filter((coord) => coord.length >= 2 && coord.every(Number.isFinite))
    .map(([lon, lat, ele]) => Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat]);
}

function parseGxCoordinate(text: string): number[] | null {
  const values = text.trim().split(/[\s,]+/).map(Number);
  if (values.length < 2 || !values.every(Number.isFinite)) return null;
  const [lon, lat, ele] = values;
  return Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat];
}

function inheritedKmlName(placemark: Element, fallbackIndex: number) {
  let current: Element | null = placemark;
  while (current) {
    const name = directText(current, "name");
    if (name) return name;
    current = current.parentElement;
  }
  return `KML 要素 ${fallbackIndex + 1}`;
}

function parseXml(text: string, fileName: string) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error(`${fileName} 不是有效的 XML 文件`);
  return xml;
}

function parseKml(text: string, fileName: string): GeoFeature[] {
  const xml = parseXml(text, fileName);
  const features: GeoFeature[] = [];
  const geometryNames = new Set(["point", "linestring", "polygon", "track"]);
  const geometries = Array.from(xml.querySelectorAll("*")).filter((node) =>
    geometryNames.has(node.localName.toLowerCase()),
  );

  geometries.forEach((node, geometryIndex) => {
    const placemark = node.closest("Placemark, placemark") ??
      Array.from(byLocalName(xml, "Placemark")).find((candidate) => candidate.contains(node)) ??
      null;
    const owner = placemark ?? node.parentElement ?? node;
    const properties: Record<string, unknown> = {
      name: inheritedKmlName(owner, geometryIndex),
    };
    const description = directText(owner, "description");
    if (description) properties.description = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    byLocalName(owner, "Data").forEach((data) => {
      const key = data.getAttribute("name");
      const value = byLocalName(data, "value")[0]?.textContent?.trim();
      if (key && value) properties[key] = value;
    });

    const kind = node.localName.toLowerCase();
    const siblingGeometryCount = placemark
      ? geometries.filter((candidate) => placemark.contains(candidate)).length
      : 1;
    const props = siblingGeometryCount > 1 ? { ...properties, part: geometryIndex + 1 } : { ...properties };
      if (kind === "point") {
        const coordinates = parseCoordinates(byLocalName(node, "coordinates")[0]?.textContent ?? "")[0];
        if (coordinates) features.push({
          type: "Feature",
          id: `kml-${geometryIndex}`,
          properties: props,
          geometry: { type: "Point", coordinates },
        });
      }
      if (kind === "linestring") {
        const coordinates = parseCoordinates(byLocalName(node, "coordinates")[0]?.textContent ?? "");
        if (coordinates.length > 1) features.push({
          type: "Feature",
          id: `kml-${geometryIndex}`,
          properties: props,
          geometry: { type: "LineString", coordinates },
        });
      }
      if (kind === "track") {
        const timeNodes = byLocalName(node, "when");
        const samples = byLocalName(node, "coord")
          .map((coordNode, index) => ({
            coordinates: parseGxCoordinate(coordNode.textContent ?? ""),
            time: timeNodes[index]?.textContent?.trim() || null,
          }))
          .filter((sample): sample is { coordinates: number[]; time: string | null } =>
            sample.coordinates !== null,
          );
        if (samples.length > 1) features.push({
          type: "Feature",
          id: `kml-track-${geometryIndex}`,
          properties: {
            ...props,
            kind: "track",
            times: samples.map((sample) => sample.time),
          },
          geometry: {
            type: "LineString",
            coordinates: samples.map((sample) => sample.coordinates),
          },
        });
      }
      if (kind === "polygon") {
        const rings = Array.from(node.children)
          .filter((child) => ["outerboundaryis", "innerboundaryis"].includes(child.localName.toLowerCase()))
          .map((boundary) => parseCoordinates(byLocalName(boundary, "coordinates")[0]?.textContent ?? ""))
          .filter((ring) => ring.length > 3);
        if (rings.length) features.push({
          type: "Feature",
          id: `kml-${geometryIndex}`,
          properties: props,
          geometry: { type: "Polygon", coordinates: rings },
        });
      }
  });
  if (!features.length) throw new Error(`${fileName} 中没有找到可显示的地理要素`);
  return features;
}

function gpxPoint(node: Element) {
  const lon = Number(node.getAttribute("lon"));
  const lat = Number(node.getAttribute("lat"));
  const elevationText = directText(node, "ele");
  const elevation = elevationText === "" ? null : Number(elevationText);
  return {
    coordinates: elevation !== null && Number.isFinite(elevation) ? [lon, lat, elevation] : [lon, lat],
    time: directText(node, "time") || undefined,
  };
}

function parseGpx(text: string, fileName: string): GeoFeature[] {
  const xml = parseXml(text, fileName);
  const features: GeoFeature[] = [];
  byLocalName(xml, "trk").forEach((track, trackIndex) => {
    const name = directText(track, "name") || `轨迹 ${trackIndex + 1}`;
    const segments = Array.from(track.children).filter((node) => node.localName.toLowerCase() === "trkseg");
    segments.forEach((segment, segmentIndex) => {
      const points = Array.from(segment.children)
        .filter((node) => node.localName.toLowerCase() === "trkpt")
        .map(gpxPoint)
        .filter((point) => point.coordinates.slice(0, 2).every(Number.isFinite));
      if (points.length > 1) features.push({
        type: "Feature",
        id: `gpx-track-${trackIndex}-${segmentIndex}`,
        properties: {
          name: segments.length > 1 ? `${name} · 分段 ${segmentIndex + 1}` : name,
          kind: "track",
          times: points.map((point) => point.time ?? null),
        },
        geometry: { type: "LineString", coordinates: points.map((point) => point.coordinates) },
      });
    });
  });
  byLocalName(xml, "rte").forEach((route, routeIndex) => {
    const points = Array.from(route.children)
      .filter((node) => node.localName.toLowerCase() === "rtept")
      .map(gpxPoint)
      .filter((point) => point.coordinates.slice(0, 2).every(Number.isFinite));
    if (points.length > 1) features.push({
      type: "Feature",
      id: `gpx-route-${routeIndex}`,
      properties: {
        name: directText(route, "name") || `路线 ${routeIndex + 1}`,
        kind: "route",
        times: points.map((point) => point.time ?? null),
      },
      geometry: { type: "LineString", coordinates: points.map((point) => point.coordinates) },
    });
  });
  byLocalName(xml, "wpt").forEach((waypoint, waypointIndex) => {
    const point = gpxPoint(waypoint);
    if (point.coordinates.slice(0, 2).every(Number.isFinite)) features.push({
      type: "Feature",
      id: `gpx-waypoint-${waypointIndex}`,
      properties: {
        name: directText(waypoint, "name") || `路点 ${waypointIndex + 1}`,
        description: directText(waypoint, "desc") || directText(waypoint, "cmt"),
        symbol: directText(waypoint, "sym"),
        time: point.time,
      },
      geometry: { type: "Point", coordinates: point.coordinates },
    });
  });
  if (!features.length) throw new Error(`${fileName} 中没有找到轨迹、路线或路点`);
  return features;
}

function haversine(a: number[], b: number[]) {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const value = Math.sin(dLat / 2) ** 2
    + Math.sin(dLon / 2) ** 2 * Math.cos(rad(a[1])) * Math.cos(rad(b[1]));
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function coordinateSequences(feature: GeoFeature): number[][][] {
  const geometry = feature.geometry;
  if (geometry.type === "Point") return [[geometry.coordinates as number[]]];
  if (geometry.type === "LineString") return [geometry.coordinates as number[][]];
  if (geometry.type === "Polygon") return geometry.coordinates as number[][][];
  if (geometry.type === "MultiPoint") return [geometry.coordinates as number[][]];
  if (geometry.type === "MultiLineString") return geometry.coordinates as number[][][];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as number[][][][]).flat();
  return [];
}

function statsFor(features: GeoFeature[]): GeoStats {
  const stats: GeoStats = {
    points: 0, lines: 0, areas: 0, coordinateCount: 0, distanceKm: 0, ascent: 0,
    minEle: null, maxEle: null, startTime: null, endTime: null,
  };
  for (const feature of features) {
    if (feature.geometry.type.includes("Point")) stats.points += 1;
    if (feature.geometry.type.includes("Line")) stats.lines += 1;
    if (feature.geometry.type.includes("Polygon")) stats.areas += 1;
    for (const sequence of coordinateSequences(feature)) {
      stats.coordinateCount += sequence.length;
      sequence.forEach((coord, index) => {
        if (Number.isFinite(coord[2])) {
          stats.minEle = stats.minEle === null ? coord[2] : Math.min(stats.minEle, coord[2]);
          stats.maxEle = stats.maxEle === null ? coord[2] : Math.max(stats.maxEle, coord[2]);
        }
        if (index > 0 && feature.geometry.type.includes("Line")) {
          stats.distanceKm += haversine(sequence[index - 1], coord);
          const previous = sequence[index - 1][2];
          if (Number.isFinite(previous) && Number.isFinite(coord[2]) && coord[2] > previous) {
            stats.ascent += coord[2] - previous;
          }
        }
      });
    }
    const times = Array.isArray(feature.properties?.times)
      ? feature.properties.times.filter(Boolean).map(String)
      : feature.properties?.time ? [String(feature.properties.time)] : [];
    for (const time of times) {
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) continue;
      if (!stats.startTime || date < stats.startTime) stats.startTime = date;
      if (!stats.endTime || date > stats.endTime) stats.endTime = date;
    }
  }
  return stats;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function duration(start: Date | null, end: Date | null) {
  if (!start || !end) return "—";
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}时 ${minutes % 60}分` : `${minutes} 分钟`;
}

function featureKind(feature: GeoFeature) {
  if (feature.geometry.type.includes("Point")) return "点位";
  if (feature.geometry.type.includes("Polygon")) return "区域";
  return feature.properties?.kind === "route" ? "路线" : "轨迹";
}

function demoDataset(): Dataset {
  const coordinates = [
    [116.316, 39.998, 48], [116.321, 40.004, 55], [116.328, 40.009, 64],
    [116.337, 40.012, 59], [116.345, 40.009, 72], [116.351, 40.003, 81],
    [116.346, 39.996, 68], [116.338, 39.992, 61],
  ];
  return {
    id: crypto.randomUUID(),
    name: "北京西山晨间路线.gpx",
    format: "GPX",
    size: 2840,
    visible: true,
    color: COLORS[0],
    features: [
      {
        type: "Feature", id: "demo-track",
        properties: { name: "晨间环线", kind: "track" },
        geometry: { type: "LineString", coordinates },
      },
      {
        type: "Feature", id: "demo-point",
        properties: { name: "观景台", description: "短暂休息与补水" },
        geometry: { type: "Point", coordinates: coordinates[4] },
      },
    ],
  };
}

export default function Home() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const layersRef = useRef<Map<string, FeatureGroup>>(new Map());
  const gridLayerRef = useRef<FeatureGroup | null>(null);
  const tileLayerRef = useRef<import("leaflet").TileLayer | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingFitIdsRef = useRef<string[] | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [streetMap, setStreetMap] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<FieldnoteUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const selected = datasets.find((item) => item.id === selectedId) ?? datasets[0] ?? null;
  const selectedStats = useMemo(() => statsFor(selected?.features ?? []), [selected]);
  const overallStats = useMemo(
    () => statsFor(datasets.filter((item) => item.visible).flatMap((item) => item.features)),
    [datasets],
  );

  const fitDatasets = useCallback((ids?: string[]) => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    const bounds = L.latLngBounds([]);
    layersRef.current.forEach((layer, id) => {
      if (!ids || ids.includes(id)) {
        const layerBounds = layer.getBounds();
        if (layerBounds.isValid()) bounds.extend(layerBounds);
      }
    });
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [44, 44], maxZoom: 15 });
  }, []);

  useEffect(() => {
    let mounted = true;
    import("leaflet").then((L) => {
      if (!mounted || !mapNode.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(mapNode.current, {
        zoomControl: false, attributionControl: true, preferCanvas: true,
      }).setView([35.7, 104.1], 4);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      mapRef.current = map;
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 50);
    });
    return () => {
      mounted = false;
      setMapReady(false);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    Array.from(layersRef.current.keys()).forEach((id) => {
      if (!datasets.some((dataset) => dataset.id === id)) {
        const layer = layersRef.current.get(id);
        if (layer) map.removeLayer(layer);
        layersRef.current.delete(id);
      }
    });
    datasets.forEach((dataset) => {
      let group = layersRef.current.get(dataset.id);
      if (!group) {
        group = L.featureGroup();
        dataset.features.forEach((feature) => {
          const label = String(feature.properties?.name ?? "未命名要素").replace(/[<>&"]/g, "");
          const popup = `<strong>${label}</strong><small>${featureKind(feature)}</small>`;
          if (feature.geometry.type === "Point") {
            const [lon, lat] = feature.geometry.coordinates as number[];
            L.circleMarker([lat, lon], {
              radius: 7, color: "#fffdf7", weight: 3,
              fillColor: dataset.color, fillOpacity: 1,
            }).bindPopup(popup).addTo(group!);
          } else if (feature.geometry.type === "LineString") {
            const points = (feature.geometry.coordinates as number[][])
              .map(([lon, lat]) => [lat, lon] as [number, number]);
            L.polyline(points, {
              color: dataset.color, weight: 5, opacity: 0.95,
              lineCap: "round", lineJoin: "round",
            }).bindPopup(popup).addTo(group!);
          } else if (feature.geometry.type === "Polygon") {
            const rings = (feature.geometry.coordinates as number[][][])
              .map((ring) => ring.map(([lon, lat]) => [lat, lon] as [number, number]));
            L.polygon(rings, {
              color: dataset.color, weight: 3, fillColor: dataset.color, fillOpacity: 0.18,
            }).bindPopup(popup).addTo(group!);
          }
        });
        layersRef.current.set(dataset.id, group);
      }
      if (dataset.visible && !map.hasLayer(group)) group.addTo(map);
      if (!dataset.visible && map.hasLayer(group)) map.removeLayer(group);
    });
    if (pendingFitIdsRef.current) {
      fitDatasets(pendingFitIdsRef.current);
      pendingFitIdsRef.current = null;
    }
  }, [datasets, fitDatasets, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;

    const tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      keepBuffer: 4,
      updateWhenIdle: false,
      updateWhenZooming: true,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    tileLayerRef.current = tileLayer;
    tileLayer.bringToBack();
    return () => {
      if (map.hasLayer(tileLayer)) map.removeLayer(tileLayer);
      if (tileLayerRef.current === tileLayer) tileLayerRef.current = null;
    };
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L || streetMap) return;

    let pane = map.getPane("coordinateGridPane");
    if (!pane) pane = map.createPane("coordinateGridPane");
    pane.style.zIndex = "250";
    pane.style.pointerEvents = "none";

    const gridLayer = gridLayerRef.current ?? L.featureGroup();
    gridLayerRef.current = gridLayer;
    gridLayer.addTo(map);

    const drawCoordinateGrid = () => {
      gridLayer.clearLayers();
      const bounds = map.getBounds();
      const south = Math.max(-85, bounds.getSouth());
      const north = Math.min(85, bounds.getNorth());
      const west = bounds.getWest();
      const east = bounds.getEast();
      if (south >= north || west >= east) return;

      const latStep = gridStep(north - south);
      const lonStep = gridStep(east - west);
      const labelLat = south + (north - south) * 0.025;
      const labelLon = west + (east - west) * 0.012;

      const firstLon = Math.ceil(west / lonStep) * lonStep;
      for (let lon = firstLon, count = 0; lon <= east + lonStep / 100 && count < 40; lon += lonStep, count += 1) {
        const major = Math.abs(Math.round(lon / lonStep)) % 5 === 0;
        L.polyline([[south, lon], [north, lon]], {
          pane: "coordinateGridPane",
          interactive: false,
          color: major ? "#477267" : "#66877f",
          weight: major ? 1.25 : 1,
          opacity: major ? 0.42 : 0.25,
          dashArray: major ? undefined : "3 5",
        }).addTo(gridLayer);
        L.marker([labelLat, lon], {
          pane: "coordinateGridPane",
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "coordinate-label coordinate-label-lon",
            html: `<span>${coordinateLabel(lon, "lon", lonStep)}</span>`,
            iconSize: [0, 0],
          }),
        }).addTo(gridLayer);
      }

      const firstLat = Math.ceil(south / latStep) * latStep;
      for (let lat = firstLat, count = 0; lat <= north + latStep / 100 && count < 40; lat += latStep, count += 1) {
        const major = Math.abs(Math.round(lat / latStep)) % 5 === 0;
        L.polyline([[lat, west], [lat, east]], {
          pane: "coordinateGridPane",
          interactive: false,
          color: major ? "#477267" : "#66877f",
          weight: major ? 1.25 : 1,
          opacity: major ? 0.42 : 0.25,
          dashArray: major ? undefined : "3 5",
        }).addTo(gridLayer);
        L.marker([lat, labelLon], {
          pane: "coordinateGridPane",
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "coordinate-label coordinate-label-lat",
            html: `<span>${coordinateLabel(lat, "lat", latStep)}</span>`,
            iconSize: [0, 0],
          }),
        }).addTo(gridLayer);
      }
    };

    map.on("moveend zoomend resize", drawCoordinateGrid);
    drawCoordinateGrid();
    return () => {
      map.off("moveend zoomend resize", drawCoordinateGrid);
      if (map.hasLayer(gridLayer)) map.removeLayer(gridLayer);
    };
  }, [streetMap, mapReady]);

  const importFiles = useCallback(async (list: FileList | ImportableGeoFile[]) => {
    const files = Array.from(list);
    if (!files.length) return;
    setLoading(true);
    setError("");
    const imported: Dataset[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (extension !== "kml" && extension !== "gpx") {
        rejected.push(`${file.name}：仅支持 .kml 或 .gpx`);
        continue;
      }
      try {
        const content = await file.text();
        const features = extension === "kml" ? parseKml(content, file.name) : parseGpx(content, file.name);
        imported.push({
          id: crypto.randomUUID(),
          name: file.name,
          format: extension.toUpperCase() as "KML" | "GPX",
          size: file.size,
          features,
          visible: true,
          color: COLORS[(datasets.length + imported.length) % COLORS.length],
        });
      } catch (cause) {
        rejected.push(cause instanceof Error ? cause.message : `${file.name} 解析失败`);
      }
    }
    if (imported.length) {
      const importedIds = imported.map((item) => item.id);
      pendingFitIdsRef.current = importedIds;
      setDatasets((current) => [...current, ...imported]);
      setSelectedId(imported[0].id);
      setNotice(`已载入 ${imported.length} 个文件`);
      setTimeout(() => {
        if (!pendingFitIdsRef.current) return;
        fitDatasets(importedIds);
        if (mapRef.current && importedIds.every((id) => layersRef.current.has(id))) {
          pendingFitIdsRef.current = null;
        }
      }, 180);
    }
    if (rejected.length) setError(rejected.join("；"));
    setLoading(false);
    if (inputRef.current) inputRef.current.value = "";
  }, [datasets.length, fitDatasets]);

  useEffect(() => {
    if (!window.fieldnote) return;
    return window.fieldnote.onOpenFiles((files: DesktopGeoFile[]) => {
      importFiles(files.map((file) => ({
        name: file.name,
        size: file.size,
        text: async () => file.text,
      })));
    });
  }, [importFiles]);

  useEffect(() => {
    const desktop = window.fieldnote;
    if (!desktop?.checkForUpdates) return;
    const unsubscribe = desktop.onUpdateStatus?.(setUpdateStatus);
    desktop.checkForUpdates(false).then(setUpdateStatus).catch(() => undefined);
    const timer = window.setInterval(() => {
      desktop.checkForUpdates?.(false).then(setUpdateStatus).catch(() => undefined);
    }, 6 * 60 * 60 * 1000);
    return () => {
      unsubscribe?.();
      window.clearInterval(timer);
    };
  }, []);

  const openFilePicker = useCallback(async () => {
    if (!window.fieldnote) {
      inputRef.current?.click();
      return;
    }
    const files = await window.fieldnote.pickGeoFiles();
    if (files.length) {
      await importFiles(files.map((file) => ({
        name: file.name,
        size: file.size,
        text: async () => file.text,
      })));
    }
  }, [importFiles]);

  function addDemo() {
    const demo = demoDataset();
    pendingFitIdsRef.current = [demo.id];
    setDatasets((current) => [...current, demo]);
    setSelectedId(demo.id);
    setNotice("示例路线已载入");
    setTimeout(() => fitDatasets([demo.id]), 180);
  }

  function removeDataset(id: string) {
    const remaining = datasets.filter((item) => item.id !== id);
    setDatasets(remaining);
    if (selectedId === id) setSelectedId(null);
    setNotice("文件已从工作区移除");
    window.setTimeout(() => {
      const visibleIds = remaining.filter((item) => item.visible).map((item) => item.id);
      if (visibleIds.length) fitDatasets(visibleIds);
      else mapRef.current?.setView([35.7, 104.1], 4);
    }, 80);
  }

  function toggleDataset(id: string) {
    setDatasets((current) => current.map((item) =>
      item.id === id ? { ...item, visible: !item.visible } : item,
    ));
  }

  function exportGeoJson() {
    if (!selected) return;
    const collection: FeatureCollection = { type: "FeatureCollection", features: selected.features };
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = selected.name.replace(/\.(kml|gpx)$/i, "") + ".geojson";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("GeoJSON 已导出");
  }

  async function handleUpdate() {
    const desktop = window.fieldnote;
    if (!desktop?.checkForUpdates) return;
    if (updateStatus?.state === "available" && desktop.installUpdate) {
      setNotice("正在下载并校验更新安装包…");
      try {
        await desktop.installUpdate();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "更新安装失败");
      }
      return;
    }
    setCheckingUpdate(true);
    try {
      const status = await desktop.checkForUpdates(true);
      setUpdateStatus(status);
      if (status.state === "available") setNotice(`发现新版本 ${status.latestVersion}`);
      else if (status.message) setNotice(status.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <main
      className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        importFiles(event.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><Navigation size={19} strokeWidth={2.4} /></div>
          <div><div className="brand-name">KMLENS</div><div className="brand-subtitle">地理文件检视器</div></div>
        </div>
        <div className="header-actions">
          {window.fieldnote?.checkForUpdates && (
            <button className="quiet-button" type="button" onClick={handleUpdate} disabled={checkingUpdate}>
              <RefreshCw size={15} className={checkingUpdate ? "spin-icon" : ""} />
              {updateStatus?.state === "available" ? `更新至 ${updateStatus.latestVersion}` : "检查更新"}
            </button>
          )}
          <button className="quiet-button privacy-badge" type="button" onClick={() => setHelpOpen(true)}>
            <ShieldCheck size={15} /> 本地解析
          </button>
          <button className="quiet-button icon-only" type="button" aria-label="使用帮助" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={19} />
          </button>
          <button className="primary-button compact" type="button" onClick={openFilePicker}>
            <FolderOpen size={17} /> 打开文件
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-heading">
          <div><span className="eyebrow">WORKSPACE</span><h2>我的文件</h2></div>
          <button className="icon-button" type="button" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}>
            <PanelLeftClose size={18} />
          </button>
        </div>
        <button className="import-dashed" type="button" onClick={openFilePicker}>
          <Plus size={17} /><span>添加 KML / GPX</span>
        </button>
        <div className="dataset-list">
          {datasets.length === 0 ? (
            <div className="empty-list"><FileText size={27} /><p>尚未载入文件</p><span>拖入地图，或从电脑中选择</span></div>
          ) : datasets.map((dataset) => {
            const stats = statsFor(dataset.features);
            return (
              <div
                key={dataset.id}
                className={`dataset-card ${selected?.id === dataset.id ? "active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => { setSelectedId(dataset.id); fitDatasets([dataset.id]); }}
                onKeyDown={(event) => { if (event.key === "Enter") setSelectedId(dataset.id); }}
              >
                <span className="dataset-color" style={{ background: dataset.color }} />
                <div className="dataset-info">
                  <strong title={dataset.name}>{dataset.name}</strong>
                  <span>{dataset.format} · {stats.lines + stats.points + stats.areas} 个要素 · {stats.coordinateCount.toLocaleString()} 个坐标</span>
                </div>
                <button
                  className="layer-visibility"
                  type="button"
                  aria-label={dataset.visible ? "隐藏图层" : "显示图层"}
                  onClick={(event) => { event.stopPropagation(); toggleDataset(dataset.id); }}
                >
                  {dataset.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
              </div>
            );
          })}
        </div>

        {selected && (
          <section className="inspector">
            <div className="section-title">
              <span>文件摘要</span>
              <button className="text-icon-button danger" type="button" onClick={() => removeDataset(selected.id)}>
                <Trash2 size={14} /> 移除
              </button>
            </div>
            <div className="stats-grid">
              <div><span>总里程</span><strong>{selectedStats.distanceKm.toFixed(2)} <small>km</small></strong></div>
              <div><span>累计爬升</span><strong>{Math.round(selectedStats.ascent)} <small>m</small></strong></div>
              <div><span>最高海拔</span><strong>{selectedStats.maxEle === null ? "—" : Math.round(selectedStats.maxEle)} <small>{selectedStats.maxEle === null ? "" : "m"}</small></strong></div>
              <div><span>记录时长</span><strong className="small-value">{duration(selectedStats.startTime, selectedStats.endTime)}</strong></div>
            </div>
            <div className="section-title feature-title"><span>要素</span><span className="count-pill">{selected.features.length}</span></div>
            <div className="feature-list">
              {selected.features.slice(0, 12).map((feature, index) => (
                <div className="feature-row" key={String(feature.id ?? index)}>
                  <span className={`feature-icon ${feature.geometry.type.toLowerCase()}`}>
                    {feature.geometry.type.includes("Point") ? <LocateFixed size={14} /> : <Route size={14} />}
                  </span>
                  <div><strong>{String(feature.properties?.name ?? `要素 ${index + 1}`)}</strong><span>{featureKind(feature)}</span></div>
                  <ChevronRight size={15} />
                </div>
              ))}
              {selected.features.length > 12 && <div className="more-features">另有 {selected.features.length - 12} 个要素</div>}
            </div>
            <button className="export-button" type="button" onClick={exportGeoJson}>
              <Download size={16} /> 导出为 GeoJSON
            </button>
          </section>
        )}
      </aside>

      <section className={`map-stage ${streetMap ? "" : "grid-mode"}`}>
        <div ref={mapNode} className="map-canvas" />
        {!sidebarOpen && (
          <button className="floating-sidebar-button" type="button" onClick={() => setSidebarOpen(true)}>
            <PanelLeftOpen size={18} /> 文件
          </button>
        )}
        <div className="map-mode-switch">
          <button className={streetMap ? "active" : ""} type="button" onClick={() => setStreetMap(true)}>
            <MapIcon size={15} /> 街道图
          </button>
          <button className={!streetMap ? "active" : ""} type="button" onClick={() => setStreetMap(false)}>
            <Mountain size={15} /> 坐标网格
          </button>
        </div>
        {datasets.length === 0 && (
          <div className="welcome-card">
            <div className="welcome-kicker"><span /> START HERE <span /></div>
            <div className="compass-emblem"><Navigation size={34} /></div>
            <h1>把路线带到地图上</h1>
            <p>打开 KML 或 GPX 文件，立即查看轨迹、路点、海拔和里程。解析只发生在你的浏览器中。</p>
            <button className="primary-button hero-button" type="button" onClick={openFilePicker}>
              <UploadCloud size={19} /> 选择地理文件
            </button>
            <button className="demo-button" type="button" onClick={addDemo}>先看看示例路线 <ChevronRight size={15} /></button>
            <div className="format-row">
              <span><Check size={13} /> .KML</span><span><Check size={13} /> .GPX</span><span>支持拖放与多文件</span>
            </div>
          </div>
        )}
        {datasets.length > 0 && (
          <div className="map-summary">
            <span><Route size={15} /> {overallStats.lines} 条轨迹</span>
            <span>{overallStats.distanceKm.toFixed(1)} km</span>
            <button type="button" onClick={() => fitDatasets()}>显示全部</button>
          </div>
        )}
      </section>

      {dragging && (
        <div className="drop-overlay"><div><UploadCloud size={42} /><strong>松开以载入地理文件</strong><span>KML 与 GPX · 文件仅在本地读取</span></div></div>
      )}
      {loading && <div className="loading-chip"><span className="spinner" /> 正在解析文件…</div>}
      {notice && (
        <div className="toast success" role="status"><Check size={16} /> {notice}
          <button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={14} /></button>
        </div>
      )}
      {error && (
        <div className="toast error" role="alert"><X size={16} /><span>{error}</span>
          <button type="button" aria-label="关闭错误" onClick={() => setError("")}><X size={14} /></button>
        </div>
      )}

      {helpOpen && (
        <div className="modal-backdrop" onMouseDown={() => setHelpOpen(false)}>
          <section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" aria-label="关闭" onClick={() => setHelpOpen(false)}><X size={18} /></button>
            <div className="modal-icon"><ShieldCheck size={24} /></div>
            <span className="eyebrow">PRIVACY BY DEFAULT</span>
            <h2 id="help-title">你的路线不会离开电脑</h2>
            <p>KML 和 GPX 内容由浏览器直接读取并转换为地图图层，不会上传到服务器。街道底图来自 OpenStreetMap；切换到“坐标网格”即可在无底图状态下查看轨迹。</p>
            <ol>
              <li><span>01</span><div><strong>打开或拖入文件</strong><small>可一次选择多个 KML / GPX</small></div></li>
              <li><span>02</span><div><strong>检查路线与统计</strong><small>显示里程、海拔、时长和要素</small></div></li>
              <li><span>03</span><div><strong>按需导出</strong><small>选中文件后可另存为 GeoJSON</small></div></li>
            </ol>
            <button className="primary-button full" type="button" onClick={() => { setHelpOpen(false); openFilePicker(); }}>
              <FolderOpen size={17} /> 打开第一个文件
            </button>
          </section>
        </div>
      )}

      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".kml,.gpx,application/vnd.google-earth.kml+xml,application/gpx+xml"
        multiple
        onChange={(event) => event.target.files && importFiles(event.target.files)}
      />
    </main>
  );
}
