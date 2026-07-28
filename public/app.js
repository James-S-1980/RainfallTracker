const HOME = { lat: 39.575348823737, lon: -75.933586373761 };
const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let map;
let radarMap;
let overlay;
let radarOverlay;
let activePeriod = "24";

const els = {
  dot: document.querySelector("#statusDot"),
  status: document.querySelector("#statusText"),
  refresh: document.querySelector("#refreshButton"),
  note: document.querySelector("#sourceNote"),
  quality: document.querySelector("#qualityNotes"),
  stations: document.querySelector("#stationChecks"),
  weatherUpdated: document.querySelector("#weatherUpdated"),
  weatherConditions: document.querySelector("#weatherConditions"),
  weatherTemp: document.querySelector("#weatherTemp"),
  weatherHighLow: document.querySelector("#weatherHighLow"),
  weatherWind: document.querySelector("#weatherWind"),
  weatherStation: document.querySelector("#weatherStation"),
  dailyWeather: document.querySelector("#dailyWeather"),
  radarTime: document.querySelector("#radarTime"),
  forecast: document.querySelector("#forecastTimeline"),
  forecastPeak: document.querySelector("#forecastPeak"),
  calendar: document.querySelector("#calendar"),
  bars: document.querySelector("#monthlyBars"),
  wettest: document.querySelector("#wettestDay")
};

function inches(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${fmt.format(Number(value))}"`;
}

function setStatus(text, state = "loading") {
  els.status.textContent = text;
  els.dot.className = `dot ${state === "ready" ? "ready" : state === "error" ? "error" : ""}`;
}

async function loadRainfall(refresh = false) {
  setStatus(refresh ? "Refreshing data" : "Loading rainfall data");
  try {
    const response = await fetch(`/api/summary${refresh ? "?refresh=1" : ""}`);
    if (!response.ok) throw new Error("Rainfall service did not respond");
    const data = await response.json();
    renderCurrent(data.current);
    renderWeather(data.weather);
    renderRadar(data.radar);
    renderForecast(data.forecast);
    renderHistory(data.history);
    setStatus(`Updated ${new Date(data.current.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "ready");
    updateMap(activePeriod);
  } catch (error) {
    setStatus(error.message || "Unable to load data", "error");
  }
}

function renderCurrent(current) {
  for (const period of current.periods) {
    const target = document.querySelector(`#total${period.hours}`);
    if (target) target.textContent = inches(period.inches);
  }
  const latest = current.periods.find((p) => p.hours === 24) || current.periods[0];
  const validTimes = [...new Set(current.periods.map((p) => p.validEndTime).filter(Boolean))];
  const valid = validTimes.length ? new Date(Math.max(...validTimes)) : null;
  const synced = validTimes.length <= 1;
  els.note.textContent = valid
    ? `NOAA radar totals ${synced ? "are" : "are not all"} valid through the same hour; latest layer is ${valid.toLocaleString()} at roughly ${(latest.resolutionMeters / 1000).toFixed(1)} km sample resolution.`
    : "NOAA radar totals are live estimates and may be revised.";
  renderQuality(current);
}

function renderQuality(current) {
  els.quality.innerHTML = (current.qualityNotes || [])
    .map((note) => `<p>${escapeHtml(note)}</p>`)
    .join("");
  els.stations.innerHTML = (current.stationChecks || []).map((station) => {
    const observed = station.lastHourInches === null || station.lastHourInches === undefined
      ? "No 1h precip report"
      : `${inches(station.lastHourInches)} in last hour`;
    const when = station.timestamp
      ? new Date(station.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "latest time unavailable";
    return `<article class="station">
      <div><strong>${escapeHtml(station.id)} - ${escapeHtml(station.name)}</strong><span>${station.distanceMiles} mi away - ${when}</span></div>
      <span>${observed}</span>
    </article>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function renderHistory(history) {
  document.querySelector("#weekTotal").textContent = inches(history.weekTotal);
  document.querySelector("#monthTotal").textContent = inches(history.monthTotal);
  document.querySelector("#yearTotal").textContent = inches(history.annualTotal);
  if (history.wettestDay) {
    els.wettest.textContent = `Wettest day: ${formatDateLabel(history.wettestDay.date)} - ${inches(history.wettestDay.inches)}`;
  }
  renderBars(history.months);
  renderCalendar(history.days, history.months);
}

function renderWeather(weather) {
  if (!weather) return;
  const current = weather.current || {};
  els.weatherConditions.textContent = current.conditions || "--";
  els.weatherStation.textContent = current.station
    ? `${current.station}${current.observedAt ? ` at ${new Date(current.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`
    : "NWS observation";
  els.weatherTemp.textContent = current.temperature === null || current.temperature === undefined ? "--" : `${current.temperature}F`;
  els.weatherHighLow.textContent = weather.today?.high === null || weather.today?.low === null
    ? "--"
    : `${weather.today.high}F / ${weather.today.low}F`;
  const wind = current.windSpeedMph === null || current.windSpeedMph === undefined
    ? weather.today?.wind || "--"
    : `${current.windDirection || ""} ${current.windSpeedMph} mph${current.windGustMph ? ` gust ${current.windGustMph}` : ""}`.trim();
  els.weatherWind.textContent = wind;
  els.weatherUpdated.textContent = current.observedAt
    ? `Observed ${new Date(current.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : weather.forecastUpdatedAt
      ? `Forecast updated ${new Date(weather.forecastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "NWS weather";
  els.dailyWeather.innerHTML = (weather.daily || []).map((day) => {
    const rain = projectedRainLabel(day);
    return `<article class="weatherDay" data-risk="${forecastRisk(day.precipitationProbability || 0)}">
      ${day.icon ? `<img src="${escapeHtml(day.icon)}" alt="${escapeHtml(day.summary || "Weather icon")}" loading="lazy">` : ""}
      <div>
        <strong>${formatDayName(day.date)}</strong>
        <span>${escapeHtml(day.summary || "--")}</span>
      </div>
      <dl>
        <div><dt>High</dt><dd>${day.high ?? "--"}F</dd></div>
        <div><dt>Low</dt><dd>${day.low ?? "--"}F</dd></div>
        <div><dt>Rain</dt><dd>${day.precipitationProbability ?? 0}%</dd></div>
        <div><dt>Amount</dt><dd>${rain}</dd></div>
      </dl>
    </article>`;
  }).join("");
}

function renderRadar(radar) {
  if (!radar || !radarMap) return;
  els.radarTime.textContent = radar.updatedAt
    ? `Radar ${new Date(radar.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "NOAA radar";
  const bounds = L.latLng(HOME.lat, HOME.lon).toBounds(68000);
  if (radarOverlay) radarOverlay.remove();
  const radarTime = radar.validTime ? `time=${encodeURIComponent(radar.validTime)}&` : "";
  radarOverlay = L.imageOverlay(`/api/radar-image?${radarTime}t=${Date.now()}`, bounds, { opacity: 0.72, interactive: false });
  radarOverlay.addTo(radarMap);
}

function projectedRainLabel(day) {
  if (Number(day.precipitationProbability || 0) <= 0) return "None";
  if (day.projectedRainInches !== null && day.projectedRainInches !== undefined) {
    return `${fmt.format(day.projectedRainInches)}"`;
  }
  return day.rainText ? escapeHtml(day.rainText) : "Amount unavailable";
}

function formatDayName(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function renderForecast(forecast) {
  if (!forecast?.hours?.length) {
    els.forecast.innerHTML = `<p class="emptyForecast">No hourly forecast is available right now.</p>`;
    els.forecastPeak.textContent = "Forecast unavailable";
    return;
  }
  const peak = forecast.peak;
  els.forecastPeak.textContent = peak
    ? `Peak: ${peak.precipitationProbability}% at ${formatHour(peak.startTime)}`
    : "No rain risk reported";
  els.forecast.innerHTML = forecast.hours.map((hour) => {
    const probability = Math.max(0, Math.min(100, Number(hour.precipitationProbability) || 0));
    return `<article class="forecastHour" data-risk="${forecastRisk(probability)}" title="${escapeHtml(hour.shortForecast)}">
      <span>${formatHour(hour.startTime)}</span>
      <div class="probabilityTrack"><i style="height:${Math.max(4, probability)}%"></i></div>
      <strong>${probability}%</strong>
      <small>${hour.temperature}${escapeHtml(hour.temperatureUnit || "")}</small>
    </article>`;
  }).join("");
}

function formatHour(value) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric" });
}

function forecastRisk(probability) {
  if (probability >= 70) return "high";
  if (probability >= 40) return "medium";
  if (probability > 0) return "low";
  return "none";
}

function renderBars(months) {
  const max = Math.max(...months.map((m) => m.inches), 0.1);
  els.bars.innerHTML = months.map((m) => {
    const height = Math.max(3, (m.inches / max) * 100);
    const { monthName, year } = splitMonth(m.month);
    return `<div class="bar" title="${monthName} ${year}: ${inches(m.inches)}">
      <div class="barFill" style="height:${height}%"></div>
      <strong>${fmt.format(m.inches)}</strong>
      <span>${monthName}</span>
      <em>${year}</em>
    </div>`;
  }).join("");
}

function renderCalendar(days, months) {
  const byMonth = new Map();
  const dayValues = new Map(days.map((day) => [day.date, day]));
  for (const day of days) {
    const key = day.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(day);
  }
  const monthTotals = new Map(months.map((m) => [m.month, m.inches]));
  els.calendar.innerHTML = [...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, monthDays]) => {
    const blanks = weekdayForDateParts(`${month}-01`);
    const { monthName, year } = splitMonth(month);
    const [, monthNumber] = month.split("-").map(Number);
    const monthLength = daysInMonth(year, monthNumber);
    const cells = Array.from({ length: blanks }, () => `<span class="day empty" aria-hidden="true"></span>`)
      .concat(Array.from({ length: monthLength }, (_, index) => {
        const dayNumber = index + 1;
        const date = dateKey(year, monthNumber, dayNumber);
        const day = dayValues.get(date) || { date, inches: 0 };
        const hasRain = Number(day.inches) > 0;
        return `<span class="day" data-level="${rainLevel(day.inches)}" title="${formatDateLabel(day.date)}: ${inches(day.inches)}">
          <b>${dayNumber}</b>
          <small>${hasRain ? fmt.format(day.inches) : ""}</small>
        </span>`;
      }))
      .join("");
    return `<section class="month">
      <div class="monthTitle"><span>${monthName} ${year}</span><span>${inches(monthTotals.get(month) || 0)}</span></div>
      <div class="weekdays" aria-hidden="true"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
      <div class="days">${cells}</div>
    </section>`;
  }).join("");
}

function rainLevel(value) {
  if (value >= 2) return 5;
  if (value >= 1) return 4;
  if (value >= 0.5) return 3;
  if (value >= 0.1) return 2;
  if (value > 0) return 1;
  return 0;
}

function splitMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return { year, monthName: MONTHS[monthNumber - 1] };
}

function formatDateLabel(date) {
  const [year, monthNumber, day] = date.split("-").map(Number);
  return `${MONTHS[monthNumber - 1]} ${day}, ${year}`;
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function weekdayForDateParts(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).getDay();
}

function initMap() {
  map = L.map("map", {
    zoomControl: true,
    scrollWheelZoom: true
  }).setView([HOME.lat, HOME.lon], 10);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const homeIcon = L.divIcon({ className: "homeMarker", iconSize: [18, 18] });
  L.marker([HOME.lat, HOME.lon], { icon: homeIcon }).addTo(map).bindPopup("227 Tournament Circle");
}

function initRadarMap() {
  radarMap = L.map("radarMap", {
    zoomControl: false,
    dragging: true,
    scrollWheelZoom: false,
    doubleClickZoom: false
  }).setView([HOME.lat, HOME.lon], 9);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(radarMap);

  const homeIcon = L.divIcon({ className: "homeMarker", iconSize: [18, 18] });
  L.marker([HOME.lat, HOME.lon], { icon: homeIcon }).addTo(radarMap).bindPopup("227 Tournament Circle");
}

function updateMap(period) {
  if (!map) return;
  activePeriod = period;
  document.querySelectorAll(".period").forEach((button) => {
    button.classList.toggle("active", button.dataset.period === period);
  });
  const bounds = L.latLng(HOME.lat, HOME.lon).toBounds(56000);
  if (overlay) overlay.remove();
  overlay = L.imageOverlay(`/api/map-image?period=${period}&t=${Date.now()}`, bounds, { opacity: 0.58, interactive: false });
  overlay.addTo(map);
}

document.querySelectorAll(".period").forEach((button) => {
  button.addEventListener("click", () => updateMap(button.dataset.period));
});

els.refresh.addEventListener("click", () => loadRainfall(true));
initMap();
initRadarMap();
loadRainfall();
