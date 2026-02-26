/**
 * Factory for mock SkySignalClient that records all calls for assertion.
 */

/**
 * Create a mock client that records method calls.
 *
 * @returns {Object} Mock client with `recorded` property containing arrays of captured data
 */
function createMockClient() {
  const recorded = {
    traces: [],
    logs: [],
    errors: [],
    dnsMetrics: [],
    outboundHttp: [],
    cpuProfiles: [],
    deprecatedApis: [],
    publications: [],
    environment: [],
    vulnerabilities: [],
    ddpConnections: [],
    systemMetrics: [],
    other: []
  };

  return {
    recorded,

    addTrace(data) { recorded.traces.push(data); },
    addLog(data) { recorded.logs.push(data); },
    addError(data) { recorded.errors.push(data); },
    addDnsMetric(data) { recorded.dnsMetrics.push(data); },
    addOutboundHttp(data) { recorded.outboundHttp.push(data); },
    addCpuProfile(data) { recorded.cpuProfiles.push(data); },
    addDeprecatedApi(data) { recorded.deprecatedApis.push(data); },
    addPublication(data) { recorded.publications.push(data); },
    addEnvironment(data) { recorded.environment.push(data); },
    addVulnerability(data) { recorded.vulnerabilities.push(data); },
    addDDPConnection(data) { recorded.ddpConnections.push(data); },
    addSystemMetrics(data) { recorded.systemMetrics.push(data); },

    // Generic
    add(type, data) {
      if (recorded[type]) {
        recorded[type].push(data);
      } else {
        recorded.other.push({ type, data });
      }
    },

    // Reset all recorded data
    reset() {
      for (const key of Object.keys(recorded)) {
        recorded[key] = [];
      }
    }
  };
}

module.exports = { createMockClient };
