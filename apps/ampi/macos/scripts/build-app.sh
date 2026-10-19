#!/bin/sh
# Builds AmPi.app (ad-hoc signed) into apps/ampi/macos/build/. Needs Xcode command line tools on macOS 13+.
# AMPI_APP=<path> and AMPI_APP_ID=<bundle id> build a separate copy (the perf runner's app scenario uses them), so its
# preferences, window position, and website data stay apart from the installed app.
set -eu
cd "$(dirname "$0")/.."
swift build -c release
APP=${AMPI_APP:-build/AmPi.app}
APP_ID=${AMPI_APP_ID:-dev.hypercarrier.ampi}
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/AmPi" "$APP/Contents/MacOS/AmPi"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>AmPi</string>
	<key>CFBundleDisplayName</key><string>AmPi</string>
	<key>CFBundleIdentifier</key><string>$APP_ID</string>
	<key>CFBundleExecutable</key><string>AmPi</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSAppTransportSecurity</key>
	<dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
codesign --force --deep --sign - "$APP"
echo "built $APP"
