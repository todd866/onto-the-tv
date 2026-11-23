# Onto the TV for iPhone and Apple TV

Native remote for the TV server, and the Apple TV app that plays a channel itself. SwiftUI, iOS 18 or tvOS 18, no third-party packages. The generated Xcode project is not committed.

The iPhone app and the Apple TV app share `ios/Shared/`: `TVAPI.swift` (requests and decoding), `SettingsStore.swift`, `KeychainToken.swift`, `TVClient.swift`, `ManifoldClient.swift` (signed TV channel lenses from [Manifold](https://github.com/todd866/manifold)), and `ArtLoader.swift` (artwork with the token in the `X-Onto-Token` header, ephemeral session, nothing cached on disk).

Generate the project, then build the iPhone app:

```
cd ios && xcodegen && xcodebuild -scheme OntoTheTV -destination 'platform=iOS Simulator,name=iPhone Duo' build
```

iPhone unit tests (request building and response decoding):

```
cd ios && xcodebuild -scheme OntoTheTV -destination 'platform=iOS Simulator,name=iPhone Duo' test
```

Apple TV app and its tests (next-item selection and which files AVPlayer can open). The 4th-generation Apple TV simulator device type needs tvOS 27.2; the installed runtime is tvOS 27.0, whose Apple TV is the 3rd generation:

```
cd ios && xcodebuild -scheme OntoTheTVApple -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation),OS=27.0' test
```

Signing is automatic for team `U87MQBZKJ5`. The iPhone bundle id is `com.iantodd.ontothetv`. The Apple TV bundle id is `com.iantodd.ontothetv.tv`, display name "Onto the TV". The default server comes from the build setting `ONTO_DEFAULT_SERVER` (Info.plist key `OntoDefaultServer`); `ios/Config/Base.xcconfig` sets a placeholder, `https://your-mac.example.ts.net:8443`, and Settings can change it on the device. To build with your own server, create `~/.config/onto-the-tv/ios-private.xcconfig` (it stays outside the repository; `Base.xcconfig` includes it if present) containing one line, `ONTO_DEFAULT_SERVER = https:/$()/<your-mac>.<tailnet>.ts.net:8443` (`//` starts a comment in xcconfig, so `$()` splits it), then run `xcodegen generate` again. App Transport Security allows only local networking (`.local` names, single-label hosts, IP addresses) over plain http; a tailnet `ts.net` origin is HTTPS. The pairing token is kept in the Keychain and sent as `X-Onto-Token` on every request; only `/media` for AVPlayer carries it as `t` on the query. The household in Settings → Viewers is the `viewers` list from the last `/api/home` reply (cached for the next launch); until you pick, requests leave `viewers` out and the server uses its default audience. Debug builds on both apps also read the launch argument `-onto.qaToken <token>` (`simctl launch … -onto.qaToken <token>`).

## Apple TV

Home is picture rows: the channels, then the liked titles `/api/home` returns. Choosing a channel posts `/api/next` the way `tv/app.js` `nextBody` / `startChannel` does, and plays `/media?src=` (the token is in the query, because AVPlayer cannot set headers). When the item ends, the app posts `/api/progress` with `completed: true`, then `/api/next` with `reason: "ended"`, and keeps playing. Menu leaves the player and focuses that channel's tile.

A file AVPlayer cannot open shows `can't play on Apple TV yet` and the channel asks for another item with `reason: "error"` (it is not graded as watched or skipped). The same path a second time, or eight different unplayable files, stops on that line.

## What Apple TV cannot play yet

The server does not transcode. `streamFile` in `src/tv-server.js` sends the file bytes with a `Content-Type` taken from the extension:

| Extension | Content-Type |
| --- | --- |
| `.mp4`, `.m4v` | `video/mp4` |
| `.mov` | `video/quicktime` |
| `.mkv` | `video/x-matroska` |
| `.webm` | `video/webm` |
| `.avi` | `video/x-msvideo` |
| `.ts`, `.m2ts` | `video/mp2t` |

`/api/next` returns the library path in `src` (for example `Show/Episode.mkv`). AVPlayer on tvOS opens MP4, MOV and HLS when the codecs are H.264 or HEVC and the audio is AAC, AC-3 or E-AC-3. MKV, WebM, AVI and a raw MPEG-TS file stay on this line until the server can hand AVPlayer a container it opens.

A remux route, not part of this app, would need to:

- Take the same `src` as `/media`, and the pairing token the same way (`X-Onto-Token`, or `t` on the query).
- Remux without re-encoding when the streams are already H.264 or HEVC plus AAC, AC-3 or E-AC-3: MKV, WebM or MPEG-TS into a fragmented MP4 (`avc1` or `hvc1`, and `mp4a`, `ac-3` or `ec-3`) or an HLS playlist of those segments, with byte ranges.
- Leave any other codec for a later transcode. The app would then play that URL instead of `/media?src=`.
