import SwiftUI
import MapKit

struct RadarView: View {
    @EnvironmentObject private var store: RainfallStore
    @State private var period = 1
    @State private var frameIndex = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionTitle("Current radar", subtitle: "NOAA base reflectivity around 227 Tournament Circle")
                if let radar = store.radar {
                    RainCard {
                        VStack(alignment: .leading, spacing: 10) {
                            RadarMap(imageURL: store.endpoint("/api/radar-image", query: radarQuery(radar)), radius: 80_000)
                                .frame(height: 320)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                            HStack {
                                Text("Radar \(DisplayFormat.date(radar.frames[safe: frameIndex]?.validTime ?? radar.updatedAt))")
                                    .font(.caption).foregroundStyle(Color.rainSecondary)
                                Spacer()
                                if radar.frames.count > 1 {
                                    Button { frameIndex = (frameIndex - 1 + radar.frames.count) % radar.frames.count } label: { Image(systemName: "chevron.left") }
                                    Button { frameIndex = (frameIndex + 1) % radar.frames.count } label: { Image(systemName: "chevron.right") }
                                }
                            }
                        }
                    }
                }
                SectionTitle("Storm map", subtitle: "Radar estimated rainfall for the selected period")
                Picker("Rainfall period", selection: $period) {
                    ForEach([1, 6, 12, 24], id: \.self) { hours in Text("\(hours)h").tag(hours) }
                }
                .pickerStyle(.segmented)
                RainCard {
                    VStack(alignment: .leading, spacing: 10) {
                        RadarMap(imageURL: store.endpoint("/api/map-image", query: [URLQueryItem(name: "period", value: String(period))]), radius: 45_000)
                            .frame(height: 320)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        HStack {
                            Text("At home")
                            Spacer()
                            Text(DisplayFormat.inches(store.current?.total(period))).font(.headline.monospacedDigit())
                        }
                        Text("Map colors represent NOAA MRMS radar estimates in inches.")
                            .font(.caption).foregroundStyle(Color.rainSecondary)
                    }
                }
            }
            .padding(16)
        }
        .background(Color.rainBackground.ignoresSafeArea())
        .navigationTitle("Radar")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(refresh: true) }
    }

    private func radarQuery(_ radar: RadarData) -> [URLQueryItem] {
        guard let frame = radar.frames[safe: frameIndex] else { return [] }
        return [URLQueryItem(name: "rasterId", value: String(frame.rasterId))]
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

private struct RadarMap: UIViewRepresentable {
    let imageURL: URL?
    let radius: Double
    private let home = CLLocationCoordinate2D(latitude: 39.575348823737, longitude: -75.933586373761)

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.mapType = .standard
        map.showsCompass = true
        map.setRegion(MKCoordinateRegion(center: home, latitudinalMeters: radius * 2.3, longitudinalMeters: radius * 2.3), animated: false)
        let marker = MKPointAnnotation()
        marker.coordinate = home
        marker.title = "227 Tournament Circle"
        map.addAnnotation(marker)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        guard context.coordinator.url != imageURL else { return }
        context.coordinator.url = imageURL
        context.coordinator.task?.cancel()
        map.removeOverlays(map.overlays)
        guard let imageURL else { return }
        context.coordinator.task = Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: imageURL)
                guard !Task.isCancelled, let image = UIImage(data: data) else { return }
                await MainActor.run {
                    guard context.coordinator.url == imageURL else { return }
                    map.addOverlay(ImageOverlay(center: home, radius: radius, image: image), level: .aboveRoads)
                }
            } catch { /* Keep the native basemap visible while the image service is unavailable. */ }
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var url: URL?
        var task: Task<Void, Never>?
        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let overlay = overlay as? ImageOverlay else { return MKOverlayRenderer(overlay: overlay) }
            return ImageOverlayRenderer(overlay: overlay)
        }
    }
}

private final class ImageOverlay: NSObject, MKOverlay {
    let coordinate: CLLocationCoordinate2D
    let boundingMapRect: MKMapRect
    let image: UIImage

    init(center: CLLocationCoordinate2D, radius: Double, image: UIImage) {
        coordinate = center
        self.image = image
        let point = MKMapPoint(center)
        let distance = radius * MKMapPointsPerMeterAtLatitude(center.latitude)
        boundingMapRect = MKMapRect(x: point.x - distance, y: point.y - distance, width: distance * 2, height: distance * 2)
    }
}

private final class ImageOverlayRenderer: MKOverlayRenderer {
    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        guard let overlay = overlay as? ImageOverlay, let image = overlay.image.cgImage else { return }
        let rect = self.rect(for: overlay.boundingMapRect)
        context.saveGState()
        context.setAlpha(0.7)
        context.translateBy(x: rect.minX, y: rect.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(origin: .zero, size: rect.size))
        context.restoreGState()
    }
}
