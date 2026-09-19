import Foundation

@MainActor
final class RainfallStore: ObservableObject {
    @Published var current: CurrentData?
    @Published var weather: WeatherData?
    @Published var forecast: ForecastData?
    @Published var history: HistoryData?
    @Published var radar: RadarData?
    @Published var rateHistory: RateHistory?
    @Published var loading = false
    @Published var rateLoading = false
    @Published var error: String?
    @Published var lastUpdated: Date?
    @Published var rateInterval = 20
    @Published var configurationVersion = 0
    @Published var baseURL: String {
        didSet { UserDefaults.standard.set(baseURL, forKey: "serverURL") }
    }

    init() {
        baseURL = UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:5173"
    }

    var normalizedBaseURL: URL? {
        guard let url = URL(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil else { return nil }
        return url
    }

    func endpoint(_ path: String, query: [URLQueryItem] = []) -> URL? {
        guard let base = normalizedBaseURL else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.path = base.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == ""
            ? path : base.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path
        components?.queryItems = query.isEmpty ? nil : query
        return components?.url
    }

    func load(refresh: Bool = false) async {
        guard normalizedBaseURL != nil else {
            error = "Enter a valid server URL in Settings."
            return
        }
        loading = true
        error = nil
        defer { loading = false }
        let query = refresh ? [URLQueryItem(name: "refresh", value: "1")] : []
        async let currentResult: Result<CurrentData, Error> = fetchResult("/api/current", query: query)
        async let weatherResult: Result<WeatherData, Error> = fetchResult("/api/weather", query: query)
        async let forecastResult: Result<ForecastData, Error> = fetchResult("/api/forecast", query: query)
        async let historyResult: Result<HistoryData, Error> = fetchResult("/api/history", query: query)
        async let radarResult: Result<RadarData, Error> = fetchResult("/api/radar", query: query)
        var failures: [String] = []
        switch await currentResult { case .success(let value): current = value; case .failure(let issue): failures.append("Rainfall: \(issue.localizedDescription)") }
        switch await weatherResult { case .success(let value): weather = value; case .failure(let issue): failures.append("Weather: \(issue.localizedDescription)") }
        switch await forecastResult { case .success(let value): forecast = value; case .failure(let issue): failures.append("Forecast: \(issue.localizedDescription)") }
        switch await radarResult { case .success(let value): radar = value; case .failure(let issue): failures.append("Radar: \(issue.localizedDescription)") }
        switch await historyResult { case .success(let value): history = value; case .failure(let issue): failures.append("History: \(issue.localizedDescription)") }
        error = failures.isEmpty ? nil : failures.joined(separator: "\n")
        if failures.count < 5 { lastUpdated = Date() }
        Task { await loadRateHistory(refresh: refresh) }
    }

    func loadRateHistory(refresh: Bool = false) async {
        rateLoading = true
        defer { rateLoading = false }
        let query = [URLQueryItem(name: "interval", value: String(rateInterval))]
            + (refresh ? [URLQueryItem(name: "refresh", value: "1")] : [])
        do {
            rateHistory = try await fetch("/api/rain-rate-history", query: query)
        } catch {
            // The core dashboard stays usable if the large GRIB history request fails.
            rateHistory = nil
        }
    }

    func updateServerURL() {
        configurationVersion += 1
        current = nil
        weather = nil
        forecast = nil
        history = nil
        radar = nil
        rateHistory = nil
        Task { await load() }
    }

    private func fetchResult<T: Decodable>(_ path: String, query: [URLQueryItem]) async -> Result<T, Error> {
        do { return .success(try await fetch(path, query: query)) }
        catch { return .failure(error) }
    }

    private func fetch<T: Decodable>(_ path: String, query: [URLQueryItem]) async throws -> T {
        guard let url = endpoint(path, query: query) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.timeoutInterval = path.contains("rain-rate-history") ? 180 : 45
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
            if let payload = try? JSONDecoder().decode(APIErrorPayload.self, from: data) {
                throw APIError.service(payload.error)
            }
            throw APIError.service("The data service did not respond successfully.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct APIErrorPayload: Decodable { let error: String }

private enum APIError: LocalizedError {
    case invalidURL
    case service(String)
    var errorDescription: String? {
        switch self {
        case .invalidURL: "Invalid server URL"
        case .service(let message): message
        }
    }
}
