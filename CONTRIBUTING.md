# Contributing to Depleted

Thanks for helping out! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and ideas

Open an [issue](https://github.com/chandlerbassett/Depleted/issues/new/choose) with the bug or
feature template. For recording problems, your Mac model, macOS version and the dungeon and key
level make a big difference. Never paste your Warcraft Logs client secret.

## Getting set up

You need an Apple silicon Mac with macOS 13 or later, Node.js 22 and the Xcode Command Line Tools.

```bash
npm install
./scripts/create-signing-cert.sh   # once per Mac, so Screen Recording survives rebuilds
npm run dev
```

See [Building from source](README.md#building-from-source) for more.

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep the change focused on one thing, and add or update tests in `tests/` for logic changes.
   The parser and state machine tests run against sample combat log lines, so a real log excerpt
   is the best way to cover a new case.
3. Run `npm test` and `npm run build` before you push. CI runs both, plus the Swift helper build
   and a packaging check.
4. Open a pull request and describe what changed and how you tested it.

## Keeping it safe

Depleted runs with Screen Recording permission and reads the combat log, which other
players write to. A few rules keep that from turning into a problem:

- **Treat the combat log, SavedVariables and Warcraft Logs responses as untrusted.** Check
  types and ranges before using a value, never build a shell command, a path or a query
  from one, and keep what's kept per key or pull bounded. Spell, unit and emote names reach
  the page: render them with `{{ }}` or a bound attribute, never `v-html`.
- **The page talks to the main process only over the typed IPC in `src/shared/ipc.types.ts`.**
  A new channel also goes in `src/shared/ipcChannels.ts` (the preload refuses the rest), and
  its handler checks its parameters itself. Recording ids and file names from the page must
  stay inside the recordings folder (`isRecordingId`, `CLIP_NAME_RE` in StorageManager).
- **Run programs with `spawn`/`execFile` and an argument array**, never a shell string. Links
  leave the app through `openExternalUrl`, which only opens https.
- **Don't loosen the window or build settings** (`sandbox`, `contextIsolation`, the CSP in
  `index.html`, the Electron fuses in `build/afterPack.js`, the hardened-runtime
  entitlements) or add permissions to `ALLOWED_PERMISSIONS` without saying why in the PR.
- **Dependencies:** add one only when it earns its place, keep `package-lock.json` in the
  PR, and pin GitHub Actions to a commit. Never commit a certificate, key or client secret.

Found a security problem? Please report it privately, as [SECURITY.md](SECURITY.md) says,
rather than in an issue or PR.

## Scope

Depleted is a PvE recorder and coach for macOS on Apple silicon: Mythic+ keys and raid boss
pulls. Arena and other PvP modes, Intel Macs, Windows and Linux are out of
scope.

The Coach learns what good play looks like from top Warcraft Logs runs, so it works for every
class and spec. Please prefer changes that keep it data-driven over hand-written per-spec rules.

## Releases (maintainers)

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the DMG and attaches it
to a GitHub release. It signs the app and the DMG with a Developer ID and notarizes both when these
secrets are set in the repository's `release` environment. Keep them out of repository-level
secrets: the environment only deploys to `v*` tags and `main`, so a workflow on any other branch
can't read them.

The secrets never share a job with npm packages. The workflow builds the app with no secrets,
signs and notarizes it in a job that only runs `build/checkZip.py`, `build/signApp.sh` and
Apple's tools, makes the DMG and zip with electron-builder again without secrets, checks in a
job with neither that both hold exactly the app that was signed (same CDHash), signs and
notarizes the DMG in a job with no checkout at all, and publishes from a job with no secrets
that writes `latest-mac.yml` itself. Keep it that way: no `npm ci`, no third-party actions and
no unchecked archives in the `sign` and `sign-dmg` jobs.

| Secret | What it is |
|--------|------------|
| `MAC_CERTIFICATE_P12_BASE64` | The *Developer ID Application* certificate and its private key, exported from Keychain Access as a `.p12` and base64 encoded (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_API_KEY` | The whole `.p8` file of an App Store Connect API key with the Developer role (App Store Connect → Users and Access → Integrations → Team Keys), including its BEGIN and END lines |
| `APPLE_API_KEY_ID` | That key's Key ID |
| `APPLE_API_ISSUER` | The Issuer ID shown above the keys list |

A tag build refuses to publish unless the app and the DMG are notarized, the tagged commit is on `main`,
and the tag matches the `version` in `package.json`. It also attaches a `SHA256SUMS.txt` and
a build provenance attestation (attestations need the repository to be public).

The release also carries the zip, its blockmap and `latest-mac.yml`: installed copies of
Depleted check the latest release for those and update themselves. Don't delete or rename
them on a published release.

To cut a release:

1. Bump `version` in `package.json` in a PR and merge it.
2. Optional dry run: run the **Release** workflow by hand (Actions → Release → Run workflow)
   and try the `Depleted-test-build` download on a Mac.
3. Tag `main` and push the tag: `git tag v1.2.3 && git push origin v1.2.3`.

The Developer ID certificate expires on Feb 1, 2027 (see issue #34). Renew it under the same
Team ID: macOS only installs an update signed by the same team as the installed app.

## Code style

TypeScript and Vue 3 with Prettier (`npm run format`). Comments explain *why* rather than *what*.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
