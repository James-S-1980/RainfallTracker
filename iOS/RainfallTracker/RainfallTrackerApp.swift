import SwiftUI

@main
struct RainfallTrackerApp: App {
    @StateObject private var store = RainfallStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .tint(.cyan)
        }
    }
}
