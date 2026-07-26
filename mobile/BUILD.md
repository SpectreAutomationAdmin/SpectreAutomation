# Spectre Mobile — Build & Release

Phase 14G ships CI scaffolding for native iOS + Android Capacitor builds. The
workflows live at `.github/workflows/mobile-ios.yml` and
`.github/workflows/mobile-android.yml`. Both are **manual-dispatch only** —
real native builds require signing material that must never run on every push.

## When to build

| Scenario                                | Trigger                  | Track                            |
| --------------------------------------- | ------------------------ | -------------------------------- |
| Internal dogfood / staging              | `workflow_dispatch` → `staging`    | TestFlight Internal / Play Internal |
| Pilot golf club sign-off                | `workflow_dispatch` → `staging`    | TestFlight External / Play Closed |
| Production go-live                      | `workflow_dispatch` → `production` | App Store / Play Production       |

## Required GitHub secrets

Configure under **Settings → Secrets and variables → Actions**. No signing
material lives in the repo.

### iOS

| Secret                              | Source                                   |
| ----------------------------------- | ---------------------------------------- |
| `APPLE_TEAM_ID`                     | Apple Developer portal                   |
| `APPLE_CERT_P12_BASE64`             | `base64 dist.p12` from Keychain Access   |
| `APPLE_CERT_P12_PASSWORD`           | password set when exporting the .p12     |
| `APPLE_PROVISIONING_PROFILE_B64`    | `base64 spectre.mobileprovision`         |
| `ASC_API_KEY_ID`                    | App Store Connect → Users and Access     |
| `ASC_API_ISSUER_ID`                 | same                                     |
| `ASC_API_PRIVATE_KEY`               | contents of the `.p8` file               |

### Android

| Secret                       | Source                                       |
| ---------------------------- | -------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`    | `base64 upload-keystore.jks`                 |
| `ANDROID_KEYSTORE_PASSWORD`  | keystore password set with `keytool`         |
| `ANDROID_KEY_ALIAS`          | key alias inside the keystore                |
| `ANDROID_KEY_PASSWORD`       | key password                                 |
| `PLAY_SERVICE_ACCOUNT_JSON`  | Google Play API service-account JSON (optional, only needed if you enable auto-publish to a Play track) |

## Running a build

1. Bump `mobile/capacitor.config.json` `appVersion` and `versionCode` /
   `CFBundleShortVersionString` on the matching native project files.
2. Push the version bump to the trunk branch.
3. GitHub → Actions → choose the workflow → **Run workflow**.
4. Provide the version + build number / version code inputs.
5. Wait for the workflow to complete (45–60 min). Artifacts download:
   - iOS: `spectre-ios-<env>-<version>-<build>.zip` (contains the `.ipa`).
   - Android: `spectre-android-<env>-<version>-<code>.zip` (contains the `.aab`).
6. Production environment requires a manual approver — configure GitHub
   environment protection rules under **Settings → Environments → production**.

## Local builds (no CI required)

The Capacitor scaffold builds locally with the standard Xcode / Android
Studio workflow:

```bash
npm install
npm run build                     # builds the Next.js app
cd mobile
npx cap sync ios                  # or: npx cap sync android
npx cap open ios                  # opens Xcode
```

Local builds bypass the CI signing material entirely — sign with your local
Apple ID / debug keystore for dogfood, and only invoke the CI workflow for
release-grade signed binaries.

## Why workflow_dispatch only?

CI-driven builds are billable runner minutes. We want them deliberate, not
on-every-push. The brief explicitly avoids "broad commercial scaling" in
Phase 14, so the build cadence is **operator-driven for the first pilot**.

## Troubleshooting

- **Exit code 78** in either workflow means signing secrets were not
  configured — the workflow exited *neutrally* rather than failing the run.
- **xcodebuild exit 65** usually means the provisioning profile doesn't
  cover the bundle ID or the .p12 isn't in the runner keychain. Double-check
  `APPLE_PROVISIONING_PROFILE_B64`.
- **`./gradlew bundleRelease` fails with KeyStore was tampered with** —
  keystore base64 was corrupted in transit. Re-export and re-set the secret.

## Phase 15+ candidates (intentionally not in scope)

- Auto-publish to TestFlight / Play Internal via Fastlane.
- Cross-platform changelog generation.
- Release notes auto-fill from `CHANGELOG.md`.
- Mobile-side feature-flag rollout aligned with Phase 8 server flags.
