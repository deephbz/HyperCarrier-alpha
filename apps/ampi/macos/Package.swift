// swift-tools-version:5.9
// AmPi for macOS: a native window around the AmPi hub. The hub (and the node it starts) stays the authority; this
// shell owns the window, the menu bar, notifications, and the Dock badge.
import PackageDescription

let package = Package(
	name: "AmPi",
	platforms: [.macOS(.v13)],
	targets: [
		.executableTarget(
			name: "AmPi",
			path: "Sources/AmPi",
			linkerSettings: [.linkedFramework("WebKit"), .linkedFramework("UserNotifications")]
		),
	]
)
