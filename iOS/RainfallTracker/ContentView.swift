import SwiftUI
import Charts

struct ContentView: View {
    @EnvironmentObject private var store: RainfallStore

    var body: some View {
        TabView {
            NavigationStack { OverviewView() }
                .tabItem { Label("Today", systemImage: "cloud.rain.fill") }
            NavigationStack { RadarView() }
                .tabItem { Label("Radar", systemImage: "map.fill") }
            NavigationStack { HistoryView() }
                .tabItem { Label("History", systemImage: "chart.bar.fill") }
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .preferredColorScheme(.dark)
        .task { await store.load() }
    }
}

struct OverviewView: View {
    @EnvironmentObject private var store: RainfallStore
    @State private var selectedInterval = 20

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("227 TOURNAMENT CIRCLE")
                        .font(.caption.weight(.bold)).tracking(1.8).foregroundStyle(Color.rainBlue)
                    Text("Rainfall Tracker").font(.largeTitle.bold())
                    Text("North East, Maryland").foregroundStyle(Color.rainSecondary)
                }
                if let error = store.error {
                    RainCard {
                        Label("Some data could not load", systemImage: "exclamationmark.triangle.fill")
                            .font(.headline).foregroundStyle(.orange)
                        Text(error).font(.caption).foregroundStyle(Color.rainSecondary)
                    }
                }
                if let current = store.current {
                    RainCard {
                        VStack(alignment: .leading, spacing: 14) {
                            HStack {
                                Label("Last hour", systemImage: "drop.fill")
                                    .foregroundStyle(Color.rainBlue)
                                Spacer()
                                if current.periods.first(where: { $0.hours == 1 })?.rapid == true {
                                    Text("LIVE MRMS").font(.caption2.bold()).foregroundStyle(.cyan)
                                }
                            }
                            Text(DisplayFormat.inches(current.total(1)))
                                .font(.system(size: 52, weight: .bold, design: .rounded))
                                .minimumScaleFactor(0.6)
                            HStack {
                                Label("Rain rate", systemImage: "speedometer")
                                Spacer()
                                Text(DisplayFormat.rate(current.rapid?.rainRate?.inchesPerHour))
                                    .font(.headline.monospacedDigit())
                            }
                            .foregroundStyle(Color.rainSecondary)
                            Divider().overlay(Color.white.opacity(0.2))
                            HStack(spacing: 8) {
                                PeriodTile(hours: 6, value: current.total(6))
                                PeriodTile(hours: 12, value: current.total(12))
                                PeriodTile(hours: 24, value: current.total(24))
                            }
                            Text("Updated \(DisplayFormat.date(current.updatedAt))")
                                .font(.caption).foregroundStyle(Color.rainSecondary)
                        }
                    }
                } else if store.loading {
                    ProgressView("Loading rainfall…").frame(maxWidth: .infinity).padding(40)
                } else {
                    EmptyState(title: "No rainfall data", message: "Check the server URL in Settings, then pull to refresh.")
                }
                if let weather = store.weather { weatherSection(weather) }
                if let forecast = store.forecast { forecastSection(forecast) }
                rateSection
                if let notes = store.current?.qualityNotes, !notes.isEmpty {
                    RainCard {
                        SectionTitle("About these readings")
                        ForEach(notes, id: \.self) { note in
                            Text("• \(note)").font(.caption).foregroundStyle(Color.rainSecondary)
                        }
                    }
                }
            }
            .padding(16)
        }
        .background(Color.rainBackground.ignoresSafeArea())
        .navigationTitle("Today")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await store.load(refresh: true) } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(store.loading)
                .accessibilityLabel("Refresh rainfall data")
            }
        }
        .refreshable { await store.load(refresh: true) }
    }

    private func weatherSection(_ weather: WeatherData) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Weather", subtitle: weather.current.station)
            RainCard {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(weather.current.conditions).font(.title3.bold())
                            Text(weather.today.summary).font(.subheadline).foregroundStyle(Color.rainSecondary)
                        }
                        Spacer()
                        Text(weather.current.temperature.map { "\($0)°" } ?? "—")
                            .font(.system(size: 48, weight: .medium, design: .rounded))
                    }
                    HStack(spacing: 16) {
                        WeatherFact(label: "High / low", value: "\(weather.today.high.map(String.init) ?? "—")° / \(weather.today.low.map(String.init) ?? "—")°")
                        WeatherFact(label: "Wind", value: weather.current.windSpeedMph.map { "\(weather.current.windDirection ?? "") \($0) mph" } ?? "—")
                        WeatherFact(label: "Humidity", value: weather.current.humidity.map { "\($0)%" } ?? "—")
                    }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(weather.daily) { day in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(DisplayFormat.day(day.date)).font(.subheadline.bold()).lineLimit(1)
                            Text(day.summary).font(.caption).foregroundStyle(Color.rainSecondary).lineLimit(2)
                            Spacer(minLength: 0)
                            Text("\(day.precipitationProbability)% rain").foregroundStyle(Color.rainBlue).font(.subheadline.bold())
                            Text(DisplayFormat.inches(day.projectedRainInches) + " projected").font(.caption)
                            Text("\(day.high.map(String.init) ?? "—")° / \(day.low.map(String.init) ?? "—")°").font(.caption).foregroundStyle(Color.rainSecondary)
                        }
                        .frame(width: 150, height: 122, alignment: .topLeading)
                        .padding(14)
                        .background(Color.rainCard, in: RoundedRectangle(cornerRadius: 16))
                    }
                }
            }
        }
    }

    private func forecastSection(_ forecast: ForecastData) -> some View {
        RainCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle("Next 12 hours", subtitle: "Chance of rain")
                if !forecast.hours.isEmpty {
                    Chart(forecast.hours) { hour in
                        BarMark(x: .value("Hour", DisplayFormat.hour(hour.startTime)),
                                y: .value("Chance", hour.precipitationProbability))
                            .foregroundStyle(Color.rainBlue.gradient)
                            .cornerRadius(4)
                    }
                    .chartYScale(domain: 0...100)
                    .chartYAxis { AxisMarks(values: [0, 50, 100]) }
                    .frame(height: 150)
                    if let peak = forecast.peak {
                        Text("Peak \(peak.precipitationProbability)% at \(DisplayFormat.hour(peak.startTime)) · \(peak.shortForecast)")
                            .font(.caption).foregroundStyle(Color.rainSecondary)
                    }
                }
            }
        }
    }

    private var rateSection: some View {
        RainCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle("Rain rate history", subtitle: "Past two hours · inches per hour")
                Picker("Sample interval", selection: $selectedInterval) {
                    ForEach([30, 20, 10, 5, 2], id: \.self) { interval in
                        Text("\(interval)m").tag(interval)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: selectedInterval) { _, value in
                    store.rateInterval = value
                    Task { await store.loadRateHistory() }
                }
                if store.rateLoading {
                    ProgressView("Loading radar samples…").frame(maxWidth: .infinity).padding()
                } else if let samples = store.rateHistory?.samples, !samples.isEmpty {
                    Chart(samples) { sample in
                        BarMark(x: .value("Time", DisplayFormat.hour(sample.time)),
                                y: .value("Rate", sample.inchesPerHour ?? 0))
                            .foregroundStyle(Color.rainBlue.gradient)
                    }
                    .frame(height: 140)
                    if let latest = samples.last {
                        Text("Latest: \(DisplayFormat.rate(latest.inchesPerHour)) at \(DisplayFormat.hour(latest.time))")
                            .font(.caption).foregroundStyle(Color.rainSecondary)
                    }
                } else {
                    Text("Rain-rate history is unavailable.").font(.subheadline).foregroundStyle(Color.rainSecondary)
                }
            }
        }
    }
}

private struct PeriodTile: View {
    let hours: Int
    let value: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("\(hours) HOURS").font(.caption2.bold()).foregroundStyle(Color.rainSecondary)
            Text(DisplayFormat.inches(value)).font(.title3.bold().monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WeatherFact: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption2).foregroundStyle(Color.rainSecondary)
            Text(value).font(.subheadline.bold()).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
