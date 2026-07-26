# Spectre mobile shell

This directory holds the Capacitor configuration used to wrap Spectre's PWA for the App Store and Google Play.

**Strategic note:** Spectre's mobile experience is the PWA. The native shell is a thin Capacitor wrapper, not a separate codebase. The web app is the source of truth; the native build re-uses the same routes, same auth, same service worker.

## Phase 11 status

Capacitor scaffold is **production-ready**. iOS / Android Xcode + Android Studio binaries, signing, and store submission live in your local build environment — they are deliberately not committed here because they include certificates and signing material.

## What's here

- `capacitor.config.json` — appId, appName, server URL, plugin defaults
- Asset placeholders (icons + splash) live in `public/icons/` and are referenced by the PWA manifest as well
- This README documents the build + submission checklist

## Local build

```bash
npm install -g @capacitor/cli
npm install --save @capacitor/core @capacitor/ios @capacitor/android
npx cap init Spectre club.spectre.app  # only the first time
npx cap add ios
npx cap add android
npx cap sync
npx cap open ios       # opens Xcode
npx cap open android   # opens Android Studio
```

After running `cap add`, commit only the bare-minimum `capacitor.config.json` and `mobile/README.md`. The generated `ios/` and `android/` directories contain machine-specific build settings and should stay in `.gitignore` for development; clubs ship their own signed copies.

## Environment switching

Three build profiles are supported via env vars at `cap sync` time:

| Profile | `SPECTRE_API_BASE` | Notes |
|---|---|---|
| Dev | `http://localhost:3000` | Used during in-house testing |
| Staging | `https://staging.app.example.club` | TestFlight / internal Play track |
| Production | `https://app.example.club` | App Store / Play production |

The `server.url` field in `capacitor.config.json` reads from this env var (replace at build time).

## Deep links

iOS Universal Links + Android App Links target the production origin. Configure in:

- iOS: `ios/App/App/AppDelegate.swift` → `apple-app-site-association` (hosted at `/.well-known/apple-app-site-association`)
- Android: `android/app/src/main/res/values/strings.xml` → `intent-filter` for `app.example.club`

Both resolve directly to the PWA route — no separate native route map.

## Push notifications

The PWA service worker (`public/sw.js`) handles `push` events. Native shells layer Capacitor's `PushNotifications` plugin on top:

1. iOS: APNs certificate uploaded to App Store Connect. The Capacitor plugin registers the device token; the web layer POSTs it to `/api/push/subscribe` alongside the standard VAPID endpoint so a member can hit the same push pipeline either via web push or APNs.
2. Android: FCM credentials in `google-services.json`. Same registration flow.

VAPID keys must be configured via the Spectre admin (Integrations → PUSH → vapid) before push works on either platform.

## Authentication

iron-session cookies persist inside the WebView the same way they persist in browsers. No token exchange needed. Note: iOS WKWebView shares cookies with Safari only when `WKHTTPCookieStore` is explicitly enabled (the Capacitor default).

## File downloads

The PWA streams via signed-URL `Document` access tokens. Native shells inherit this; large blobs should use the browser download intent rather than in-app rendering. Capacitor's `Filesystem` plugin can persist small downloads if needed.

## Offline

The service worker provides offline fallback via `/offline.html`. Native shells do not currently bundle the app shell — they require initial network. Tournament score draft saving is the one exception: drafts post to the server, but the PWA also caches them in `localStorage` so partial drafts survive a network blip.

## Feature flags

- `pwa_push` — gates the push-notification prompt
- `mobile_native_features` (Phase 11) — toggles native-only enhancements like biometric unlock
- `mobile_offline_scoring` (Phase 11) — enables the local-storage offline queue for tournament scoring

## App Store submission checklist

1. **App Store Connect**: create app record, fill in App Privacy section (Spectre collects member data — declare per Apple guidelines)
2. **Apple Developer**: APNs certificate, signing certificate, provisioning profile, App ID with Push Notifications capability
3. **TestFlight**: upload via Xcode → Window → Organizer; invite internal testers first
4. **Screenshots**: 6.7" + 5.5" + iPad if supporting iPad
5. **App description**: emphasize "club-issued login required"
6. **Sign-in with Apple**: not required (we use the club's existing auth)
7. **Submit for review**: expect 1–3 days

## Play Store submission checklist

1. **Play Console**: create app, fill in Data Safety (mirrors Apple's App Privacy)
2. **Internal testing**: closed track first; add testers by email
3. **Signing**: enroll in Play App Signing
4. **Screenshots**: phone + 7" tablet + 10" tablet if supporting tablets
5. **Content rating**: complete the questionnaire
6. **FCM**: upload `google-services.json` and configure Cloud Messaging
7. **Submit**: expect a few hours to a day

## Versioning

Mobile builds follow the same semver as the web app, with an additional native build number that auto-increments. The web layer reads `SPECTRE_VERSION` env var (set at deploy time); the native shells include it in user-agent strings for log correlation.

## Native shell limitations

- **No app-store-only features.** All flows must work on the PWA first.
- **No background sync without user-initiated action.** Both iOS and Android restrict background fetch.
- **No silent push that changes state**. Push messages are notifications + optional badge.
- **Cookies must match domain.** Capacitor `server.url` must match Spectre's TLS-terminating origin.

## What's not in this directory

- Real app icons (use the existing 192×192 + 512×512 PWA icons as a starting point; a designer should produce 1024×1024 + adaptive variants before submission)
- Signing certificates (handled in your local keychain / Play Console)
- Build automation (Fastlane / EAS Build / GitHub Actions live in your CI pipeline)
