import Foundation

struct CurrentData: Decodable {
    let address: String
    let updatedAt: String
    let periods: [RainPeriod]
    let rapid: RapidData?
    let qualityNotes: [String]

    func total(_ hours: Int) -> Double? { periods.first { $0.hours == hours }?.inches }
}

struct RainPeriod: Decodable, Identifiable {
    let hours: Int
    let inches: Double?
    let rapid: Bool?
    var id: Int { hours }
}

struct RapidData: Decodable {
    let rainRate: RainRate?
    let oneHour: RainPeriodRapid?
}

struct RainRate: Decodable {
    let inchesPerHour: Double?
    let validTime: String?
}

struct RainPeriodRapid: Decodable {
    let validTime: String?
}

struct WeatherData: Decodable {
    let current: CurrentWeather
    let today: TodayWeather
    let daily: [DailyWeather]
}

struct CurrentWeather: Decodable {
    let conditions: String
    let temperature: Int?
    let station: String
    let observedAt: String?
    let windSpeedMph: Int?
    let windDirection: String?
    let windGustMph: Int?
    let humidity: Int?
}

struct TodayWeather: Decodable {
    let high: Int?
    let low: Int?
    let summary: String
}

struct DailyWeather: Decodable, Identifiable {
    let date: String
    let high: Int?
    let low: Int?
    let precipitationProbability: Int
    let projectedRainInches: Double?
    let summary: String
    var id: String { date }
}

struct ForecastData: Decodable {
    let hours: [ForecastHour]
    let peak: ForecastHour?
}

struct ForecastHour: Decodable, Identifiable {
    let startTime: String
    let precipitationProbability: Int
    let temperature: Int
    let shortForecast: String
    var id: String { startTime }
}

struct HistoryData: Decodable {
    let weekTotal: Double
    let monthTotal: Double
    let annualTotal: Double
    let wettestDay: RainDay?
    let months: [RainMonth]
    let days: [RainDay]
}

struct RainDay: Decodable, Identifiable {
    let date: String
    let inches: Double
    let source: String?
    var id: String { date }
}

struct RainMonth: Decodable, Identifiable {
    let month: String
    let inches: Double
    var id: String { month }
}

struct RadarData: Decodable {
    let updatedAt: String
    let frames: [RadarFrame]
}

struct RadarFrame: Decodable, Identifiable {
    let rasterId: Int
    let validTime: String?
    var id: Int { rasterId }
}

struct RateHistory: Decodable {
    let samples: [RateSample]
}

struct RateSample: Decodable, Identifiable {
    let time: String?
    let inchesPerHour: Double?
    let file: String
    var id: String { file }
}

enum DisplayFormat {
    private static func parse(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)
    }

    static func inches(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%.2f″", value)
    }

    static func rate(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%.2f″/hr", value)
    }

    static func date(_ iso: String?, style: DateFormatter.Style = .short) -> String {
        guard let date = parse(iso) else { return "—" }
        let formatter = DateFormatter()
        formatter.dateStyle = style
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    static func hour(_ iso: String?) -> String {
        guard let date = parse(iso) else { return "—" }
        return date.formatted(.dateTime.hour())
    }

    static func day(_ key: String) -> String {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = Calendar(identifier: .gregorian).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return key }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }
}
