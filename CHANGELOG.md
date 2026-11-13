# Changelog

## [Unreleased]

### Added

- Added Windows process start-time detection without relying on `ps`
- Added Windows support for exclusive bare cache locking using LockFileEx, retrying while another process holds the lock

## [0.1.59] - 2026-11-12

### Changed

- Published versions now come from the `release` branch, which the shared `omomp-release` workflow updates daily at 02:00 GMT+9 instead of bumping the patch version on every push to `main`
- Install instructions now point at `omp plugin install https://github.com/oh-my-omp/omp-dispatch#release`
