import SwiftUI

extension Color {
    static let rainBackground = Color(red: 0.045, green: 0.095, blue: 0.15)
    static let rainCard = Color(red: 0.09, green: 0.15, blue: 0.22)
    static let rainSecondary = Color(red: 0.61, green: 0.72, blue: 0.81)
    static let rainBlue = Color(red: 0.16, green: 0.73, blue: 0.91)
}

struct RainCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(Color.rainCard, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

struct SectionTitle: View {
    let title: String
    let subtitle: String?
    init(_ title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.title3.bold())
            if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(Color.rainSecondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EmptyState: View {
    let title: String
    let message: String
    var body: some View {
        ContentUnavailableView(title, systemImage: "cloud.rain", description: Text(message))
            .foregroundStyle(.white)
    }
}
