import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { gunzipSync } from "node:zlib";
import { GribMessageFactory } from "@mattnucc/gribberish";

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = join(process.cwd(), "public");
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
const FORECAST_GRID = "https://api.weather.gov/gridpoints/LWX/131,107";
const DAILY_FORECAST = `${FORECAST_GRID}/forecast`;
const HOURLY_FORECAST = `${FORECAST_GRID}/forecast/hourly`;

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
  return localDateKey(date);
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

function parseRapidMrmsTime(fileName) {
  const match = /_(\d{8})-(\d{6})\.grib2\.gz$/.exec(fileName);
  if (!match) return null;
  const [, day, time] = match;
  return new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`).toISOString();
}

async function getRapidMrmsFiles(product) {
  const html = await (await fetch(`${RAPID_MRMS}/${product}/`, { headers: NWS_HEADERS })).text();
  const pattern = new RegExp(`MRMS_${product}[^"<> ]+\\.grib2\\.gz`, "g");
  return [...new Set([...html.matchAll(pattern)].map((match) => match[0]))].sort();
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
  const response = await fetch(`${RAPID_MRMS}/${product}/${file}`, { headers: NWS_HEADERS });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from rapid MRMS ${product}`);
  const zipped = Buffer.from(await response.arrayBuffer());
  const grib = gunzipSync(zipped);
  const factory = GribMessageFactory.fromBuffer(new Uint8Array(grib));
  const messageKey = factory.availableMessages[0];
  if (!messageKey) throw new Error(`Rapid MRMS ${product} file did not contain a readable message`);
  const message = factory.getMessage(messageKey);
  const rawMillimeters = sampleMrmsGrid(message.data);
  return {
    product,
    file,
    validTime: parseRapidMrmsTime(file),
    rawMillimeters,
    units: message.units || "mm",
    sourceLayer: message.varAbbrev || product
  };
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
  for (let offset = 120; offset >= 0; offset -= intervalMinutes) {
    const target = latest.ms - offset * 60 * 1000;
    const candidate = dated
      .filter((entry) => entry.ms <= target)
      .sort((a, b) => b.ms - a.ms)[0];
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

function buildDailyWeather(periods, grid) {
  const byDate = new Map();
  for (const period of periods) {
    const date = localDateKey(period.startTime);
    const day = byDate.get(date) || {
      date,
      high: null,
      low: null,
      precipitationProbability: 0,
      rainText: "",
      summary: "",
      icon: "",
      periods: []
    };
    if (period.isDaytime) day.high = period.temperature;
    else day.low = period.temperature;
    day.precipitationProbability = Math.max(day.precipitationProbability, Number(period.probabilityOfPrecipitation?.value || 0));
    day.summary = day.summary || period.shortForecast || "";
    if (period.isDaytime || !day.icon) day.icon = period.icon || day.icon;
    day.rainText = day.rainText || extractRainAmountText(period.detailedForecast);
    day.periods.push({
      name: period.name,
      isDaytime: period.isDaytime,
      temperature: period.temperature,
      shortForecast: period.shortForecast || "",
      precipitationProbability: Number(period.probabilityOfPrecipitation?.value || 0),
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

async function redirectRadarImage(req, res, url) {
  const radar = await getRadarSnapshot();
  const requestedRasterId = Number(url.searchParams.get("rasterId"));
  const requestedTime = Number(url.searchParams.get("time"));
  const selectedFrame = Number.isFinite(requestedRasterId)
    ? radar.frames?.find((frame) => frame.rasterId === requestedRasterId)
    : null;
  const radarTime = selectedFrame?.time || (Number.isFinite(requestedTime) && requestedTime > 0 ? requestedTime : radar.validTime);
  const center = webMercator(LON, LAT);
  const radius = Number(url.searchParams.get("radius") || 80000);
  const bbox = [
    center.x - radius,
    center.y - radius,
    center.x + radius,
    center.y + radius
  ].join(",");
  const exportUrl = `${RADAR}/exportImage?${toQuery({
    f: "image",
    bbox,
    bboxSR: "102100",
    imageSR: "102100",
    size: "1000,1000",
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
