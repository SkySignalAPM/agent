Package.describe({
  name: "skysignal:agent",
  version: "1.0.6",
  summary:
    "SkySignal APM agent for Meteor applications - monitors performance, errors, and system metrics",
  git: "https://github.com/skysignalapm/agent.git",
  documentation: "README.md",
});

Package.onUse(function (api) {
  // Requires Meteor 3.x (Node 20+)
  api.versionsFrom("3.0");

  // Core dependencies - versions will be resolved based on the host app's Meteor version
  api.use(["ecmascript", "fetch", "check", "mongo", "tracker", "ddp", "accounts-base"]);

  // Server-side entry point
  api.mainModule("skysignal-agent.js", "server");
  api.export("SkySignalAgent", "server");

  // Client-side RUM and Error Tracking entry point
  api.mainModule("client/rum-client.js", "client");
  api.export("SkySignalRUM", "client");
  api.export("SkySignalErrorTracker", "client");
});

// NPM dependencies
Npm.depends({
  "web-vitals": "4.2.4",
  "html2canvas": "1.4.1"
});
