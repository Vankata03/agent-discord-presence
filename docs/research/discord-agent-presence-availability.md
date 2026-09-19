# Discord Agent Presence identity availability

Research date: 2026-09-19

## Decision summary

Reject **Discord Agent Presence** as the rebrand identity. The exact npm package name `discord-agent-presence` is currently unregistered, and `Vankata03/discord-agent-presence` does not exist. However, a comparable existing product, [`LitoMore/agent-discord-presence`](https://github.com/LitoMore/agent-discord-presence), uses the same meaningful words in a different order and describes itself as Discord Rich Presence for coding agents. That creates a material product-identity and user-confusion risk.

Do not use `dap` as an alias. The npm package [`dap`](https://registry.npmjs.org/dap) currently publishes a `dap` executable. No authoritative global executable-name registry exists, so this proves one npm-distribution collision, not every possible collision.

## Exact package and repository checks

- A direct request to the [npm registry record for `discord-agent-presence`](https://registry.npmjs.org/discord-agent-presence) returned HTTP 404 on 2026-09-19. npm therefore has no package record under that exact name at the time checked.
- The [npm search API](https://registry.npmjs.org/-/v1/search?text=discord-agent-presence&size=250) returned no result whose package name equals `discord-agent-presence` on the same date.
- A direct request to GitHub's [repository API for `Vankata03/discord-agent-presence`](https://api.github.com/repos/Vankata03/discord-agent-presence) returned HTTP 404. The target owner currently has no repository with that exact path.
- GitHub's [public repository-name search for the exact quoted name](https://api.github.com/search/repositories?q=%22discord-agent-presence%22%20in%3Aname&per_page=100) returned `total_count: 0` and `incomplete_results: false`. No public indexed repository used that exact repository name when checked.

These checks establish current exact-name availability only. They do not reserve either name and can change at any time.

## Comparable-project collision

[`LitoMore/agent-discord-presence`](https://github.com/LitoMore/agent-discord-presence) exists. Its [GitHub API record](https://api.github.com/repos/LitoMore/agent-discord-presence) describes it as Discord Rich Presence for multiple coding agents, using one local service. `Discord Agent Presence` is semantically near-identical, despite different word order. The collision is sufficient to reject this candidate before implementation.

## Executable-name check

The [npm registry record for `dap`](https://registry.npmjs.org/dap) exists. Its current `2.1.0` metadata declares `bin: { "dap": "cli.js" }`, so a global npm installation already places a `dap` command on `PATH`. Avoid that alias.

No registry governs all executable names across Bun, npm, operating systems, shells, package managers, or locally installed tools. The longer proposed command `discord-agent-presence` was not globally cleared; it has only the indirect support of the unregistered exact npm package name.

## Not verified

This research does not verify trademark rights, domains, social handles, app-store listings, private GitHub repositories, other owners' repository paths, or global command-name clearance. Obtain legal and brand review before adopting any replacement identity.
