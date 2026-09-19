# Short CLI command for Discord Coding Presence

**Question:** Is `dcp` safe enough as the short command for the proposed
`discord-coding-presence` package? If not, what short alternative is better?

**Checked:** 2026-09-20

## Decision

Use `dcp` as the CLI command. Keep `discord-coding-presence` as the package
name. The current public npm package named `dcp` exposes no executable in any
published version, so installing the proposed package would not conflict with
that package's command. `dcp` is the clearest, memorable abbreviation of
Discord Coding Presence.

This is an evidence-based point-in-time decision, not a reservation. Run the
same registry check immediately before the first public release. npm package
names are unique; executable names are package metadata and are not separately
reserved by the registry.

## Evidence

| Candidate | Registry result | Executable result | Assessment |
| --- | --- | --- | --- |
| `dcp` | Registered; latest is `0.3.1` | Its nine published versions (`0.0.1` through `0.3.1`) all omit `bin` | Accept for the proposed CLI. Existing package-name overlap is a small discoverability risk, not a command conflict. |
| `dcpr` | 404 (unregistered) | No package metadata exists | Viable fallback, but less immediately legible. |
| `dcpresence` | 404 (unregistered) | No package metadata exists | Viable fallback, but longer. |
| `discordcp` | 404 (unregistered) | No package metadata exists | Viable fallback, but less natural. |
| `discp` | 404 (unregistered) | No package metadata exists | Viable fallback, but ambiguous. |
| `discord-coding-presence` | 404 (unregistered) | No package metadata exists | Proposed package name remains available at this check. |

The npm `bin` field maps command names to files. Global installation links
those files into the global bin directory. Therefore, a registry record without
a `bin` field does not install a command. npm documentation also shows that a
package's name and version form its unique package identifier; it does not
define a separate, globally reserved executable-name namespace.

## Limits and release gate

- No public registry query can prove a command is globally collision-free.
  A different package can publish a `dcp` bin mapping later, and users can have
  unrelated PATH entries.
- Before release, re-fetch the records below, inspect each latest `bin` field,
  and smoke-test a clean global install on supported operating systems.
- Do not reserve, publish, rename, or deprecate anything while this map remains
  planning-only.

## Sources

- [npm registry: `dcp`](https://registry.npmjs.org/dcp) — authoritative package
  metadata; all published versions checked for their `bin` field.
- [npm registry: `dcpr`](https://registry.npmjs.org/dcpr), [npm registry:
  `dcpresence`](https://registry.npmjs.org/dcpresence), [npm registry:
  `discordcp`](https://registry.npmjs.org/discordcp), [npm registry:
  `discp`](https://registry.npmjs.org/discp), and [npm registry:
  `discord-coding-presence`](https://registry.npmjs.org/discord-coding-presence)
  — each returned HTTP 404 on 2026-09-20.
- [npm `package.json` documentation: `bin`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin)
  — command names are supplied by package metadata and linked on global
  installation.
- [npm `package.json` documentation: `name`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#name)
  — uniqueness applies to a package name and version.
