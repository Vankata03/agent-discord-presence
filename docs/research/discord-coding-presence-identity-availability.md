# Discord Coding Presence identity availability

Research date: 2026-09-19

## Decision summary

**Discord Coding Presence is viable as the full identity, but it is descriptive and has a close category competitor.** The exact npm package name `discord-coding-presence` was not registered, GitHub's exact-phrase repository search returned no results, and the proposed owner repository `Vankata03/discord-coding-presence` returned `404` from GitHub's repository API. These are availability signals, not reservations.

The name is understandable at a glance: it states that coding activity is represented in Discord. Its downside is low distinctiveness. The published package `discord-coding-status` is a directly adjacent competitor: it describes itself as a local Discord Rich Presence daemon for Claude Code and Codex. The published `agent-discord-presence` is another materially similar product, although it does not use the selected name.

Use `discord-coding-presence` for the package and target repository if the map selects this identity. Treat the long command `discord-coding-presence` as a release-time compatibility check, not as cleared: npm permits packages to expose arbitrary `bin` names and does not provide a complete public index of executable names. Do not select a short alias until it has separately been checked against published package manifests and the supported installation environments.

## Direct checks

| Surface | Query and result | Interpretation |
| --- | --- | --- |
| npm package | [`GET /discord-coding-presence`](https://registry.npmjs.org/discord-coding-presence) returned `404`. | The exact npm package name was unregistered at the research date. |
| GitHub target repository | [`GET /repos/Vankata03/discord-coding-presence`](https://api.github.com/repos/Vankata03/discord-coding-presence) returned `404`. | The desired repository path was unregistered for `Vankata03`. GitHub permits other owners to use the same repository name. |
| GitHub phrase search | [Repository search for the exact phrase](https://api.github.com/search/repositories?q=%22Discord%20Coding%20Presence%22%20in%3Aname%2Cdescription%2Creadme) returned `total_count: 0`. | No public repository matched that exact phrase in its name, description, or README at the research date. It is not a global naming or legal search. |

## Materially similar identities

- [`discord-coding-status` on npm](https://registry.npmjs.org/discord-coding-status/latest) is version `1.6.1`, describes itself as a local Discord Rich Presence daemon for Claude Code and Codex, and exposes the `discord-coding-status` executable. It is close in purpose and wording, but does not occupy the selected package or long command name.
- [`agent-discord-presence` on npm](https://registry.npmjs.org/agent-discord-presence/latest) is version `0.0.3`, describes a shared Discord Rich Presence service for several coding agents, and exposes both `adp` and `agent-discord-presence`. It is materially similar in product scope, but its package and executable names differ.

## Limits and follow-up gate

This investigation did **not** search trademarks, domains, social handles, app-store names, private repositories, unindexed packages, shells' existing commands, or projects owned outside the proposed GitHub account. It therefore cannot establish legal clearance, global identity availability, or universal command availability.

Before publishing, re-run the three direct checks above and add a clean-environment global-install/shell command check for `discord-coding-presence`. That validates the released package's executable behavior; it still does not replace trademark review where that is required.
