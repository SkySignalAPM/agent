# Agent Version Control

When releasing a new version of the `skysignal:agent` package, **all three** of the following locations must be updated in sync.

## Locations to Update

### 1. `package.js` (Meteor package manifest)

```
File: packages/skysignal-agent/package.js
Line: version: "X.Y.Z",
```

This is the version Meteor uses when resolving the package. It must follow semver.

### 2. `AGENT_VERSION` constant (runtime reporting)

```
File: packages/skysignal-agent/lib/collectors/SystemMetricsCollector.js
Line: const AGENT_VERSION = 'X.Y.Z';
```

This constant is sent with every system metrics payload so the SkySignal platform knows which agent version a monitored app is running.

### 3. `LATEST_AGENT_VERSION` constant (platform-side)

```
File: skysignal/imports/api/services/VersionService.js
Line: const LATEST_AGENT_VERSION = "X.Y.Z";
```

The SkySignal platform compares each site's reported `agentVersion` against this value to detect outdated agents and show upgrade prompts.

## Release Checklist

1. Update all three locations above to the same new version string.
2. Test the agent locally against a Meteor app to verify metrics report the new version.
3. Publish the Meteor package (`meteor publish`).
4. Deploy the SkySignal platform so `LATEST_AGENT_VERSION` matches the published agent.

## Versioning Strategy

Follow [semver](https://semver.org/):

- **Patch** (1.0.X) - Bug fixes, minor improvements, no API changes
- **Minor** (1.X.0) - New collectors, new config options, backwards-compatible additions
- **Major** (X.0.0) - Breaking changes to config format, removed collectors, or data schema changes
