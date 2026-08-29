import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { GribMessageFactory } from "@mattnucc/gribberish";

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = join(process.cwd(), "public");
const DATA_DIR = join(process.cwd(), "data");
const CALLS_DB_PATH = join(DATA_DIR, "calls.sqlite3");
const ADDRESS = "227 Tournament Circle, North East, MD 21901";
const LAT = 39.575348823737;
const LON = -75.933586373761;
const MRMS = "https://mapservices.weather.noaa.gov/raster/rest/services/obs/mrms_qpe/ImageServer";
const RAPID_MRMS = "https://mrms.ncep.noaa.gov/data/2D";
const RADAR = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer";
const NWS_HEADERS = { "user-agent": "rainfall-monitor/1.0 contact: local-user" };
const MRMS_GRID = {
  rows: 3500,
  cols: 7000,
  firstLatitude: 54.995,
  firstLongitude: 230.005,
  longitudeStep: 0.01,
  latitudeStep: 0.01
};
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
let weatherCache = null;
let weatherCacheAt = 0;
let radarCache = null;
let radarCacheAt = 0;
const rainRateHistoryCaches = new Map();
const rainRateSampleCache = new Map();
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const TWO_MINUTES = 2 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const DEFAULT_RATE_HISTORY_INTERVAL_MINUTES = 20;
const RATE_HISTORY_INTERVALS = new Set([2, 5, 10, 20, 30]);
const RECENT_MRMS_DAILY_DAYS = 3;
const REMOTE_FETCH_TIMEOUT_MS = 20000;
const RAPID_FILE_LIST_TTL_MS = 60 * 1000;
const FORECAST_GRID = "https://api.weather.gov/gridpoints/LWX/131,107";
const DAILY_FORECAST = `${FORECAST_GRID}/forecast`;
const HOURLY_FORECAST = `${FORECAST_GRID}/forecast/hourly`;
const CALL_SOURCES = [
  {
    name: "North East Fire Company Live Run Log",
    kind: "fire_ems_run_log",
    url: "https://nefc4.com/",
    enabled: 1,
    agency: "North East Fire Company",
    pageParam: null,
    maxPages: 1
  },
  {
    name: "Singerly Fire Department Live Run Log",
    kind: "compact_run_log",
    url: "https://singerly.com/live-run-log/",
    enabled: 1,
    agency: "Singerly Fire Department",
    pageParam: "pg",
    maxPages: 10
  },
  {
    name: "Charlestown Fire Company Live Run Log",
    kind: "firecompanies_incidents",
    url: "https://cfc5.net/incidents",
    enabled: 1,
    agency: "Charlestown Fire Company",
    pageParam: "page",
    maxPages: 10
  },
  {
    name: "Cecilton Volunteer Fire Company Live Run Log",
    kind: "firecompanies_incidents",
    url: "https://www.ceciltonvfd1.com/incidents",
    enabled: 1,
    agency: "Cecilton Volunteer Fire Company",
    pageParam: "page",
    maxPages: 10
  },
  {
    name: "Community Fire Company of Rising Sun Live Run Log",
    kind: "firecompanies_incidents",
    url: "http://www.cfcrs.org/incidents",
    enabled: 1,
    agency: "Community Fire Company of Rising Sun",
    pageParam: "page",
    maxPages: 10
  },
  {
    name: "Water Witch Fire Company Live Run Log",
    kind: "compact_run_log",
    url: "https://wwfco.com/incidents/",
    enabled: 1,
    agency: "Water Witch Fire Company",
    pageParam: "page",
    maxPages: 10
  }
];
const rapidFileListCache = new Map();
const rapidFileListInFlight = new Map();
const rapidSampleCache = new Map();
const rapidSampleInFlight = new Map();
const staticFileCache = new Map();

function send(res, status, body, type = "application/json", headers = {}) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...headers
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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

function etagMatches(header, etag) {
  if (!header) return false;
  const normalizeTag = (value) => value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const expected = normalizeTag(etag);
  return String(header)
    .split(",")
    .some((candidate) => normalizeTag(candidate) === expected);
}

function staticCacheControl(pathname) {
  return "public, max-age=0, must-revalidate";
}

function formatDate(date) {
  return localDateKey(date);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REMOTE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...NWS_HEADERS,
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    headers: { accept: "application/json" }
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

function parseRapidMrmsTime(fileName) {
  const match = /_(\d{8})-(\d{6})\.grib2\.gz$/.exec(fileName);
  if (!match) return null;
  const [, day, time] = match;
  return new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`).toISOString();
}

async function getRapidMrmsFiles(product) {
  const cached = rapidFileListCache.get(product);
  if (cached && Date.now() - cached.fetchedAtMs < RAPID_FILE_LIST_TTL_MS) return cached.files;
  if (rapidFileListInFlight.has(product)) return rapidFileListInFlight.get(product);
  const request = (async () => {
    const response = await fetchWithTimeout(`${RAPID_MRMS}/${product}/`, {
      headers: { accept: "text/html, text/plain" }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from rapid MRMS ${product}`);
    const html = await response.text();
    const pattern = new RegExp(`MRMS_${product}[^"<> ]+\\.grib2\\.gz`, "g");
    const files = [...new Set([...html.matchAll(pattern)].map((match) => match[0]))].sort();
    rapidFileListCache.set(product, { files, fetchedAtMs: Date.now() });
    return files;
  })();
  rapidFileListInFlight.set(product, request);
  try {
    return await request;
  } finally {
    rapidFileListInFlight.delete(product);
  }
}

async function getLatestRapidMrmsFile(product) {
  const files = await getRapidMrmsFiles(product);
  const file = files.at(-1);
  if (!file) throw new Error(`No rapid MRMS ${product} file is currently listed`);
  return file;
}

function sampleMrmsGrid(data) {
  const longitude = LON < 0 ? LON + 360 : LON;
  const row = Math.round((MRMS_GRID.firstLatitude - LAT) / MRMS_GRID.latitudeStep);
  const col = Math.round((longitude - MRMS_GRID.firstLongitude) / MRMS_GRID.longitudeStep);
  if (row < 0 || row >= MRMS_GRID.rows || col < 0 || col >= MRMS_GRID.cols) {
    throw new Error("The address is outside the rapid MRMS grid");
  }
  const value = Number(data[row * MRMS_GRID.cols + col]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function sampleRapidMrmsProduct(product, selectedFile = null) {
  const file = selectedFile || await getLatestRapidMrmsFile(product);
  const cacheKey = `${product}:${file}`;
  if (rapidSampleCache.has(cacheKey)) return rapidSampleCache.get(cacheKey);
  if (rapidSampleInFlight.has(cacheKey)) return rapidSampleInFlight.get(cacheKey);
  const request = (async () => {
    const response = await fetchWithTimeout(`${RAPID_MRMS}/${product}/${file}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from rapid MRMS ${product}`);
    const zipped = Buffer.from(await response.arrayBuffer());
    const grib = gunzipSync(zipped);
    const factory = GribMessageFactory.fromBuffer(new Uint8Array(grib));
    const messageKey = factory.availableMessages[0];
    if (!messageKey) throw new Error(`Rapid MRMS ${product} file did not contain a readable message`);
    const message = factory.getMessage(messageKey);
    const rawMillimeters = sampleMrmsGrid(message.data);
    const payload = {
      product,
      file,
      validTime: parseRapidMrmsTime(file),
      rawMillimeters,
      units: message.units || "mm",
      sourceLayer: message.varAbbrev || product
    };
    rapidSampleCache.set(cacheKey, payload);
    if (rapidSampleCache.size > 320) {
      rapidSampleCache.delete(rapidSampleCache.keys().next().value);
    }
    return payload;
  })();
  rapidSampleInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    rapidSampleInFlight.delete(cacheKey);
  }
}

function parseRateHistoryInterval(value) {
  const interval = Number(value || DEFAULT_RATE_HISTORY_INTERVAL_MINUTES);
  return RATE_HISTORY_INTERVALS.has(interval) ? interval : DEFAULT_RATE_HISTORY_INTERVAL_MINUTES;
}

function isValidPrecipRateFile(file) {
  return /^MRMS_PrecipRate_00\.00_\d{8}-\d{6}\.grib2\.gz$/.test(file || "");
}

function pickRateHistoryFiles(files, intervalMinutes) {
  const dated = files
    .map((file) => ({ file, time: parseRapidMrmsTime(file) }))
    .filter((entry) => entry.time)
    .map((entry) => ({ ...entry, ms: new Date(entry.time).getTime() }))
    .sort((a, b) => a.ms - b.ms);
  const latest = dated.at(-1);
  if (!latest) return [];
  const picks = [];
  let cursor = 0;
  for (let offset = 120; offset >= 0; offset -= intervalMinutes) {
    const target = latest.ms - offset * 60 * 1000;
    while (cursor + 1 < dated.length && dated[cursor + 1].ms <= target) cursor += 1;
    const candidate = dated[cursor]?.ms <= target ? dated[cursor] : null;
    if (candidate && !picks.some((pick) => pick.file === candidate.file)) {
      picks.push(candidate);
    }
  }
  return picks;
}

function pickFileAtOrBefore(files, targetTime, maxLagMinutes = 75) {
  const targetMs = targetTime.getTime();
  return files
    .map((file) => ({ file, time: parseRapidMrmsTime(file) }))
    .filter((entry) => entry.time)
    .map((entry) => ({ ...entry, ms: new Date(entry.time).getTime() }))
    .filter((entry) => entry.ms <= targetMs && targetMs - entry.ms <= maxLagMinutes * 60 * 1000)
    .sort((a, b) => b.ms - a.ms)[0] || null;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getRainRateHistory(force = false, intervalMinutes = DEFAULT_RATE_HISTORY_INTERVAL_MINUTES) {
  const cache = rainRateHistoryCaches.get(intervalMinutes);
  if (!force && cache && Date.now() - cache.fetchedAtMs < TEN_MINUTES) {
    return cache.payload;
  }
  const files = await getRapidMrmsFiles("PrecipRate");
  const selected = pickRateHistoryFiles(files, intervalMinutes);
  const samples = await mapWithConcurrency(selected, intervalMinutes <= 5 ? 2 : 3, ({ file }) => getRainRateSample(file, force));
  const payload = {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    source: "NOAA MRMS direct 2-minute PrecipRate",
    units: "inches per hour",
    updatedAt: samples.at(-1)?.time || new Date().toISOString(),
    intervalMinutes,
    supportedIntervals: [...RATE_HISTORY_INTERVALS],
    hours: 2,
    samples
  };
  rainRateHistoryCaches.set(intervalMinutes, { payload, fetchedAtMs: Date.now() });
  return payload;
}

async function getRainRateHistoryPlan(intervalMinutes) {
  const files = await getRapidMrmsFiles("PrecipRate");
  const selected = pickRateHistoryFiles(files, intervalMinutes);
  return {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    source: "NOAA MRMS direct 2-minute PrecipRate",
    units: "inches per hour",
    updatedAt: selected.at(-1)?.time || new Date().toISOString(),
    intervalMinutes,
    supportedIntervals: [...RATE_HISTORY_INTERVALS],
    hours: 2,
    samples: selected.map(({ file, time }) => ({ file, time }))
  };
}

async function getRainRateSample(file, force = false) {
  if (!isValidPrecipRateFile(file)) {
    throw new Error("Invalid rain-rate sample file");
  }
  const cached = rainRateSampleCache.get(file);
  if (!force && cached) return cached;
  const sample = await sampleRapidMrmsProduct("PrecipRate", file);
  const payload = {
    time: sample.validTime,
    file,
    inchesPerHour: sample.rawMillimeters === null ? null : Number((sample.rawMillimeters / 25.4).toFixed(3)),
    rawMillimetersPerHour: sample.rawMillimeters
  };
  rainRateSampleCache.set(file, payload);
  if (rainRateSampleCache.size > 240) {
    rainRateSampleCache.delete(rainRateSampleCache.keys().next().value);
  }
  return payload;
}

async function getRecentMrmsDailyOverrides(endDate) {
  const files = await getRapidMrmsFiles("RadarOnly_QPE_24H");
  const targetDates = Array.from({ length: RECENT_MRMS_DAILY_DAYS }, (_, index) => addDateDays(endDate, -index));
  const selected = targetDates
    .map((date) => ({
      date,
      selected: pickFileAtOrBefore(files, localMidnightAfterDateToUtc(date))
    }))
    .filter((entry) => entry.selected);
  const overrides = await mapWithConcurrency(selected, 1, async ({ date, selected: { file } }) => {
    const sample = await sampleRapidMrmsProduct("RadarOnly_QPE_24H", file);
    return {
      date,
      inches: sample.rawMillimeters === null ? null : Number((sample.rawMillimeters / 25.4).toFixed(3)),
      rawMillimeters: sample.rawMillimeters,
      validTime: sample.validTime,
      file,
      source: "NOAA MRMS RadarOnly_QPE_24H"
    };
  });
  return overrides.filter((override) => override.inches !== null);
}

async function getRapidRainfall() {
  const [oneHour, rainRate] = await Promise.all([
    sampleRapidMrmsProduct("RadarOnly_QPE_01H"),
    sampleRapidMrmsProduct("PrecipRate")
  ]);
  return {
    oneHour: {
      ...oneHour,
      inches: oneHour.rawMillimeters === null ? null : Number((oneHour.rawMillimeters / 25.4).toFixed(3))
    },
    rainRate: {
      ...rainRate,
      inchesPerHour: rainRate.rawMillimeters === null ? null : Number((rainRate.rawMillimeters / 25.4).toFixed(3))
    }
  };
}

function mmToInches(value) {
  const mm = Number(value);
  return Number.isFinite(mm) ? Number((mm / 25.4).toFixed(3)) : null;
}

function cToF(value) {
  if (value === null || value === undefined || value === "") return null;
  const celsius = Number(value);
  return Number.isFinite(celsius) ? Math.round((celsius * 9 / 5) + 32) : null;
}

function kmhToMph(value) {
  if (value === null || value === undefined || value === "") return null;
  const kmh = Number(value);
  return Number.isFinite(kmh) ? Math.round(kmh * 0.621371) : null;
}

function degreesToCompass(value) {
  if (value === null || value === undefined || value === "") return null;
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return null;
  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return directions[Math.round(degrees / 22.5) % 16];
}

function localDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addDateDays(dateKeyValue, days) {
  const [year, month, day] = dateKeyValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

function timeZoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  }).formatToParts(date);
  const offset = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offset);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === "-" ? -minutes : minutes;
}

function localMidnightAfterDateToUtc(dateKeyValue) {
  const nextDate = addDateDays(dateKeyValue, 1);
  const [year, month, day] = nextDate.split("-").map(Number);
  const approximateUtc = new Date(Date.UTC(year, month - 1, day, 5));
  const offsetMinutes = timeZoneOffsetMinutes(approximateUtc, "America/New_York");
  return new Date(Date.UTC(year, month - 1, day) - offsetMinutes * 60 * 1000);
}

function parseDurationHours(duration) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(duration || "");
  if (!match) return 1;
  return Number(match[1] || 0) + Number(match[2] || 0) / 60;
}

function expandGridValues(values = [], transform = (value) => value) {
  const expanded = [];
  for (const entry of values) {
    const [startText, durationText] = String(entry.validTime || "").split("/");
    const hours = Math.max(1, Math.round(parseDurationHours(durationText)));
    const start = new Date(startText);
    for (let index = 0; index < hours; index += 1) {
      const time = new Date(start.getTime() + index * 60 * 60 * 1000);
      expanded.push({
        time: time.toISOString(),
        date: localDateKey(time),
        value: transform(entry.value)
      });
    }
  }
  return expanded;
}

function currentGridValue(expandedValues) {
  const now = Date.now();
  return expandedValues.find((entry) => new Date(entry.time).getTime() >= now)?.value ?? expandedValues.at(-1)?.value ?? null;
}

function aggregatePrecipitationByDate(values = []) {
  const totals = new Map();
  for (const entry of values) {
    const totalInches = mmToInches(entry.value);
    if (totalInches === null) continue;
    const [startText, durationText] = String(entry.validTime || "").split("/");
    const hours = Math.max(1, Math.round(parseDurationHours(durationText)));
    const perHour = totalInches / hours;
    const start = new Date(startText);
    for (let index = 0; index < hours; index += 1) {
      const time = new Date(start.getTime() + index * 60 * 60 * 1000);
      const date = localDateKey(time);
      totals.set(date, Number(((totals.get(date) || 0) + perHour).toFixed(3)));
    }
  }
  return totals;
}

function extractRainAmountText(forecastText) {
  const text = forecastText || "";
  const match = text.match(/New rainfall amounts? ([^.]+ possible)\./i);
  return match ? match[1] : "";
}

function weatherKind(summary, probability = 0) {
  const text = String(summary || "").toLowerCase();
  const rainChance = Number(probability) || 0;
  if (/thunder|t-storm|storm/.test(text) && rainChance >= 30) return "storm";
  if (/(rain|showers|drizzle)/.test(text) && rainChance >= 35) return "rain";
  if (/snow|sleet|ice|freezing/.test(text)) return "snow";
  if (/fog|haze|smoke/.test(text)) return "fog";
  if (/cloudy|overcast/.test(text)) return "cloudy";
  if (/partly|mostly sunny|mostly clear|few clouds/.test(text)) return "partly";
  if (/clear|sunny/.test(text)) return "clear";
  if (/thunder|rain|showers|drizzle/.test(text)) return "partly";
  return "cloudy";
}

function simplifyWeatherSummary(summary, probability = 0) {
  const text = String(summary || "").toLowerCase();
  const rainChance = Number(probability) || 0;
  if (/thunder|t-storm|storm/.test(text) && rainChance >= 60) return "Storms likely";
  if (/thunder|t-storm|storm/.test(text) && rainChance >= 30) return "Storm chance";
  if (/(rain|showers|drizzle)/.test(text) && rainChance >= 60) return "Rain likely";
  if (/(rain|showers|drizzle)/.test(text) && rainChance >= 35) return "Showers possible";
  if (/(rain|showers|drizzle|thunder)/.test(text) && rainChance > 0) return "Small rain chance";
  if (/mostly sunny|mostly clear/.test(text)) return "Mostly sunny";
  if (/partly cloudy|partly sunny/.test(text)) return "Partly cloudy";
  if (/cloudy|overcast/.test(text)) return "Cloudy";
  if (/fog|haze|smoke/.test(text)) return "Reduced visibility";
  if (/snow|sleet|ice|freezing/.test(text)) return "Wintry weather";
  if (/clear|sunny/.test(text)) return "Sunny";
  return summary || "Forecast pending";
}

function buildDailyWeather(periods, grid) {
  const byDate = new Map();
  for (const period of periods) {
    const date = localDateKey(period.startTime);
    const probability = Number(period.probabilityOfPrecipitation?.value || 0);
    const simpleSummary = simplifyWeatherSummary(period.shortForecast, probability);
    const day = byDate.get(date) || {
      date,
      high: null,
      low: null,
      precipitationProbability: 0,
      rainText: "",
      summary: "",
      icon: "",
      visualKind: "",
      visualSummary: "",
      dayParts: [],
      periods: []
    };
    if (period.isDaytime) day.high = period.temperature;
    else day.low = period.temperature;
    day.precipitationProbability = Math.max(day.precipitationProbability, probability);
    day.summary = day.summary || simpleSummary;
    day.visualKind = day.visualKind || weatherKind(period.shortForecast, probability);
    day.visualSummary = day.visualSummary || simpleSummary;
    if (period.isDaytime || !day.icon) day.icon = period.icon || day.icon;
    day.rainText = day.rainText || extractRainAmountText(period.detailedForecast);
    day.dayParts.push({
      label: period.isDaytime ? "Day" : "Night",
      summary: simpleSummary,
      kind: weatherKind(period.shortForecast, probability),
      precipitationProbability: probability,
      temperature: period.temperature
    });
    day.periods.push({
      name: period.name,
      isDaytime: period.isDaytime,
      temperature: period.temperature,
      shortForecast: period.shortForecast || "",
      simpleSummary,
      kind: weatherKind(period.shortForecast, probability),
      precipitationProbability: probability,
      windSpeed: period.windSpeed || "",
      windDirection: period.windDirection || ""
    });
    byDate.set(date, day);
  }

  const qpfByDate = aggregatePrecipitationByDate(grid.quantitativePrecipitation?.values || []);

  return [...byDate.values()].slice(0, 5).map((day) => ({
    ...day,
    projectedRainInches: qpfByDate.has(day.date) ? qpfByDate.get(day.date) : null
  }));
}

function buildQualityNotes(periods) {
  const notes = [
    "Rapid 1-hour rainfall and live rain rate come from NOAA's direct 2-minute MRMS GRIB2 feed.",
    "Longer MRMS point samples are converted from raw millimeters to inches.",
    "MRMS is a radar-estimated neighborhood value, not a physical rain gauge at the house.",
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
  return notes;
}

async function getCurrentTotals(force = false) {
  if (!force && currentCache && Date.now() - currentCacheAt < TWO_MINUTES) return currentCache;
  const catalog = await getRasterCatalog();
  const periods = await Promise.all([1, 6, 12, 24].map((h) => sampleMrmsPeriod(h, catalog)));
  let rapid = null;
  try {
    rapid = await getRapidRainfall();
    const oneHour = periods.find((period) => period.hours === 1);
    if (oneHour && rapid.oneHour.inches !== null) {
      oneHour.imageServerInches = oneHour.inches;
      oneHour.inches = rapid.oneHour.inches;
      oneHour.rawMillimeters = rapid.oneHour.rawMillimeters;
      oneHour.validEndTime = rapid.oneHour.validTime || oneHour.validEndTime;
      oneHour.sourceLayer = rapid.oneHour.sourceLayer;
      oneHour.source = "NOAA MRMS direct 2-minute RadarOnly_QPE_01H";
      oneHour.rapid = true;
    }
  } catch (error) {
    rapid = { error: error.message || "Rapid MRMS feed was unavailable" };
  }
  currentCache = {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    updatedAt: new Date().toISOString(),
    source: "NOAA MRMS radar-only QPE",
    units: "inches",
    periods,
    rapid,
    qualityNotes: buildQualityNotes(periods)
  };
  currentCacheAt = Date.now();
  return currentCache;
}

async function getRainForecast(force = false) {
  if (!force && forecastCache && Date.now() - forecastCacheAt < FIFTEEN_MINUTES) return forecastCache;
  const data = await fetchJson(HOURLY_FORECAST);
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

async function getWeatherReport(force = false) {
  if (!force && weatherCache && Date.now() - weatherCacheAt < FIFTEEN_MINUTES) return weatherCache;
  const [daily, grid, latestObservation] = await Promise.all([
    fetchJson(DAILY_FORECAST),
    fetchJson(FORECAST_GRID),
    fetchJson("https://api.weather.gov/stations/K0W3/observations/latest")
  ]);
  const observation = latestObservation.properties || {};
  const today = localDateKey(new Date());
  const temperatures = expandGridValues(grid.properties?.temperature?.values || [], cToF).filter((entry) => entry.date === today && entry.value !== null);
  const todaysHigh = temperatures.length ? Math.max(...temperatures.map((entry) => entry.value)) : null;
  const todaysLow = temperatures.length ? Math.min(...temperatures.map((entry) => entry.value)) : null;
  const periods = daily.properties?.periods || [];
  const currentPeriod = periods[0] || {};
  const currentTemperature = cToF(observation.temperature?.value) ?? currentGridValue(expandGridValues(grid.properties?.temperature?.values || [], cToF));
  const currentWindSpeed = kmhToMph(observation.windSpeed?.value);
  const currentWindDirection = degreesToCompass(observation.windDirection?.value);
  const currentHumidity = observation.relativeHumidity?.value === null || observation.relativeHumidity?.value === undefined
    ? null
    : Math.round(Number(observation.relativeHumidity.value));

  weatherCache = {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    updatedAt: daily.properties?.updateTime || new Date().toISOString(),
    forecastUpdatedAt: daily.properties?.updateTime || null,
    source: "NWS forecast and K0W3 latest observation",
    current: {
      conditions: observation.textDescription || currentPeriod.shortForecast || "",
      temperature: currentTemperature,
      station: observation.stationName || "Harford County Airport",
      observedAt: observation.timestamp || null,
      windSpeedMph: currentWindSpeed,
      windDirection: currentWindDirection,
      windGustMph: kmhToMph(observation.windGust?.value),
      humidity: Number.isFinite(currentHumidity) ? currentHumidity : null
    },
    today: {
      date: today,
      high: todaysHigh,
      low: todaysLow,
      wind: `${currentPeriod.windDirection || ""} ${currentPeriod.windSpeed || ""}`.trim(),
      summary: currentPeriod.shortForecast || ""
    },
    daily: buildDailyWeather(periods, grid.properties || {})
  };
  weatherCacheAt = Date.now();
  return weatherCache;
}

async function getRadarSnapshot(force = false) {
  if (!force && radarCache && Date.now() - radarCacheAt < FIFTEEN_MINUTES) return radarCache;
  const [data, frames] = await Promise.all([
    fetchJson(`${RADAR}?f=pjson`),
    getRadarFrames()
  ]);
  const latestFrame = frames.at(-1);
  const validTime = latestFrame?.time || data.timeInfo?.timeExtent?.[1] || null;
  radarCache = {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    source: "NOAA radar base reflectivity",
    updatedAt: validTime ? new Date(validTime).toISOString() : new Date().toISOString(),
    validTime,
    updateFrequency: "About every 5-8 minutes",
    frames
  };
  radarCacheAt = Date.now();
  return radarCache;
}

async function getRadarFrames() {
  const fields = "objectid,name,idp_subset,idp_validtime,idp_validendtime,idp_ingestdate";
  const data = await fetchJson(`${RADAR}/query?${toQuery({
    f: "json",
    where: "idp_subset = 'CONUS'",
    outFields: fields,
    returnGeometry: "false",
    orderByFields: "idp_validtime DESC",
    resultRecordCount: "8"
  })}`);
  return (data.features || [])
    .map((feature) => ({
      rasterId: feature.attributes.objectid,
      name: feature.attributes.name,
      time: feature.attributes.idp_validtime,
      validTime: feature.attributes.idp_validtime ? new Date(feature.attributes.idp_validtime).toISOString() : null,
      ingestTime: feature.attributes.idp_ingestdate || null
    }))
    .filter((frame) => frame.rasterId && frame.time)
    .sort((a, b) => a.time - b.time);
}

async function getHistory(force = false) {
  const today = localDateKey(new Date());
  const end = addDateDays(today, -1);
  const start = addDateDays(end, -365);
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
  let days = (data.daily?.time || []).map((date, index) => ({
    date,
    inches: Number(data.daily.precipitation_sum?.[index] || 0),
    source: "Open-Meteo Archive"
  }));
  let recentMrmsOverrides = [];
  try {
    recentMrmsOverrides = await getRecentMrmsDailyOverrides(end);
    const overridesByDate = new Map(recentMrmsOverrides.map((override) => [override.date, override]));
    days = days.map((day) => {
      const override = overridesByDate.get(day.date);
      return override
        ? {
          ...day,
          archiveInches: day.inches,
          inches: override.inches,
          source: override.source,
          mrmsValidTime: override.validTime,
          mrmsFile: override.file
        }
        : day;
    });
  } catch (error) {
    recentMrmsOverrides = [{ error: error.message || "Recent MRMS daily overrides were unavailable" }];
  }
  const weekTotal = sum(days.slice(-7));
  const monthKey = end.slice(0, 7);
  const monthTotal = sum(days.filter((d) => d.date.startsWith(monthKey)));
  const annualTotal = sum(days);
  const months = buildMonthlyTotals(days);
  const payload = {
    address: ADDRESS,
    coordinates: { lat: LAT, lon: LON },
    source: "Open-Meteo Archive API daily precipitation with recent NOAA MRMS daily overrides",
    start,
    end,
    weekTotal,
    monthTotal,
    annualTotal,
    wettestDay: [...days].sort((a, b) => b.inches - a.inches)[0] || null,
    recentMrmsOverrides,
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

function boundedNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : null;
}

function mapExportSize(url) {
  const width = boundedNumber(url.searchParams.get("width"), 400, 1800) || 1000;
  const height = boundedNumber(url.searchParams.get("height"), 300, 1400) || 1000;
  return `${Math.round(width)},${Math.round(height)}`;
}

function viewportBbox(url, fallbackRadius) {
  const west = boundedNumber(url.searchParams.get("west"), -180, 180);
  const south = boundedNumber(url.searchParams.get("south"), -85, 85);
  const east = boundedNumber(url.searchParams.get("east"), -180, 180);
  const north = boundedNumber(url.searchParams.get("north"), -85, 85);
  if (west !== null && south !== null && east !== null && north !== null && west < east && south < north) {
    const southwest = webMercator(west, south);
    const northeast = webMercator(east, north);
    return [
      southwest.x,
      southwest.y,
      northeast.x,
      northeast.y
    ].join(",");
  }
  const center = webMercator(LON, LAT);
  const radius = Number(url.searchParams.get("radius") || fallbackRadius);
  return [
    center.x - radius,
    center.y - radius,
    center.x + radius,
    center.y + radius
  ].join(",");
}

async function redirectMapImage(req, res, url) {
  const period = url.searchParams.get("period") || "24";
  if (!PERIODS[period]) {
    json(res, 400, { error: "Supported map periods are 1, 6, 12, and 24 hours." });
    return;
  }
  const current = await getCurrentTotals();
  const selected = current.periods.find((p) => String(p.hours) === period);
  const bbox = viewportBbox(url, 45000);
  const exportUrl = `${MRMS}/exportImage?${toQuery({
    f: "image",
    bbox,
    bboxSR: "102100",
    imageSR: "102100",
    size: mapExportSize(url),
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

async function redirectRadarImage(req, res, url) {
  const radar = await getRadarSnapshot();
  const requestedRasterId = Number(url.searchParams.get("rasterId"));
  const requestedTime = Number(url.searchParams.get("time"));
  const selectedFrame = Number.isFinite(requestedRasterId)
    ? radar.frames?.find((frame) => frame.rasterId === requestedRasterId)
    : null;
  const radarTime = selectedFrame?.time || (Number.isFinite(requestedTime) && requestedTime > 0 ? requestedTime : radar.validTime);
  const bbox = viewportBbox(url, 80000);
  const exportUrl = `${RADAR}/exportImage?${toQuery({
    f: "image",
    bbox,
    bboxSR: "102100",
    imageSR: "102100",
    size: mapExportSize(url),
    format: "png32",
    transparent: "true",
    ...(radarTime ? { time: String(radarTime) } : {}),
    ...(selectedFrame ? {
      mosaicRule: JSON.stringify({
        mosaicMethod: "esriMosaicLockRaster",
        lockRasterIds: [selectedFrame.rasterId]
      })
    } : {})
  })}`;
  res.writeHead(302, { location: exportUrl, "cache-control": "no-store" });
  res.end();
}

let callsDb = null;

function getCallsDb() {
  if (callsDb) return callsDb;
  mkdirSync(DATA_DIR, { recursive: true });
  callsDb = new DatabaseSync(CALLS_DB_PATH);
  initCallsDb(callsDb);
  return callsDb;
}

function initCallsDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      responder_type TEXT NOT NULL,
      agency TEXT NOT NULL,
      call_type TEXT NOT NULL,
      location_text TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      source_id INTEGER,
      source_url TEXT NOT NULL,
      source_event_id TEXT NOT NULL UNIQUE,
      latitude REAL,
      longitude REAL,
      geocode_confidence TEXT,
      geocode_display_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(source_id) REFERENCES sources(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_events_responder_type ON events(responder_type);

    CREATE TABLE IF NOT EXISTS ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      FOREIGN KEY(source_id) REFERENCES sources(id)
    );
  `);
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO sources (name, kind, url, enabled)
    VALUES (?, ?, ?, ?)
  `);
  const updateSource = db.prepare(`
    UPDATE sources SET kind = ?, url = ?, enabled = ? WHERE name = ?
  `);
  for (const source of CALL_SOURCES) {
    insertSource.run(source.name, source.kind, source.url, source.enabled);
    updateSource.run(source.kind, source.url, source.enabled, source.name);
  }
}

function normalizeCallTimestamp(value) {
  const match = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?,?\s+)?([A-Z][a-z]+),?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:@\s*)?(\d{1,2}):(\d{2})$/.exec(value.replace(/\s+/g, " ").trim());
  if (!match) return null;
  const [, , monthName, day, explicitYear, hour, minute] = match;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
  if (!month) return null;
  let year = Number(explicitYear || new Date().getFullYear());
  const candidate = new Date(year, month - 1, Number(day), Number(hour), Number(minute));
  const now = new Date();
  if (!explicitYear && candidate.getTime() - now.getTime() > 45 * 24 * 60 * 60 * 1000) {
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${minute}`;
}

function htmlTextItems(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(h[1-6]|li|p|div|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\n+/)
    .map((item) => item.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function buildCallEvent({ sourceKey, sourceUrl, agency, occurredAt, callType, locationText, details = "" }) {
  const sourceEventId = createHash("sha256")
    .update(`${sourceKey}|${occurredAt}|${callType}|${locationText}`)
    .digest("hex");
  return {
    occurred_at: occurredAt,
    responder_type: /police/i.test(callType) ? "police" : "fire_ems",
    agency,
    call_type: callType,
    location_text: locationText,
    details,
    source_url: sourceUrl,
    source_event_id: sourceEventId
  };
}

function parseNefcRunLog(html, source) {
  const items = htmlTextItems(html);
  const datePattern = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+[A-Z][a-z]{2},?\s+\d{1,2},?\s+\d{4}\s+(?:@\s*)?\d{1,2}:\d{2}$/;
  const events = [];
  for (let index = 0; index < items.length; index += 1) {
    if (!datePattern.test(items[index])) continue;
    const occurredAt = normalizeCallTimestamp(items[index]);
    if (!occurredAt) continue;
    const callType = items[index + 1] || "Unknown";
    const locationText = items[index + 2] || "Unknown";
    if (["member links", "account links"].includes(callType.toLowerCase())) continue;
    events.push(buildCallEvent({
      sourceKey: source.name,
      sourceUrl: source.url,
      agency: source.agency,
      occurredAt,
      callType,
      locationText
    }));
  }
  return events;
}

function parseCompactRunLog(html, source, sourceUrl) {
  const items = htmlTextItems(html).filter((item) => !["Show Map", "Close"].includes(item));
  const datePattern = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+[A-Z][a-z]{2}\s+\d{1,2}$/;
  const dateTimePattern = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+[A-Z][a-z]{2}\s+\d{1,2}\s+@\s*\d{1,2}:\d{2}$/;
  const events = [];
  for (let index = 0; index < items.length; index += 1) {
    const combinedDateTime = dateTimePattern.test(items[index])
      ? items[index]
      : datePattern.test(items[index]) && /^@\s*\d{1,2}:\d{2}$/.test(items[index + 1] || "")
        ? `${items[index]} ${items[index + 1]}`
        : null;
    if (!combinedDateTime) continue;
    const occurredAt = normalizeCallTimestamp(combinedDateTime);
    if (!occurredAt) continue;
    const offset = dateTimePattern.test(items[index]) ? 1 : 2;
    const callType = items[index + offset] || "Unknown";
    const locationText = items[index + offset + 1] || "Unknown";
    if (/^(home|live run log|join our|fire department)$/i.test(callType)) continue;
    events.push(buildCallEvent({
      sourceKey: source.name,
      sourceUrl,
      agency: source.agency,
      occurredAt,
      callType,
      locationText
    }));
  }
  return events;
}

function parseFireCompaniesIncidents(html, source, sourceUrl) {
  const items = htmlTextItems(html).filter((item) => !["Show Map", "Close", "* * *"].includes(item));
  const datePattern = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+[A-Z][a-z]+,?\s+\d{1,2}\s+\d{4}\s+@\s*\d{1,2}:\d{2}$/;
  const events = [];
  for (let index = 0; index < items.length; index += 1) {
    if (!datePattern.test(items[index])) continue;
    const occurredAt = normalizeCallTimestamp(items[index]);
    if (!occurredAt) continue;
    let callType = "Unknown";
    let locationText = "Unknown";
    const details = [];
    for (let cursor = index + 1; cursor < Math.min(items.length, index + 8); cursor += 1) {
      const item = items[cursor];
      if (datePattern.test(item) || /^Displaying \d+-\d+ of /i.test(item)) break;
      if (/^Nature:\s*/i.test(item)) {
        callType = item.replace(/^Nature:\s*/i, "").trim() || callType;
      } else if (/^(Address|Location|City):\s*/i.test(item)) {
        const value = item.replace(/^(Address|Location|City):\s*/i, "").trim();
        if (value) locationText = value;
      } else if (callType === "Unknown") {
        callType = item;
      } else if (locationText === "Unknown") {
        locationText = item.replace(/\s+-\s+/g, " - ");
      } else {
        details.push(item);
      }
    }
    events.push(buildCallEvent({
      sourceKey: source.name,
      sourceUrl,
      agency: source.agency,
      occurredAt,
      callType,
      locationText,
      details: details.join(" ")
    }));
  }
  return events;
}

function callSourceDefinition(sourceRow) {
  return CALL_SOURCES.find((source) => source.name === sourceRow.name) || {
    name: sourceRow.name,
    kind: sourceRow.kind,
    url: sourceRow.url,
    enabled: sourceRow.enabled,
    agency: sourceRow.name.replace(/\s+Live Run Log$/i, ""),
    maxPages: 1,
    pageParam: null
  };
}

function pagedCallSourceUrls(source) {
  const maxPages = Number(source.maxPages || 1);
  if (!source.pageParam || maxPages <= 1) return [source.url];
  return Array.from({ length: maxPages }, (_, index) => {
    const page = index + 1;
    if (page === 1) return source.url;
    const url = new URL(source.url);
    url.searchParams.set(source.pageParam, String(page));
    return url.toString();
  });
}

function parseCallSourceHtml(html, source, sourceUrl) {
  if (source.kind === "fire_ems_run_log") return parseNefcRunLog(html, source);
  if (source.kind === "compact_run_log") return parseCompactRunLog(html, source, sourceUrl);
  if (source.kind === "firecompanies_incidents") return parseFireCompaniesIncidents(html, source, sourceUrl);
  throw new Error(`Unsupported source kind: ${source.kind}`);
}

function shouldGeocodeCallLocation(location) {
  const lowered = String(location || "").toLowerCase();
  if (["withheld", "unknown", "medical", "not available"].some((term) => lowered.includes(term))) return false;
  return /\d| road| rd| street| st| avenue| ave| drive| dr| lane| ln| highway| hwy| pike/.test(lowered);
}

async function geocodeCallLocation(location) {
  if (process.env.DISABLE_GEOCODING === "1" || !shouldGeocodeCallLocation(location)) return null;
  const params = new URLSearchParams({ q: `${location}, Cecil County, Maryland`, format: "jsonv2", limit: "1" });
  try {
    const response = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "user-agent": "NorthEastResponderTracker/1.0 local geocoder" }
    });
    if (!response.ok) return null;
    const results = await response.json();
    const result = results?.[0];
    if (!result) return null;
    const importance = Number(result.importance || 0);
    return {
      latitude: Number(result.lat),
      longitude: Number(result.lon),
      geocode_confidence: importance >= 0.5 ? "high" : importance >= 0.3 ? "medium" : "low",
      geocode_display_name: result.display_name || ""
    };
  } catch {
    return null;
  }
}

async function upsertCallEvent(db, sourceId, event) {
  const existing = db.prepare("SELECT id FROM events WHERE source_event_id = ?").get(event.source_event_id);
  const geo = await geocodeCallLocation(event.location_text);
  const now = utcNow();
  if (existing) {
    db.prepare(`
      UPDATE events
      SET occurred_at = ?, responder_type = ?, agency = ?, call_type = ?, location_text = ?,
        details = ?, source_id = ?, source_url = ?,
        latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
        geocode_confidence = COALESCE(?, geocode_confidence),
        geocode_display_name = COALESCE(?, geocode_display_name),
        updated_at = ?
      WHERE source_event_id = ?
    `).run(
      event.occurred_at, event.responder_type, event.agency, event.call_type, event.location_text,
      event.details, sourceId, event.source_url,
      geo?.latitude ?? null, geo?.longitude ?? null, geo?.geocode_confidence ?? null, geo?.geocode_display_name ?? null,
      now, event.source_event_id
    );
    return "updated";
  }
  db.prepare(`
    INSERT INTO events (
      occurred_at, responder_type, agency, call_type, location_text, details, source_id,
      source_url, source_event_id, latitude, longitude, geocode_confidence,
      geocode_display_name, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.occurred_at, event.responder_type, event.agency, event.call_type, event.location_text,
    event.details, sourceId, event.source_url, event.source_event_id,
    geo?.latitude ?? null, geo?.longitude ?? null, geo?.geocode_confidence ?? null, geo?.geocode_display_name ?? null,
    now
  );
  return "inserted";
}

async function ingestCallSource(db, source) {
  const sourceConfig = callSourceDefinition(source);
  const startedAt = utcNow();
  const run = db.prepare("INSERT INTO ingest_runs (source_id, started_at, status) VALUES (?, ?, ?)").run(source.id, startedAt, "running");
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  try {
    const allEvents = [];
    for (const sourceUrl of pagedCallSourceUrls(sourceConfig)) {
      const response = await fetchWithTimeout(sourceUrl, {
        headers: { "user-agent": "NorthEastResponderTracker/1.0 (+local personal use)", accept: "text/html" }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${sourceUrl}`);
      allEvents.push(...parseCallSourceHtml(await response.text(), sourceConfig, sourceUrl));
    }
    const uniqueEvents = new Map(allEvents.map((event) => [event.source_event_id, event]));
    const events = [...uniqueEvents.values()];
    fetched = events.length;
    for (const event of events) {
      const result = await upsertCallEvent(db, source.id, event);
      if (result === "inserted") inserted += 1;
      if (result === "updated") updated += 1;
    }
    db.prepare("UPDATE sources SET last_checked_at = ?, last_status = ?, last_error = NULL WHERE id = ?").run(utcNow(), "ok", source.id);
    db.prepare(`
      UPDATE ingest_runs
      SET finished_at = ?, status = ?, fetched_count = ?, inserted_count = ?, updated_count = ?
      WHERE id = ?
    `).run(utcNow(), "ok", fetched, inserted, updated, run.lastInsertRowid);
    return { source: source.name, status: "ok", fetched, inserted, updated };
  } catch (error) {
    db.prepare("UPDATE sources SET last_checked_at = ?, last_status = ?, last_error = ? WHERE id = ?").run(utcNow(), "error", error.message, source.id);
    db.prepare(`
      UPDATE ingest_runs
      SET finished_at = ?, status = ?, fetched_count = ?, inserted_count = ?, updated_count = ?, error = ?
      WHERE id = ?
    `).run(utcNow(), "error", fetched, inserted, updated, error.message, run.lastInsertRowid);
    return { source: source.name, status: "error", error: error.message };
  }
}

function getCallEvents(url) {
  const db = getCallsDb();
  const clauses = [];
  const values = [];
  const date = url.searchParams.get("date");
  const month = url.searchParams.get("month");
  const types = url.searchParams.getAll("type").filter(Boolean);
  if (date) {
    clauses.push("date(occurred_at) = ?");
    values.push(date);
  }
  if (month) {
    clauses.push("substr(occurred_at, 1, 7) = ?");
    values.push(month);
  }
  if (types.length) {
    clauses.push(`responder_type IN (${types.map(() => "?").join(",")})`);
    values.push(...types);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT e.*, s.name AS source_name
    FROM events e
    LEFT JOIN sources s ON s.id = e.source_id
    ${where}
    ORDER BY occurred_at DESC
    LIMIT 1000
  `).all(...values);
}

function getCallStats() {
  const db = getCallsDb();
  const total = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  const latest = db.prepare("SELECT occurred_at FROM events ORDER BY occurred_at DESC LIMIT 1").get();
  const byType = db.prepare("SELECT responder_type, COUNT(*) AS count FROM events GROUP BY responder_type").all();
  return {
    total_events: total,
    latest_event_at: latest?.occurred_at || null,
    by_type: byType
  };
}

async function routeCallsApi(req, res, url) {
  const db = getCallsDb();
  if (req.method === "GET" && url.pathname === "/api/calls/events") return json(res, 200, getCallEvents(url));
  if (req.method === "GET" && url.pathname === "/api/calls/sources") return json(res, 200, db.prepare("SELECT * FROM sources ORDER BY name").all());
  if (req.method === "GET" && url.pathname === "/api/calls/stats") return json(res, 200, getCallStats());
  if (req.method === "POST" && url.pathname === "/api/calls/ingest/run") {
    const sources = db.prepare("SELECT * FROM sources WHERE enabled = 1").all();
    return json(res, 200, { results: await Promise.all(sources.map((source) => ingestCallSource(db, source))) });
  }
  return json(res, 404, { error: "Calls API route not found" });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = normalize(join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  try {
    const info = await stat(file);
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const cacheControl = staticCacheControl(pathname);
    if (etagMatches(req.headers["if-none-match"], etag)) {
      res.writeHead(304, {
        "cache-control": cacheControl,
        etag,
        "access-control-allow-origin": "*"
      });
      res.end();
      return;
    }
    const cached = staticFileCache.get(file);
    const body = cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size
      ? cached.body
      : await readFile(file);
    if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
      staticFileCache.set(file, { body, mtimeMs: info.mtimeMs, size: info.size });
    }
    send(res, 200, body, mime(file), {
      "cache-control": cacheControl,
      etag
    });
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/calls/")) return routeCallsApi(req, res, url);
    if (url.pathname === "/api/current") return json(res, 200, await getCurrentTotals(url.searchParams.get("refresh") === "1"));
    if (url.pathname === "/api/rain-rate-history") {
      const interval = parseRateHistoryInterval(url.searchParams.get("interval"));
      return json(res, 200, await getRainRateHistory(url.searchParams.get("refresh") === "1", interval));
    }
    if (url.pathname === "/api/rain-rate-history-plan") {
      const interval = parseRateHistoryInterval(url.searchParams.get("interval"));
      return json(res, 200, await getRainRateHistoryPlan(interval));
    }
    if (url.pathname === "/api/rain-rate-sample") {
      return json(res, 200, await getRainRateSample(url.searchParams.get("file"), url.searchParams.get("refresh") === "1"));
    }
    if (url.pathname === "/api/forecast") return json(res, 200, await getRainForecast(url.searchParams.get("refresh") === "1"));
    if (url.pathname === "/api/weather") return json(res, 200, await getWeatherReport(url.searchParams.get("refresh") === "1"));
    if (url.pathname === "/api/radar") return json(res, 200, await getRadarSnapshot(url.searchParams.get("refresh") === "1"));
    if (url.pathname === "/api/history") return json(res, 200, await getHistory(url.searchParams.get("refresh") === "1"));
    if (url.pathname === "/api/summary") {
      const refresh = url.searchParams.get("refresh") === "1";
      const [current, forecast, weather, radar, history] = await Promise.all([getCurrentTotals(refresh), getRainForecast(refresh), getWeatherReport(refresh), getRadarSnapshot(refresh), getHistory(refresh)]);
      return json(res, 200, { current, forecast, weather, radar, history });
    }
    if (url.pathname === "/api/map-image") return redirectMapImage(req, res, url);
    if (url.pathname === "/api/radar-image") return redirectRadarImage(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    json(res, 502, { error: error.message || "Unable to fetch rainfall data right now." });
  }
});

server.listen(PORT, () => {
  console.log(`Rainfall Monitor running at http://localhost:${PORT}`);
});
