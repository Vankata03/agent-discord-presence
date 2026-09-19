# Coding-work brand availability

Research date: 2026-09-19

## Decision summary

Recommend **BuildSignal** as the strongest current candidate. At the time checked,
`buildsignal` was unregistered in the public npm registry and no
`Vankata03/buildsignal` repository existed. It directly describes coding work,
is pronounceable, and permits a matching `buildsignal` executable when the package
is published.

`worksignal` and `devsignal` have the same verified npm/GitHub availability, but
are less specific or less distinctive. `codepulse` is available in the two checked
namespaces, but is the most generic name and therefore has the highest likely
discoverability/collision risk. `codebeacon` and `codelive` cannot support the
full rebrand because their npm package names are already taken; `codebeacon` also
owns its matching CLI command.

## Evidence

All npm results are direct public-registry requests. GitHub results are direct
GitHub REST repository lookups under the intended owner, `Vankata03`. A 404 means
the exact namespace was unregistered at the time checked; it is not a reservation
and may change immediately.

| Candidate | npm package name | Matching command evidence | `Vankata03` repository | Assessment |
| --- | --- | --- | --- | --- |
| `buildsignal` | [404: unregistered](https://registry.npmjs.org/buildsignal) | Available to define as `buildsignal` with a newly published exact-name package; no global CLI-name registry was found | [404: absent](https://api.github.com/repos/Vankata03/buildsignal) | **Recommend** |
| `worksignal` | [404: unregistered](https://registry.npmjs.org/worksignal) | Same limitation; available to define with the exact-name package | [404: absent](https://api.github.com/repos/Vankata03/worksignal) | Viable alternate |
| `codebeacon` | [Registered, latest `0.8.2`](https://registry.npmjs.org/codebeacon) | Registry metadata declares `codebeacon` → `bin/codebeacon` | [404: absent](https://api.github.com/repos/Vankata03/codebeacon) | Reject: package and command collision |
| `codelive` | [Registered, latest `0.0.1`](https://registry.npmjs.org/codelive) | Its latest metadata declares no `bin`; npm package name remains unavailable | [404: absent](https://api.github.com/repos/Vankata03/codelive) | Reject: package collision |
| `devsignal` | [404: unregistered](https://registry.npmjs.org/devsignal) | Same limitation; available to define with the exact-name package | [404: absent](https://api.github.com/repos/Vankata03/devsignal) | Viable alternate |
| `codepulse` | [404: unregistered](https://registry.npmjs.org/codepulse) | Same limitation; available to define with the exact-name package | [404: absent](https://api.github.com/repos/Vankata03/codepulse) | Viable, but generic |

## Limits and next checks

- npm permits packages to expose arbitrary executable names. The public registry
  exposes a package's `bin` metadata but has no authoritative reverse index for
  every executable name, so an exact-name package being free does not prove that
  no other package has installed the same command. Test the chosen command in a
  clean global Bun installation during implementation.
- This research does not check trademarks, domain names, social handles, package
  names under other npm owners, or repositories outside `Vankata03`. They remain
  unverified collision and discoverability risks, not evidence of clearance.
- No name was reserved, published, or used to rename the repository.
