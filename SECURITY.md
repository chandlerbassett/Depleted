# Security

## Reporting a vulnerability

Please don't open a public issue for security problems. Report them privately through
GitHub instead: on this repository's **Security** tab, choose **Report a vulnerability**.
Include what you found, how to reproduce it, and which version of Depleted you're on
(Settings shows it).

You'll get a reply within a few days. Fixes ship in a new release, and you'll be
credited in its notes unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes.

## How Depleted handles your data

- Recordings, coach data and settings stay on your Mac. Nothing is uploaded.
- Your Warcraft Logs API client ID and secret are encrypted with the macOS Keychain
  and are only ever sent to warcraftlogs.com.
- The app makes two kinds of network calls: to the Warcraft Logs API, for the Coach's
  top-player comparison, and to GitHub, to check this repo's releases for updates.
  macOS only installs an update signed with the same Developer ID as the app.
