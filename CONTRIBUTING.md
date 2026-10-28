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

## Scope

Depleted is a Mythic+ recorder and coach for macOS on Apple silicon. Arena and other PvP modes,
Intel Macs and Windows are out of scope.

The Coach learns what good play looks like from top Warcraft Logs runs, so it works for every
class and spec. Please prefer changes that keep it data-driven over hand-written per-spec rules.

## Code style

TypeScript and Vue 3 with Prettier (`npm run format`). Comments explain *why* rather than *what*.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
