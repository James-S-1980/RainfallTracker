# Rainfall Tracker for iPhone

A native SwiftUI iPhone app for the fixed location at 227 Tournament Circle, North East, Maryland. The app uses Swift Charts for rainfall and forecast graphs, MapKit for radar and rainfall maps, and the existing Node service for NOAA MRMS GRIB2 sampling, weather, and rainfall history.

## Run

1. From the repository root, install the Node dependency with `npm ci` and start the service with `npm run dev`.
2. Open `iOS/RainfallTracker.xcodeproj` in Xcode 15 or later. Select the **RainfallTracker** scheme and an iPhone simulator running iOS 17 or later.
3. Run the app. Its default service URL is `http://localhost:5173`, which works in the iPhone Simulator while the Node service runs on the same Mac.

For a physical iPhone, host the Node service at an HTTPS URL reachable by the phone and enter that URL in the app's Settings tab. The app does not currently ship with a hosted data service. The Node service's data location is fixed in `server.js`.

`project.yml` is the XcodeGen source for the checked-in Xcode project. After changing the project specification, regenerate it with `xcodegen generate --spec iOS/project.yml` from the repository root.

## Screens

- **Today:** current 1, 6, 12, and 24 hour totals, rapid rain rate, current weather, five day outlook, hourly rain chance, and two hour rain rate chart.
- **Radar:** native MapKit map with NOAA radar frames and selectable 1, 6, 12, and 24 hour MRMS rainfall overlays.
- **History:** daily and monthly totals from the original service, including recent MRMS daily overrides.
- **Settings:** configurable service URL and source information.

## Verify

```sh
xcodebuild -project iOS/RainfallTracker.xcodeproj \
  -scheme RainfallTracker \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  CODE_SIGNING_ALLOWED=NO build
```

The app needs the Node service running to show live data. If a source is temporarily unavailable, other sections still load and the affected section shows an error or empty state.
