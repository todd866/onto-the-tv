# Onto the TV for iPhone

Native remote for the TV server. SwiftUI, iOS 18 or later, no third-party packages. The generated Xcode project is not committed.

Generate the project and build:

```
cd ios && xcodegen && xcodebuild -scheme OntoTheTV -destination 'platform=iOS Simulator,name=iPhone 17' build
```

Unit tests (request building and response decoding):

```
cd ios && xcodebuild -scheme OntoTheTV -destination 'platform=iOS Simulator,name=iPhone 17' test
```

Signing is automatic for team `U87MQBZKJ5`. Bundle id `com.iantodd.ontothetv`. The default server is `http://m2:8686` (Settings). The pairing token is kept in the Keychain and sent as `X-Onto-Token`.
