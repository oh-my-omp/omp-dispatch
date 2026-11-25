# Changelog

## [Unreleased]

### Fixed

- Fixed the plugin failing to load on omp 19.2, which left `read dispatch://…` unanswered instead of returning Dispatch state or its tool errors

## [0.3.0] - 2026-11-24

### Breaking Changes

- The `dispatch` tool is replaced by `dispatch_ticket` (`convene`, `resume`, `finish`) and `dispatch_step` (`launch`, `resolve`), and Main reads live state through the `dispatch://` URL instead of the tool's `status`, `tickets` and `read` operations
- Seats call `dispatch_submit`, `dispatch_verdict` and `dispatch_escalate` instead of one `dispatch` tool with an `op`: the ticket id and role are bound to the seat, so `submit` no longer takes `ticketId` and `verdict` no longer takes `role`, and each tool's optional `revision` defaults to the seat's bound revision
- Issue, repository and target coordinates are structured objects (`owner`, `repo` and `number`, or `branch`) instead of `<owner>/<repo>#<number>` and `<owner>/<repo>@<branch>` strings
- `resolve` takes `githubActions`, where each entry sets exactly one named action property (`publishPr`, `merge`, `setIssueState`, …), instead of `actions` entries with a `kind` field
- `dispatch_step` `resolve` requires `revision`, `ruling` and `to` in the same call, where each used to be optional

### Added

- Added the read-only `dispatch://` internal URL scheme: `read dispatch://status` returns the agenda, `read dispatch://tickets?repo=<owner>/<repo>&project=<owner>/<number>&limit=<n>` returns its tickets with optional filters, `read dispatch://<ticketId>` returns one ticket, and `read dispatch://seat` returns a seat's bound context and ticket, each as JSON and only to the caller allowed to read it

### Changed

- `@oh-my-pi/omptype`, `@oh-my-pi/pi-tui` and `@oh-my-pi/pi-utils` are now peer dependencies, and `@oh-my-pi/omptype` is no longer a regular dependency

## [0.2.3] - 2026-11-22

### Fixed

- Updated seat session contract recording to call `getMountedToolCommandNames()` for omp 19.1.0 compatibility
- Declared `loadMode: "essential"` on the `dispatch` tool for Main and seats so it stays top-level when `tools.commands` is active

## [0.2.2] - 2026-11-20

### Changed

- Scoped seat MCP tools to each seat's own session so server-added tools no longer appear in Main or other seats, and a tool a seat's own MCP call adds is presented on that seat's next request
- Settled seat runs, including descendant work, with a single run-end wait that aborts immediately on cancellation

## [0.2.1] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

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
