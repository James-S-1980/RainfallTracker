import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = join(process.cwd(), "public");
const ADDRESS = "227 Tournament Circle, North East, MD 21901";
const LAT = 39.575348823737;
const LON = -75.933586373761;
const MRMS = "https://mapservices.weather.noaa.gov/raster/rest/services/obs/mrms_qpe/ImageServer";
const NWS_HEADERS = { "user-agent": "rainfall-monitor/1.0 contact: local-user" };
const PERIODS = {
  "1": "conus_QPE_01H",
  "6": "conus_QPE_06H",
  "12": "conus_QPE_12H",
  "24": "conus_QPE_24H"
};

let currentCache = null;
let currentCacheAt = 0;
let historyCache = null;
let historyCacheKey = "";
let forecastCache = null;
let forecastCacheAt = 0;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function mime(file) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  }[extname(file)] || "application/octet-stream";
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: NWS_HEADERS
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }
  return response.json();
}

function toQuery(params) {
  return new URLSearchParams(params).toString();
}

async function getRasterCatalog() {
  const fields = "objectid,name,idp_subset,idp_validendtime,idp_ingestdate";
  const data = await fetchJson(`${MRMS}/query?${toQuery({
    f: "json",
    where: "idp_subset LIKE 'conus_QPE_%'",
    outFields: fields,
    returnGeometry: "false"
  })}`);
  const bySubset = new Map();
  for (const feature of data.features || []) {
    bySubset.set(feature.attributes.idp_subset, feature.attributes);
  }
  return bySubset;
}

async function sampleMrmsPeriod(hours, catalog) {
  const subset = PERIODS[String(hours)];
  const raster = catalog.get(subset);
  if (!raster) throw new Error(`NOAA MRMS raster ${subset} was not available`);

  const geometry = JSON.stringify({
    x: LON,
    y: LAT,
    spatialReference: { wkid: 4326 }
  });
  const mosaicRule = JSON.stringify({
    mosaicMethod: "esriMosaicLockRaster",
    lockRasterIds: [raster.objectid]
  });
  const data = await fetchJson(`${MRMS}/getSamples?${toQuery({
    f: "json",
    geometry,
    geometryType: "esriGeometryPoint",
    returnGeometry: "false",
    mosaicRule,
    outFields: "*"
  })}`);
  const sample = data.samples?.[0];
  const rawMillimeters = Number(sample?.value);
  return {
    hours,
    // ArcGIS renders this NOAA service as inches, but getSamples returns the raw MRMS raster value.
    // MRMS accumulation rasters are millimeters, so convert explicitly for point totals.
    inches: Number.isFinite(rawMillimeters) && rawMillimeters >= 0 ? Number((rawMillimeters / 25.4).toFixed(3)) : null,
    rawMillimeters: Number.isFinite(rawMillimeters) && rawMillimeters >= 0 ? rawMillimeters : null,
    rasterId: raster.objectid,
    validEndTime: sample?.attributes?.idp_validendtime || raster.idp_validendtime,
    ingestTime: sample?.attributes?.idp_ingestdate || raster.idp_ingestdate,
    resolutionMeters: sample?.resolution || null,
    sourceLayer: sample?.attributes?.name || subset
  };
}

async function getStationChecks() {
  const stationsUrl = "https://api.weather.gov/gridpoints/LWX/131,107/stations";
  const stations = await fetchJson(stationsUrl);
  const nearest = (stations.features || []).slice(0, 4);
  const checks = await Promise.all(nearest.map(async (station) => {
    const id = station.properties.stationIdentifier;
    try {
      const latest = await fetchJson(`https://api.weather.gov/stations/${id}/observations/latest`);
      const p = latest.properties || {};
      return {
        id,
        name: station.properties.name,
        distanceMiles: Number(((station.properties.distance?.value || 0) / 1609.344).toFixed(1)),
        timestamp: p.timestamp || null,
        lastHourInches: mmToInches(p.precipitationLastHour?.value),
        last3HoursInches: mmToInches(p.precipitationLast3Hours?.value),
        last6HoursInches: mmToInches(p.precipitationLast6Hours?.value)
      };
    } catch (error) {
      return {
        id,
        name: station.properties.name,
        distanceMiles: Number(((station.properties.distance?.value || 0) / 1609.344).toFixed(1)),
        error: error.message
      };
    }
  }));
  return checks;
}

function mmToInches(value) {
  const mm = Number(value);
  return Number.isFinite(mm) ? Number((mm / 25.4).toFixed(3)) : null;
}

function buildQualityNotes(periods, stationChecks) {
  const notes = [
    "MRMS point samples are converted from raw millimeters to inches.",
    "Short-window radar totals may update before longer windows, so windows can briefly look non-monotonic."
  ];
  const validEnds = new Set(periods.map((p) => p.validEndTime).filter(Boolean));
  if (validEnds.size > 1) {
    notes.push("NOAA accumulation windows are not all ending at the same hour yet; compare totals after the next refresh.");
  }
  const ordered = [...periods].sort((a, b) => a.hours - b.hours);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.inches !== null && current.inches !== null && current.inches + 0.001 < previous.inches) {
      notes.push(`${current.hours}-hour total is lower than the ${previous.hours}-hour total, which means the NOAA rasters are temporarily inconsistent.`);
      break;
    }
  }
  const oneHour = periods.find((p) => p.hours === 1);
  const nearby = stationChecks.find((s) => s.lastHourInches !== null && s.lastHourInches !== undefined);
  if (oneHour?.inches !== null && nearby) {
    const gap = Math.abs(oneHour.inches - nearby.lastHourInches);
    notes.push(`Nearest reporting station ${nearby.id} is ${nearby.distanceMiles} mi away and last reported ${nearby.lastHourInches}" in 1 hour.`);
    if (gap > 0.5) {
      notes.push("Radar and station readings differ materially; trust this as a neighborhood estimate, not a rain-gauge measurement.");
    }
  }
  return notes;
}

async function getCurrentTotals(force = false) {
  if (!force && currentCache && Date.now() - currentCacheAt < FIFTEEN_MINUTES) return currentCache;
  const catalog = await getRasterCatalog();
  const [periods, stationChecks] = await Promise.all([
    Promise.all([1, 6, 12, 24].map((h) => sampleMrmsPeriod(h, catalog))),
    getStationChecks()
  ]);
  currentCache = {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    updatedAt: new Date().toISOString(),
    source: "NOAA MRMS radar-only QPE ImageServer",
    units: "inches",
    periods,
    stationChecks,
    qualityNotes: buildQualityNotes(periods, stationChecks)
  };
  currentCacheAt = Date.now();
  return currentCache;
}

async function getRainForecast(force = false) {
  if (!force && forecastCache && Date.now() - forecastCacheAt < FIFTEEN_MINUTES) return forecastCache;
  const data = await fetchJson("https://api.weather.gov/gridpoints/LWX/131,107/forecast/hourly");
  const hours = (data.properties?.periods || []).slice(0, 12).map((period) => ({
    startTime: period.startTime,
    endTime: period.endTime,
    precipitationProbability: Number(period.probabilityOfPrecipitation?.value || 0),
    temperature: period.temperature,
    temperatureUnit: period.temperatureUnit,
    shortForecast: period.shortForecast || "",
    windSpeed: period.windSpeed || "",
    windDirection: period.windDirection || "",
    isDaytime: Boolean(period.isDaytime)
  }));
  const peak = [...hours].sort((a, b) => b.precipitationProbability - a.precipitationProbability)[0] || null;
  forecastCache = {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    updatedAt: data.properties?.updateTime || new Date().toISOString(),
    source: "NWS hourly forecast",
    hours,
    peak
  };
  forecastCacheAt = Date.now();
  return forecastCache;
}

async function getHistory(force = false) {
  const today = new Date();
  const end = formatDate(today);
  const start = formatDate(addDays(today, -365));
  const key = `${start}:${end}`;
  if (!force && historyCache && historyCacheKey === key && Date.now() - historyCache.fetchedAtMs < SIX_HOURS) {
    return historyCache.payload;
  }

  const url = `https://archive-api.open-meteo.com/v1/archive?${toQuery({
    latitude: String(LAT),
    longitude: String(LON),
    start_date: start,
    end_date: end,
    daily: "precipitation_sum",
    precipitation_unit: "inch",
    timezone: "America/New_York"
  })}`;
  const data = await fetchJson(url);
  const days = (data.daily?.time || []).map((date, index) => ({
    date,
    inches: Number(data.daily.precipitation_sum?.[index] || 0)
  }));
  const weekTotal = sum(days.slice(-7));
  const monthKey = end.slice(0, 7);
  const monthTotal = sum(days.filter((d) => d.date.startsWith(monthKey)));
  const annualTotal = sum(days);
  const months = buildMonthlyTotals(days);
  const payload = {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    source: "Open-Meteo Archive API daily precipitation",
    start,
    end,
    weekTotal,
    monthTotal,
    annualTotal,
    wettestDay: [...days].sort((a, b) => b.inches - a.inches)[0] || null,
    months,
    days
  };
  historyCache = { payload, fetchedAtMs: Date.now() };
  historyCacheKey = key;
  return payload;
}

function sum(days) {
  return Number(days.reduce((total, day) => total + (Number(day.inches) || 0), 0).toFixed(3));
}

function buildMonthlyTotals(days) {
  const months = new Map();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    months.set(key, (months.get(key) || 0) + day.inches);
  }
  return [...months.entries()].map(([month, inches]) => ({
    month,
    inches: Number(inches.toFixed(3))
  }));
}

function webMercator(lon, lat) {
  const x = lon * 20037508.34 / 180;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180;
  return { x, y };
}

async function redirectMapImage(req, res, url) {
  const period = url.searchParams.get("period") || "24";
  if (!PERIODS[period]) {
    json(res, 400, { error: "Supported map periods are 1, 6, 12, and 24 hours." });
    return;
  }
  const current = await getCurrentTotals();
  const selected = current.periods.find((p) => String(p.hours) === period);
  const center = webMercator(LON, LAT);
  const radius = Number(url.searchParams.get("radius") || 45000);
  const bbox = [
    center.x - radius,
    center.y - radius,
    center.x + radius,
    center.y + radius
  ].join(",");
  const exportUrl = `${MRMS}/exportImage?${toQuery({
    f: "image",
    bbox,
    bboxSR: "102100",
    imageSR: "102100",
    size: "1000,1000",
    format: "png32",
    transparent: "true",
    mosaicRule: JSON.stringify({
      mosaicMethod: "esriMosaicLockRaster",
      lockRasterIds: [selected.rasterId]
    })
  })}`;
  res.writeHead(302, { location: exportUrl, "cache-control": "no-store" });
  res.end();
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = normalize(join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  try {
    const body = await readFile(file);
    send(res, 200, body, mime(file));
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/current") return json(res, 200, await getCurrentTotals(url.searchParams.get("refresh") === "1"));
    if (url.pathname === "/api/forecast") return json(res, 200, await getRainForecast(url.searchParams.get("refresh") === "1"));
    if (url.pathname === "/api/history") return json(res, 200, await getHistory(url.searchParams.get("refresh") === "1"));
    if (url.pathname === "/api/summary") {
      const refresh = url.searchParams.get("refresh") === "1";
      const [current, forecast, history] = await Promise.all([getCurrentTotals(refresh), getRainForecast(refresh), getHistory(refresh)]);
      return json(res, 200, { current, forecast, history });
    }
    if (url.pathname === "/api/map-image") return redirectMapImage(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    json(res, 502, { error: error.message || "Unable to fetch rainfall data right now." });
  }
});

server.listen(PORT, () => {
  console.log(`Rainfall Monitor running at http://localhost:${PORT}`);
});
