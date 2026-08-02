const HOME = { lat: 39.575348823737, lon: -75.933586373761 };
const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let map;
let radarMap;
let overlay;
let radarOverlay;
let radarAnimationTimer;
let radarAnimationIndex = 0;
let activePeriod = "24";
let activeRateInterval = 20;
let rateHistoryRequestId = 0;

const els = {
  dot: document.querySelector("#statusDot"),
  status: document.querySelector("#statusText"),
  refresh: document.querySelector("#refreshButton"),
  note: document.querySelector("#sourceNote"),
  quality: document.querySelector("#qualityNotes"),
  total1Source: document.querySelector("#total1Source"),
  rainRate: document.querySelector("#rainRate"),
  rainRateSource: document.querySelector("#rainRateSource"),
  rateHistory: document.querySelector("#rateHistoryChart"),
  rateHistoryUpdated: document.querySelector("#rateHistoryUpdated"),
  rateIntervalButtons: document.querySelectorAll(".rateIntervalButton"),
  weatherUpdated: document.querySelector("#weatherUpdated"),
  weatherConditions: document.querySelector("#weatherConditions"),
  weatherTemp: document.querySelector("#weatherTemp"),
  weatherHighLow: document.querySelector("#weatherHighLow"),
  weatherWind: document.querySelector("#weatherWind"),
  weatherStation: document.querySelector("#weatherStation"),
  dailyWeather: document.querySelector("#dailyWeather"),
  radarTime: document.querySelector("#radarTime"),
  radarFrameTime: document.querySelector("#radarFrameTime"),
  forecast: document.querySelector("#forecastTimeline"),
  forecastPeak: document.querySelector("#forecastPeak"),
  trends: document.querySelector("#trendCards"),
  trendsUpdated: document.querySelector("#trendsUpdated"),
  calendar: document.querySelector("#calendar"),
  bars: document.querySelector("#monthlyBars"),
  wettest: document.querySelector("#wettestDay")
};

function inches(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${fmt.format(Number(value))}"`;
}

function inchesPerHour(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${fmt.format(Number(value))}"/hr`;
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
    renderTrends(data);
    setStatus(`Updated ${new Date(data.current.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "ready");
    updateMap(activePeriod);
    loadRateHistory(refresh);
  } catch (error) {
    setStatus(error.message || "Unable to load data", "error");
  }
}

async function loadRateHistory(refresh = false) {
  if (!els.rateHistory) return;
  const requestId = rateHistoryRequestId + 1;
  rateHistoryRequestId = requestId;
  const slowNote = activeRateInterval <= 5 ? " This can take a few minutes the first time." : "";
  renderRateHistoryProgress(0, 1, activeRateInterval, slowNote);
  try {
    const planResponse = await fetch(`/api/rain-rate-history-plan?interval=${encodeURIComponent(activeRateInterval)}`);
    if (!planResponse.ok) throw new Error("Rain-rate history is unavailable");
    if (requestId !== rateHistoryRequestId) return;
    const plan = await planResponse.json();
    const samples = await loadRateHistorySamples(plan.samples || [], requestId, refresh, plan.intervalMinutes || activeRateInterval);
    if (requestId !== rateHistoryRequestId || !samples) return;
    renderRateHistory({ ...plan, samples });
  } catch (error) {
    if (requestId !== rateHistoryRequestId) return;
    els.rateHistory.innerHTML = `<p class="emptyForecast">${escapeHtml(error.message || "Unable to load rain-rate history.")}</p>`;
    if (els.rateHistoryUpdated) els.rateHistoryUpdated.textContent = "Rapid MRMS";
  }
}

async function loadRateHistorySamples(plannedSamples, requestId, refresh, intervalMinutes) {
  const samples = new Array(plannedSamples.length);
  let completed = 0;
  let next = 0;
  const workerCount = Math.min(intervalMinutes <= 5 ? 2 : 3, plannedSamples.length);
  renderRateHistoryProgress(0, plannedSamples.length, intervalMinutes);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < plannedSamples.length) {
      if (requestId !== rateHistoryRequestId) return;
      const index = next;
      next += 1;
      const params = new URLSearchParams({ file: plannedSamples[index].file });
      if (refresh) params.set("refresh", "1");
      const response = await fetch(`/api/rain-rate-sample?${params}`);
      if (!response.ok) throw new Error("Rain-rate sample is unavailable");
      samples[index] = await response.json();
      completed += 1;
      if (requestId === rateHistoryRequestId) {
        renderRateHistoryProgress(completed, plannedSamples.length, intervalMinutes);
      }
    }
  });
  await Promise.all(workers);
  return requestId === rateHistoryRequestId ? samples : null;
}

function renderRateHistoryProgress(completed, total, intervalMinutes, note = "") {
  const safeTotal = Math.max(1, total);
  const percent = Math.round((completed / safeTotal) * 100);
  if (els.rateHistoryUpdated) {
    els.rateHistoryUpdated.textContent = `${intervalMinutes}m samples; ${percent}% loaded`;
  }
  els.rateHistory.innerHTML = `<div class="rateProgress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
    <div class="rateProgressText">
      <strong>${percent}%</strong>
      <span>${completed} of ${total} samples loaded${escapeHtml(note)}</span>
    </div>
    <div class="rateProgressTrack"><i style="width:${percent}%"></i></div>
  </div>`;
}

function renderCurrent(current) {
  for (const period of current.periods) {
    const target = document.querySelector(`#total${period.hours}`);
    if (target) target.textContent = inches(period.inches);
  }
  const oneHour = current.periods.find((p) => p.hours === 1);
  if (els.total1Source) {
    els.total1Source.textContent = oneHour?.rapid ? "Rapid MRMS" : "NOAA MRMS";
  }
  if (els.rainRate) {
    els.rainRate.textContent = inchesPerHour(current.rapid?.rainRate?.inchesPerHour);
  }
  if (els.rainRateSource) {
    els.rainRateSource.textContent = current.rapid?.rainRate?.validTime
      ? `Rapid MRMS ${new Date(current.rapid.rainRate.validTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Rapid MRMS";
  }
  const latest = current.periods.find((p) => p.hours === 24) || current.periods[0];
  const validTimes = [...new Set(current.periods.map((p) => p.validEndTime).filter(Boolean))];
  const validMs = validTimes.map((time) => new Date(time).getTime()).filter(Number.isFinite);
  const valid = validMs.length ? new Date(Math.max(...validMs)) : null;
  const synced = validTimes.length <= 1;
  const rapidOneHour = current.rapid?.oneHour?.validTime ? new Date(current.rapid.oneHour.validTime) : null;
  const resolution = latest?.resolutionMeters ? ` at roughly ${(latest.resolutionMeters / 1000).toFixed(1)} km sample resolution` : "";
  els.note.textContent = valid
    ? `${rapidOneHour ? `Rapid 1-hour total is valid at ${rapidOneHour.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. ` : ""}NOAA radar totals ${synced ? "are" : "are not all"} valid through the same hour; latest layer is ${valid.toLocaleString()}${resolution}.`
    : "NOAA radar totals are live estimates and may be revised.";
  renderQuality(current);
}

function renderQuality(current) {
  els.quality.innerHTML = (current.qualityNotes || [])
    .map((note) => `<p>${escapeHtml(note)}</p>`)
    .join("");
}

function renderRateHistory(history) {
  const samples = history?.samples || [];
  if (!samples.length) {
    els.rateHistory.innerHTML = `<p class="emptyForecast">No rain-rate history is available right now.</p>`;
    if (els.rateHistoryUpdated) els.rateHistoryUpdated.textContent = "Rapid MRMS";
    return;
  }
  const values = samples.map((sample) => Number(sample.inchesPerHour) || 0);
  const max = Math.max(...values, 0.1);
  const latest = samples.at(-1);
  els.rateHistory.style.gridTemplateColumns = `repeat(${samples.length}, minmax(62px, 1fr))`;
  if (els.rateHistoryUpdated) {
    els.rateHistoryUpdated.textContent = latest?.time
      ? `${history.intervalMinutes || activeRateInterval}m samples; latest ${new Date(latest.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Rapid MRMS";
  }
  els.rateHistory.innerHTML = samples.map((sample) => {
    const value = Number(sample.inchesPerHour) || 0;
    const height = Math.max(3, (value / max) * 100);
    const time = sample.time ? new Date(sample.time) : null;
    const label = time ? time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--";
    return `<article class="rateBar" data-rate-level="${rateLevel(value)}" title="${escapeHtml(label)}: ${inchesPerHour(value)}">
      <div class="rateBarTrack"><i style="height:${height}%; background:${rateColor(value)}"></i></div>
      <strong>${fmt.format(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </article>`;
  }).join("");
}

function rateLevel(value) {
  if (value >= 0.75) return "heavy";
  if (value >= 0.25) return "moderate";
  if (value > 0) return "light";
  return "none";
}

function rateColor(value) {
  const stops = [
    { value: 0, color: [207, 216, 208] },
    { value: 0.05, color: [175, 221, 162] },
    { value: 0.25, color: [225, 199, 72] },
    { value: 0.5, color: [218, 126, 55] },
    { value: 1, color: [178, 58, 72] },
    { value: 2, color: [126, 32, 52] }
  ];
  const rate = Math.max(0, Number(value) || 0);
  const upperIndex = stops.findIndex((stop) => rate <= stop.value);
  if (upperIndex <= 0) return rgb(stops[0].color);
  if (upperIndex === -1) return rgb(stops.at(-1).color);
  const lower = stops[upperIndex - 1];
  const upper = stops[upperIndex];
  const ratio = (rate - lower.value) / (upper.value - lower.value);
  return rgb(lower.color.map((component, index) => Math.round(component + (upper.color[index] - component) * ratio)));
}

function rgb(parts) {
  return `rgb(${parts.join(", ")})`;
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
  const frames = (radar.frames || []).filter((frame) => frame.rasterId && frame.time);
  if (radarAnimationTimer) {
    clearInterval(radarAnimationTimer);
    radarAnimationTimer = null;
  }
  els.radarTime.textContent = frames.length > 1
    ? `Animating ${frames.length} frames`
    : radar.updatedAt
      ? `Radar ${new Date(radar.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "NOAA radar";
  radarAnimationIndex = 0;
  if (frames.length) {
    showRadarFrame(frames[radarAnimationIndex]);
    if (frames.length > 1) {
      radarAnimationTimer = setInterval(() => {
        radarAnimationIndex = (radarAnimationIndex + 1) % frames.length;
        showRadarFrame(frames[radarAnimationIndex]);
      }, 1200);
    }
    return;
  }
  showRadarFrame({
    time: radar.validTime,
    validTime: radar.updatedAt,
    rasterId: null
  });
}

function showRadarFrame(frame) {
  const bounds = L.latLng(HOME.lat, HOME.lon).toBounds(68000);
  if (radarOverlay) radarOverlay.remove();
  const params = new URLSearchParams({ t: String(Date.now()) });
  if (frame?.rasterId) params.set("rasterId", String(frame.rasterId));
  else if (frame?.time) params.set("time", String(frame.time));
  radarOverlay = L.imageOverlay(`/api/radar-image?${params}`, bounds, { opacity: 0.72, interactive: false });
  radarOverlay.addTo(radarMap);
  const frameDate = frame?.validTime ? new Date(frame.validTime) : frame?.time ? new Date(frame.time) : null;
  if (els.radarFrameTime) {
    els.radarFrameTime.textContent = frameDate
      ? frameDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "NOAA radar";
  }
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

function renderTrends(data) {
  if (!els.trends) return;
  const history = data.history || {};
  const days = (history.days || []).filter((day) => Number.isFinite(Number(day.inches)));
  if (!days.length) {
    els.trends.innerHTML = `<p class="emptyForecast">Trend data is unavailable right now.</p>`;
    if (els.trendsUpdated) els.trendsUpdated.textContent = "Waiting for history";
    return;
  }

  const current24 = data.current?.periods?.find((period) => period.hours === 24)?.inches ?? null;
  const last7 = days.slice(-7);
  const previous7 = days.slice(-14, -7);
  const last30 = days.slice(-30);
  const last90 = days.slice(-90);
  const last7Total = sumInches(last7);
  const previous7Total = sumInches(previous7);
  const rainy30 = countRainDays(last30, 0.01);
  const rainy90 = countRainDays(last90, 0.01);
  const soakingYear = countRainDays(days, 0.5);
  const heavyYear = countRainDays(days, 1);
  const dryStreak = trailingStreak(days, (day) => Number(day.inches) <= 0.01);
  const wetStreak = trailingStreak(days, (day) => Number(day.inches) > 0.01);
  const monthRank = rankCurrentMonth(history.months || []);
  const currentMonth = (history.months || []).at(-1);
  const dailyRank = rankDailyAmount(days, current24);
  const forecastStats = summarizeForecast(data.weather);
  const mrmsDays = days.filter((day) => String(day.source || "").includes("MRMS")).length;

  const cards = [
    {
      label: "Last 7 days",
      value: inches(last7Total),
      detail: `Previous 7 days: ${inches(previous7Total)} (${compareTotals(last7Total, previous7Total)})`,
      tone: last7Total >= previous7Total ? "wet" : "dry"
    },
    {
      label: "How often it rained",
      value: `${rainy30} of 30`,
      detail: `${rainy90} measurable-rain days in the last 90 days`,
      tone: rainy30 >= 10 ? "wet" : "neutral"
    },
    {
      label: "Soaking rain days",
      value: `${soakingYear}`,
      detail: `Days at 0.50"+ in the past year; ${heavyYear} reached 1.00"+`,
      tone: heavyYear > 0 ? "storm" : "neutral"
    },
    {
      label: dryStreak ? "Current dry stretch" : "Current wet stretch",
      value: `${dryStreak || wetStreak} ${pluralize("day", dryStreak || wetStreak)}`,
      detail: dryStreak ? "Completed days with 0.01\" or less" : "Completed days with measurable rain",
      tone: dryStreak >= 5 ? "dry" : wetStreak >= 2 ? "wet" : "neutral"
    },
    {
      label: "This month so far",
      value: currentMonth ? inches(currentMonth.inches) : "--",
      detail: monthRank ? `#${monthRank.rank} wettest of the ${monthRank.total} months shown` : "Monthly context unavailable",
      tone: monthRank?.rank <= 3 ? "wet" : "neutral"
    },
    {
      label: "Last 24 hours",
      value: current24 === null ? "--" : inches(current24),
      detail: dailyRank ? `Comparable to the #${dailyRank.rank} daily rainfall total shown` : "24-hour context unavailable",
      tone: current24 >= 1 ? "storm" : current24 > 0.1 ? "wet" : "neutral"
    },
    {
      label: "Next 5 days",
      value: forecastStats.rainDays === null ? "--" : `${forecastStats.rainDays} ${pluralize("day", forecastStats.rainDays)}`,
      detail: forecastStats.detail,
      tone: forecastStats.rainDays >= 3 ? "wet" : "neutral"
    },
    {
      label: "Calendar source",
      value: `${mrmsDays}`,
      detail: "Recent days using radar totals instead of archive estimates",
      tone: "neutral"
    }
  ];

  if (els.trendsUpdated) {
    els.trendsUpdated.textContent = `${days.length} completed days analyzed`;
  }
  els.trends.innerHTML = cards.map((card) => `<article class="trendCard" data-tone="${card.tone}">
    <span>${escapeHtml(card.label)}</span>
    <strong>${escapeHtml(card.value)}</strong>
    <p>${escapeHtml(card.detail)}</p>
  </article>`).join("");
}

function sumInches(days) {
  return Number(days.reduce((total, day) => total + (Number(day.inches) || 0), 0).toFixed(3));
}

function countRainDays(days, threshold) {
  return days.filter((day) => Number(day.inches) >= threshold).length;
}

function trailingStreak(days, predicate) {
  let count = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (!predicate(days[index])) break;
    count += 1;
  }
  return count;
}

function compareTotals(current, previous) {
  const delta = Number((current - previous).toFixed(2));
  if (Math.abs(delta) < 0.01) return "about the same";
  return `${delta > 0 ? "up" : "down"} ${inches(Math.abs(delta))}`;
}

function rankCurrentMonth(months) {
  const current = months.at(-1);
  if (!current) return null;
  const sorted = [...months].sort((a, b) => b.inches - a.inches);
  return { rank: sorted.findIndex((month) => month.month === current.month) + 1, total: sorted.length };
}

function rankDailyAmount(days, amount) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
  const totals = [...days.map((day) => Number(day.inches) || 0), Number(amount)].sort((a, b) => b - a);
  return { rank: totals.findIndex((value) => value <= Number(amount)) + 1, total: totals.length };
}

function summarizeForecast(weather) {
  const days = weather?.daily || [];
  if (!days.length) return { rainDays: null, detail: "Forecast context unavailable" };
  const rainDays = days.filter((day) => Number(day.precipitationProbability || 0) >= 40).length;
  const projected = Number(days.reduce((total, day) => total + (Number(day.projectedRainInches) || 0), 0).toFixed(2));
  const highs = days.map((day) => Number(day.high)).filter(Number.isFinite);
  const highRange = highs.length ? `${Math.min(...highs)}-${Math.max(...highs)}F highs` : "temperature trend unavailable";
  const rainText = projected > 0 ? `${inches(projected)} projected rain` : "little projected rain";
  return { rainDays, detail: `${rainText}; ${highRange}` };
}

function pluralize(word, count) {
  return Number(count) === 1 ? word : `${word}s`;
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
        const isRadar = String(day.source || "").includes("MRMS");
        const archiveNote = day.archiveInches === undefined ? "" : `; archive value was ${inches(day.archiveInches)}`;
        const sourceNote = day.source ? ` (${day.source}${archiveNote})` : "";
        return `<span class="day" data-level="${rainLevel(day.inches)}" data-source="${isRadar ? "radar" : "archive"}" title="${formatDateLabel(day.date)}: ${inches(day.inches)}${sourceNote}">
          <b>${dayNumber}</b>
          ${isRadar ? `<em>MRMS</em>` : ""}
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

els.rateIntervalButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeRateInterval = Number(button.dataset.interval || 20);
    els.rateIntervalButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    loadRateHistory(false);
  });
});

els.refresh.addEventListener("click", () => loadRainfall(true));
initMap();
initRadarMap();
loadRainfall();
