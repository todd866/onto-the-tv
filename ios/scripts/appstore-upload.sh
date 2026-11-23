#!/bin/zsh
# Archive and export/upload Onto the TV (iOS + Apple TV) to App Store Connect / TestFlight.
# Usage:
#   scripts/appstore-upload.sh archive     # builds .xcarchive bundles in build/archives/
#   scripts/appstore-upload.sh upload      # exports and uploads directly to App Store Connect
set -euo pipefail
cd "${0:A:h}/.."

MODE="${1:-archive}"
mkdir -p build/archives build/export

xcodegen generate --spec project.yml --project . >/dev/null

cat > build/ExportOptions.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>teamID</key>
	<string>U87MQBZKJ5</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>uploadSymbols</key>
	<true/>
	<key>destination</key>
	<string>upload</string>
</dict>
</plist>
EOF

echo "== archiving OntoTheTV (iOS)"
xcodebuild -project OntoTheTV.xcodeproj -scheme OntoTheTV \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/archives/OntoTheTV-iOS.xcarchive \
  -allowProvisioningUpdates archive

echo "== archiving OntoTheTVApple (tvOS)"
xcodebuild -project OntoTheTV.xcodeproj -scheme OntoTheTVApple \
  -configuration Release -destination 'generic/platform=tvOS' \
  -archivePath build/archives/OntoTheTV-tvOS.xcarchive \
  -allowProvisioningUpdates archive

# Note: W40 workaround — keep system /usr/bin/rsync first in PATH during exportArchive.
if [[ "$MODE" == "upload" ]]; then
  PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild -exportArchive \
    -archivePath build/archives/OntoTheTV-iOS.xcarchive \
    -exportOptionsPlist build/ExportOptions.plist -exportPath build/export/ios -allowProvisioningUpdates
  PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild -exportArchive \
    -archivePath build/archives/OntoTheTV-tvOS.xcarchive \
    -exportOptionsPlist build/ExportOptions.plist -exportPath build/export/tvos -allowProvisioningUpdates
  echo "Uploaded OntoTheTV (iOS & tvOS) builds to App Store Connect / TestFlight."
fi
