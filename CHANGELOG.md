# Changelog

## [Unreleased]

### Changed

- Scoped seat MCP tools to each seat's own session so server-added tools no longer appear in Main or other seats
- Settled seat runs, including descendant work, with a single run-end wait that aborts immediately on cancellation

## [0.2.0] - 2026-11-15

### Added

- Added Windows process start-time detection without relying on `ps`
- Added Windows support for exclusive bare cache locking using LockFileEx, retrying while another process holds the lock

### Fixed

- Fixed GitHub App registration on Windows by opening the default browser through Windows PowerShell's `Start-Process` instead of the unavailable `open` command; a failed hand-off still ends the registration at once with "Cannot open"

## [0.1.59] - 2026-11-12

### Changed

- Published versions now come from the `release` branch, which the shared `omomp-release` workflow updates daily at 02:00 GMT+9 instead of bumping the patch version on every push to `main`
- Install instructions now point at `omp plugin install https://github.com/oh-my-omp/omp-dispatch#release`
