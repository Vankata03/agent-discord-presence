# AgentPresence identity availability

Research date: 2026-09-19 (checked 16:53 UTC)

## Decision summary

Do **not** adopt **AgentPresence** for the full rebrand. The exact npm package
name `agentpresence` and the `Vankata03/agentpresence` repository path were
unregistered when checked, and the known same-name project's released binary
is not `agentpresence`. Those technical namespaces therefore do not block the
proposal.

But [Zenolitee/AgentPresence](https://github.com/Zenolitee/AgentPresence) is
an existing public project with the exact display name and essentially the
same promise: local AI-coding-agent activity published to Discord Rich
Presence. That creates a high user-confusion and discoverability collision,
independent of package or repository ownership. Choose another identity unless
the owner deliberately accepts that collision after legal and market review.

## Evidence

| Surface | Direct result | Meaning |
| --- | --- | --- |
| npm package `agentpresence` | [GET returns 404](https://registry.npmjs.org/agentpresence) | The exact unscoped package was not registered in the public npm registry when checked. npm documents that a published package's `name` and `version` form a unique identifier ([package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#name)). |
| npm search for `agentpresence` | [Search response](https://registry.npmjs.org/-/v1/search?text=agentpresence&size=250) had no package named `agentpresence` | Search did return related names, including `vite-plugin-agent-presence`, but not the exact package name. |
| Repository `Vankata03/agentpresence` | [GET returns 404](https://api.github.com/repos/Vankata03/agentpresence) | No accessible repository exists at the requested owner/path when checked. This is not a reservation and GitHub may also conceal inaccessible private repositories. |
| Existing public identity | [Zenolitee/AgentPresence](https://github.com/Zenolitee/AgentPresence) | The repository description and README identify it as a local Rust runtime for AI-agent activity on Discord Rich Presence; it explicitly names Codex and OpenCode, which materially overlaps this project's product. |
| Existing executable | [Cargo manifest](https://raw.githubusercontent.com/Zenolitee/AgentPresence/main/Cargo.toml) and [latest release](https://github.com/Zenolitee/AgentPresence/releases/latest) | Its Rust package and Windows release executable are named `multi-agent-presence` / `multi-agent-presence.exe`, not `agentpresence`; this check found no exact command collision from that project. |

## Command-name limit

npm's [`bin`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin)
field lets any package expose an arbitrary executable name. The public registry
does not provide an authoritative reverse index of every global executable, so
an unregistered exact package does not prove that no other package can install
an `agentpresence` command. A clean global Bun-install smoke test remains
required if a later decision selects a new command name.

## Unverified clearance

This research did not check trademarks, domain names, social handles, private
repositories, package names outside the public npm registry, or operating-system
PATH collisions. It neither reserves nor publishes the name, and the results can
change after the recorded check time.
