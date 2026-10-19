# AmPi

AmPi is an experimental, single-user GUI and local hub for Pi Sessions. This export is a midway snapshot for technical testing. It combines Timeline, Arcs, Rarebit, Team views, and HC Control. The node backend remains deferred.

AmPi has live Herdr integration paths, but full UX acceptance remains open. Open work remains in Arc cache, boundaries, model behavior, commands, and performance.

## Requirements

- Node.js 22.19 or newer.
- macOS or a compatible Unix environment for local process and tmux discovery.
- Optional: Pi, Herdr, SSH, and tmux for live Session discovery and control.

## Install and run

From the HyperCarrier Alpha root:

```sh
npm ci
npm run build:ampi
npm exec --workspace @hypercarrier/ampi -- ampi hub
```

The hub prints a local URL with its access key. Keep that URL private. Run `ampi open` from another terminal to print the link again. Use `ampi doctor` to inspect setup.

## Verify

```sh
npm --workspace @hypercarrier/ampi test
npm --workspace @hypercarrier/ampi run typecheck
npm --workspace @hypercarrier/ampi run build:web
npm --workspace @hypercarrier/ampi run deploy:check
```

The export includes synthetic test coverage and real Herdr integration code. The receipt above covers one live integration observation. Full UX acceptance remains open.

## macOS app

On macOS 13 or newer with Xcode Command Line Tools, build the native window shell:

```sh
sh apps/ampi/macos/scripts/build-app.sh
```

The shell uses the same local hub as the CLI. It owns the window, menu bar, notifications, and Dock badge.

## Architecture

- [Pi backend and control contract](docs/pi-backend.md)
- [HC Control package](../../packages/pi-hc-control/README.md)
- [Durable Team package](../../packages/durable-team/README.md)
- [Durable Rarebit package](../../packages/durable-rarebit/README.md)
- [Durable Compact package](../../packages/durable-compact/README.md)
