import SwiftUI
import Charts

struct HistoryView: View {
    @EnvironmentObject private var store: RainfallStore

    var body: some View {
        ScrollView {
            if let history = store.history {
                VStack(alignment: .leading, spacing: 18) {
                    SectionTitle("Rainfall history", subtitle: "Completed days over the past year")
                    HStack(spacing: 10) {
                        totalCard("7 days", value: history.weekTotal)
                        totalCard("This month", value: history.monthTotal)
                        totalCard("Past year", value: history.annualTotal)
                    }
                    RainCard {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionTitle("Monthly totals", subtitle: "Inches of rain")
                            Chart(history.months) { month in
                                BarMark(x: .value("Month", month.month), y: .value("Inches", month.inches))
                                    .foregroundStyle(Color.rainBlue.gradient)
                                    .cornerRadius(3)
                            }
                            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 6)) }
                            .frame(height: 220)
                        }
                    }
                    if let wettest = history.wettestDay {
                        RainCard {
                            Label("Wettest day", systemImage: "cloud.heavyrain.fill")
                                .font(.headline).foregroundStyle(Color.rainBlue)
                            Text(DisplayFormat.inches(wettest.inches)).font(.title.bold())
                            Text(DisplayFormat.day(wettest.date)).font(.subheadline).foregroundStyle(Color.rainSecondary)
                        }
                    }
                    RainCard {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionTitle("Trends", subtitle: "Based on completed days")
                            let recent30 = Array(history.days.suffix(30))
                            let recent90 = Array(history.days.suffix(90))
                            trendRow("Rain days, last 30", value: "\(recent30.filter { $0.inches >= 0.01 }.count) of \(recent30.count)")
                            trendRow("Rain days, last 90", value: "\(recent90.filter { $0.inches >= 0.01 }.count) of \(recent90.count)")
                            trendRow("Soaking days, past year", value: "\(history.days.filter { $0.inches >= 0.5 }.count)")
                            trendRow("Days at 1 inch or more", value: "\(history.days.filter { $0.inches >= 1 }.count)")
                            trendRow("Current dry stretch", value: "\(history.days.reversed().prefix { $0.inches <= 0.01 }.count) days")
                        }
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        SectionTitle("Past-year calendar", subtitle: "Darker days had more rainfall · MRMS marks recent radar totals")
                        ForEach(history.months.reversed()) { month in
                            MonthCalendar(month: month, days: history.days.filter { $0.date.hasPrefix(month.month) })
                        }
                    }
                    RainCard {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionTitle("Daily rainfall", subtitle: "Most recent completed days")
                            ForEach(history.days.suffix(30).reversed()) { day in
                                HStack {
                                    Text(DisplayFormat.day(day.date))
                                    Spacer()
                                    if day.source?.contains("MRMS") == true {
                                        Text("MRMS").font(.caption2.bold()).foregroundStyle(Color.rainBlue)
                                    }
                                    Text(DisplayFormat.inches(day.inches)).font(.subheadline.monospacedDigit())
                                }
                                Divider().overlay(Color.white.opacity(0.12))
                            }
                        }
                    }
                }
                .padding(16)
            } else {
                EmptyState(title: "No history yet", message: "Connect to the data service and pull to refresh.")
                    .padding(16)
            }
        }
        .background(Color.rainBackground.ignoresSafeArea())
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(refresh: true) }
    }

    private func totalCard(_ title: String, value: Double) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.caption).foregroundStyle(Color.rainSecondary)
            Text(DisplayFormat.inches(value)).font(.headline.monospacedDigit()).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.rainCard, in: RoundedRectangle(cornerRadius: 14))
    }

    private func trendRow(_ title: String, value: String) -> some View {
        HStack {
            Text(title).foregroundStyle(Color.rainSecondary)
            Spacer()
            Text(value).fontWeight(.semibold)
        }
        .font(.subheadline)
    }
}

private struct MonthCalendar: View {
    let month: RainMonth
    let days: [RainDay]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

    private var monthStart: Date? {
        let parts = month.month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return Calendar(identifier: .gregorian).date(from: DateComponents(year: parts[0], month: parts[1], day: 1, hour: 12))
    }

    var body: some View {
        RainCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(monthStart?.formatted(.dateTime.month(.wide).year()) ?? month.month).font(.headline)
                    Spacer()
                    Text(DisplayFormat.inches(month.inches)).foregroundStyle(Color.rainBlue).font(.subheadline.bold())
                }
                LazyVGrid(columns: columns, spacing: 5) {
                    ForEach(["S", "M", "T", "W", "T", "F", "S"].indices, id: \.self) { index in
                        Text(["S", "M", "T", "W", "T", "F", "S"][index])
                            .font(.caption2).foregroundStyle(Color.rainSecondary)
                    }
                    if let start = monthStart {
                        let calendar = Calendar(identifier: .gregorian)
                        let offset = calendar.component(.weekday, from: start) - 1
                        let count = calendar.range(of: .day, in: .month, for: start)?.count ?? 0
                        ForEach(0..<(offset + count), id: \.self) { index in
                            if index < offset {
                                Color.clear.frame(height: 34)
                            } else {
                                let number = index - offset + 1
                                let key = String(format: "%@-%02d", month.month, number)
                                let day = days.first { $0.date == key }
                                Text("\(number)")
                                    .font(.caption.bold())
                                    .frame(maxWidth: .infinity, minHeight: 34)
                                    .background(shade(day?.inches ?? 0), in: RoundedRectangle(cornerRadius: 7))
                                    .overlay(alignment: .bottomTrailing) {
                                        if day?.source?.contains("MRMS") == true {
                                            Circle().fill(.cyan).frame(width: 4, height: 4).padding(3)
                                        }
                                    }
                                    .accessibilityLabel("\(DisplayFormat.day(key)), \(DisplayFormat.inches(day?.inches))")
                            }
                        }
                    }
                }
            }
        }
    }

    private func shade(_ inches: Double) -> Color {
        if inches >= 2 { return .indigo }
        if inches >= 1 { return .blue }
        if inches >= 0.5 { return Color.rainBlue.opacity(0.8) }
        if inches >= 0.1 { return Color.rainBlue.opacity(0.55) }
        if inches > 0 { return Color.rainBlue.opacity(0.25) }
        return Color.white.opacity(0.06)
    }
}
