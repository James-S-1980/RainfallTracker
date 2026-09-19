import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: RainfallStore
    @State private var editingURL = ""

    var body: some View {
        Form {
            Section("Data service") {
                TextField("Server URL", text: $editingURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .accessibilityLabel("Data service URL")
                Button("Save and connect") {
                    store.baseURL = editingURL.trimmingCharacters(in: .whitespacesAndNewlines)
                    store.updateServerURL()
                }
                .disabled(editingURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Text("Use http://localhost:5173 in the iPhone Simulator. On a physical iPhone, enter a reachable HTTPS URL for the Node data service.")
                    .font(.footnote)
            }
            Section("Location") {
                LabeledContent("Address", value: "227 Tournament Circle")
                LabeledContent("City", value: "North East, MD 21901")
                Text("This app tracks the fixed address configured in the original Rainfall Tracker service.")
                    .font(.footnote)
            }
            Section("Sources") {
                Text("NOAA MRMS radar estimates, National Weather Service weather and forecast, and Open-Meteo daily archive.")
                    .font(.footnote)
                Text("Radar values estimate rainfall near the address and may differ from a physical rain gauge.")
                    .font(.footnote)
            }
            if let updated = store.lastUpdated {
                Section { LabeledContent("Last checked", value: updated.formatted(date: .abbreviated, time: .shortened)) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.rainBackground)
        .navigationTitle("Settings")
        .onAppear { editingURL = store.baseURL }
    }
}
