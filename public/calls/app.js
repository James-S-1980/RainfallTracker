const monthLabel = document.querySelector("#monthLabel");
const calendarGrid = document.querySelector("#calendarGrid");
const selectedDateLabel = document.querySelector("#selectedDateLabel");
const selectedCount = document.querySelector("#selectedCount");
const eventList = document.querySelector("#eventList");
const eventDetail = document.querySelector("#eventDetail");
const eventMap = document.querySelector("#eventMap");
const statusLine = document.querySelector("#statusLine");
const ingestButton = document.querySelector("#ingestButton");
const filterInputs = [...document.querySelectorAll(".filters input")];

const townFallbacks = [
  { match: /singerly|elkton/i, label: "Elkton, MD", lat: 39.6068, lon: -75.8333 },
  { match: /north east/i, label: "North East, MD", lat: 39.6001, lon: -75.9413 },
  { match: /charlestown/i, label: "Charlestown, MD", lat: 39.5732, lon: -75.9747 },
  { match: /cecilton/i, label: "Cecilton, MD", lat: 39.4048, lon: -75.8677 },
  { match: /rising sun/i, label: "Rising Sun, MD", lat: 39.6979, lon: -76.0627 },
  { match: /water witch|port deposit/i, label: "Port Deposit, MD", lat: 39.6048, lon: -76.1158 },
];

let visibleMonth = startOfMonth(new Date());
let selectedDate = toDateKey(new Date());
let monthEvents = [];
let activeEventId = null;
let map;
let marker;

document.querySelector("#prevMonth").addEventListener("click", () => {
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
  selectedDate = toDateKey(visibleMonth);
  loadMonth();
});

document.querySelector("#nextMonth").addEventListener("click", () => {
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
  selectedDate = toDateKey(visibleMonth);
  loadMonth();
});

ingestButton.addEventListener("click", async () => {
  ingestButton.disabled = true;
  ingestButton.textContent = "Syncing";
  try {
    const response = await fetch("/api/calls/ingest/run", { method: "POST" });
    const payload = await response.json();
    const result = payload.results?.[0];
    if (result?.status === "ok") {
      statusLine.textContent = `Synced ${result.fetched} public events; ${result.inserted} new`;
    } else {
      statusLine.textContent = result?.error || "Sync failed";
    }
    await loadMonth();
  } catch (error) {
    statusLine.textContent = `Sync failed: ${error.message}`;
  } finally {
    ingestButton.disabled = false;
    ingestButton.textContent = "Sync Public Logs";
  }
});

filterInputs.forEach((input) => input.addEventListener("change", render));

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function parseLocalDateTime(value) {
  return new Date(value.length === 16 ? `${value}:00` : value);
}

function enabledTypes() {
  return new Set(filterInputs.filter((input) => input.checked).map((input) => input.value));
}

async function loadMonth() {
  monthLabel.textContent = visibleMonth.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  statusLine.textContent = "Loading events";
  const response = await fetch(`/api/calls/events?month=${monthKey(visibleMonth)}`);
  monthEvents = await response.json();
  statusLine.textContent = `${monthEvents.length} stored events in ${monthLabel.textContent}`;
  render();
}

function filteredEvents() {
  const types = enabledTypes();
  return monthEvents.filter((event) => types.has(event.responder_type));
}

function render() {
  renderCalendar();
  renderList();
}

function renderCalendar() {
  calendarGrid.innerHTML = "";
  const events = filteredEvents();
  const byDay = new Map();
  for (const event of events) {
    const key = event.occurred_at.slice(0, 10);
    const bucket = byDay.get(key) || [];
    bucket.push(event);
    byDay.set(key, bucket);
  }

  const first = startOfMonth(visibleMonth);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  const todayKey = toDateKey(new Date());

  for (let offset = 0; offset < 42; offset += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + offset);
    const key = toDateKey(date);
    const dayEvents = byDay.get(key) || [];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day-cell";
    if (date.getMonth() !== visibleMonth.getMonth()) button.classList.add("is-muted");
    if (key === todayKey) button.classList.add("is-today");
    if (key === selectedDate) button.classList.add("is-selected");
    button.innerHTML = `<span class="day-number">${date.getDate()}</span><span class="badges">${badgesFor(dayEvents)}</span>`;
    button.addEventListener("click", () => {
      selectedDate = key;
      activeEventId = null;
      render();
    });
    calendarGrid.append(button);
  }
}

function badgesFor(events) {
  const counts = events.reduce((acc, event) => {
    acc[event.responder_type] = (acc[event.responder_type] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([type, count]) => `<span class="badge ${type}">${count}</span>`)
    .join("");
}

function renderList() {
  const events = filteredEvents()
    .filter((event) => event.occurred_at.startsWith(selectedDate))
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const date = new Date(`${selectedDate}T12:00:00`);
  selectedDateLabel.textContent = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  selectedCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  eventList.innerHTML = "";
  if (!events.length) {
    eventList.innerHTML = '<div class="empty-state">No stored public events for this date.</div>';
    eventDetail.innerHTML = '<div class="detail-empty">Select an event.</div>';
    renderMap(null);
    return;
  }
  for (const event of events) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "event-card";
    if (event.id === activeEventId) item.classList.add("is-active");
    item.innerHTML = `
      <div class="event-meta">
        <span>${parseLocalDateTime(event.occurred_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        <span>${labelForType(event.responder_type)}</span>
      </div>
      <div class="event-title">${escapeHtml(event.call_type)}</div>
      <div class="event-location">${escapeHtml(event.location_text)}</div>
    `;
    item.addEventListener("click", () => {
      activeEventId = event.id;
      renderDetail(event);
      renderList();
    });
    eventList.append(item);
  }
  const selected = events.find((event) => event.id === activeEventId) || events[0];
  activeEventId = selected.id;
  renderDetail(selected);
}

function renderDetail(event) {
  const mapPoint = mapPointForEvent(event);
  const mapLink = mapPoint
    ? `https://www.openstreetmap.org/?mlat=${mapPoint.lat}&mlon=${mapPoint.lon}#map=${mapPoint.exact ? 16 : 12}/${mapPoint.lat}/${mapPoint.lon}`
    : null;
  renderMap(event);
  eventDetail.innerHTML = `
    <div class="detail-grid">
      ${detailRow("Time", parseLocalDateTime(event.occurred_at).toLocaleString())}
      ${detailRow("Nature", event.call_type)}
      ${detailRow("Responder", labelForType(event.responder_type))}
      ${detailRow("Agency", event.agency)}
      ${detailRow("Location", event.location_text)}
      ${detailRow("Map", mapLink ? `<a href="${mapLink}" target="_blank" rel="noreferrer">${mapPoint.exact ? "Open exact location" : `Open town fallback: ${escapeHtml(mapPoint.label)}`}</a>` : "Not available")}
      ${detailRow("Source", `<a href="${event.source_url}" target="_blank" rel="noreferrer">${event.source_name || event.source_url}</a>`)}
    </div>
  `;
}

function mapPointForEvent(event) {
  if (!event) return null;
  const hasCoordinates = event.latitude !== null && event.latitude !== undefined && event.latitude !== ""
    && event.longitude !== null && event.longitude !== undefined && event.longitude !== "";
  const lat = Number(event.latitude);
  const lon = Number(event.longitude);
  if (hasCoordinates && Number.isFinite(lat) && Number.isFinite(lon)) {
    return {
      lat,
      lon,
      label: event.geocode_display_name || event.location_text,
      exact: true,
    };
  }
  const haystack = `${event.location_text || ""} ${event.agency || ""} ${event.source_name || ""}`;
  const fallback = townFallbacks.find((town) => town.match.test(haystack));
  if (!fallback) return null;
  return {
    lat: fallback.lat,
    lon: fallback.lon,
    label: fallback.label,
    exact: false,
  };
}

function renderMap(event) {
  if (!eventMap || !window.L) return;
  const point = mapPointForEvent(event);
  if (!map) {
    map = L.map(eventMap, {
      scrollWheelZoom: false,
      zoomControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }
  if (marker) {
    marker.remove();
    marker = null;
  }
  if (!point) {
    map.setView([39.575, -75.94], 10);
    eventMap.classList.add("is-empty");
    setTimeout(() => map.invalidateSize(), 0);
    return;
  }
  eventMap.classList.remove("is-empty");
  const zoom = point.exact ? 15 : 12;
  map.setView([point.lat, point.lon], zoom);
  marker = L.marker([point.lat, point.lon])
    .addTo(map)
    .bindPopup(point.exact ? escapeHtml(event.location_text) : `Approximate town: ${escapeHtml(point.label)}`);
  setTimeout(() => map.invalidateSize(), 0);
}

function detailRow(label, value) {
  return `
    <div class="detail-row">
      <div class="detail-label">${label}</div>
      <div class="detail-value">${typeof value === "string" && value.startsWith("<a ") ? value : escapeHtml(value || "")}</div>
    </div>
  `;
}

function labelForType(type) {
  return {
    police: "Police",
    fire_ems: "Fire/EMS",
    other: "Other",
  }[type] || type;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

initialize();

async function initialize() {
  try {
    const response = await fetch("/api/calls/stats");
    const stats = await response.json();
    if (stats.latest_event_at) {
      const latest = parseLocalDateTime(stats.latest_event_at);
      visibleMonth = startOfMonth(latest);
      selectedDate = toDateKey(latest);
    }
  } catch {
    statusLine.textContent = "Loading events";
  }
  loadMonth();
}
