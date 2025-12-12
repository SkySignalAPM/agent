# SkySignal Agent

Official APM agent for monitoring Meteor.js applications with [SkySignal](https://skysignal.app).

## Features

- **System Metrics Monitoring** - CPU, memory, disk, and network usage
- **Method Performance Traces** - Track Meteor Method execution with operation-level profiling
- **Publication Monitoring** - Monitor publication performance and subscriptions
- **Error Tracking** - Automatic error capture with client context
- **HTTP Request Monitoring** - Track outgoing HTTP requests
- **Database Query Monitoring** - MongoDB query performance tracking
- **Real User Monitoring (RUM)** - Browser-side Core Web Vitals (LCP, FID, CLS, TTFB, FCP, TTI) with automatic performance warnings
- **SPA Route Tracking** - Automatic performance collection on every route change
- **Session Tracking** - 30-minute user sessions with localStorage persistence
- **Browser Context** - Automatic device, browser, OS, and network information collection
- **Batch Processing** - Efficient batching and async delivery to minimize performance impact

## Installation

Add the package to your Meteor application:

```bash
meteor add skysignal:agent
```

## Quick Start

### 1. Get Your API Key

Sign up at [SkySignal](https://skysignal.app) and create a new site to get your API key.

### 2. Configure the Agent

In your Meteor server startup code (e.g., `server/main.js`):

```javascript
import { Meteor } from 'meteor/meteor';
import { SkySignalAgent } from 'meteor/skysignal:agent';

Meteor.startup(() => {
  // Configure the agent
  SkySignalAgent.configure({
    apiKey: process.env.SKYSIGNAL_API_KEY || 'your-api-key-here',
    enabled: true,
    host: 'my-app-server-1', // Optional: defaults to hostname
    appVersion: '1.2.3', // Optional: auto-detected from package.json

    // Optional: Customize collection intervals
    systemMetricsInterval: 60000, // 1 minute (default)
    flushInterval: 10000, // 10 seconds (default)
    batchSize: 50, // Max items per batch (default)

    // Optional: Sampling for high-traffic apps
    traceSampleRate: 1.0, // 100% of traces (reduce for high volume)

    // Optional: Feature toggles
    collectTraces: true,
    collectMongoPool: true,
    collectDDPConnections: true,
    collectJobs: true
  });

  // Start monitoring
  SkySignalAgent.start();
});
```

### 3. Add to Settings File

For production, use Meteor settings. The agent **auto-initializes** from settings if configured:

**settings-production.json:**
```json
{
  "skysignal": {
    "apiKey": "sk_your_api_key_here",
    "enabled": true,
    "host": "production-server-1",
    "appVersion": "1.2.3",
    "traceSampleRate": 0.5,
    "collectTraces": true,
    "collectMongoPool": true,
    "collectDDPConnections": true,
    "collectJobs": true,
    "captureIndexUsage": true,
    "indexUsageSampleRate": 0.05
  },
  "public": {
    "skysignal": {
      "publicKey": "pk_your_public_key_here",
      "rum": {
        "enabled": true,
        "sampleRate": 0.5
      }
    }
  }
}
```

The agent auto-starts when it finds valid configuration in `Meteor.settings.skysignal`.

**Manual initialization (optional):**
```javascript
import { SkySignalAgent } from 'meteor/skysignal:agent';

Meteor.startup(() => {
  // Only needed if not using settings auto-initialization
  const config = Meteor.settings.skysignal;

  if (config && config.apiKey) {
    SkySignalAgent.configure(config);
    SkySignalAgent.start();
  } else {
    console.warn('⚠️ SkySignal not configured - monitoring disabled');
  }
});
```

## Configuration Options

### API Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | String | *required* | Your SkySignal API key (sk_ prefix) |
| `endpoint` | String | `https://dash.skysignal.app` | SkySignal API endpoint |
| `enabled` | Boolean | `true` | Enable/disable the agent |

### Host & Version Identification

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | String | `os.hostname()` | Host identifier for this instance |
| `appVersion` | String | Auto-detect | App version from package.json or manually configured |
| `buildHash` | String | Auto-detect | Build hash for source map lookup. Auto-detects from `BUILD_HASH` or `GIT_SHA` environment variables |

### Batching Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `batchSize` | Number | `50` | Max items per batch before auto-flush |
| `batchSizeBytes` | Number | `262144` | Max bytes (256KB) per batch |
| `flushInterval` | Number | `10000` | Interval (ms) to flush batched data |

### Sampling Rates

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `traceSampleRate` | Number | `1.0` | Server trace sample rate (0-1). Set to 0.1 for 10% |
| `rumSampleRate` | Number | `0.5` | RUM sample rate (0-1). 50% by default for high-volume |

### Collection Intervals

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `systemMetricsInterval` | Number | `60000` | System metrics collection interval (1 minute) |
| `mongoPoolInterval` | Number | `60000` | MongoDB pool metrics interval (1 minute) |
| `collectionStatsInterval` | Number | `300000` | Collection stats interval (5 minutes) |
| `ddpConnectionsInterval` | Number | `30000` | DDP connection updates interval (30 seconds) |
| `jobsInterval` | Number | `30000` | Background job stats interval (30 seconds) |

### Feature Flags

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `collectSystemMetrics` | Boolean | `true` | Collect system metrics (CPU, memory, disk, network) |
| `collectTraces` | Boolean | `true` | Collect method/publication traces |
| `collectErrors` | Boolean | `true` | Collect errors and exceptions |
| `collectHttpRequests` | Boolean | `true` | Collect HTTP request metrics |
| `collectMongoPool` | Boolean | `true` | Collect MongoDB connection pool metrics |
| `collectCollectionStats` | Boolean | `true` | Collect MongoDB collection statistics |
| `collectDDPConnections` | Boolean | `true` | Collect DDP/WebSocket connection metrics |
| `collectLiveQueries` | Boolean | `true` | Collect Meteor live query (oplog/polling) metrics |
| `collectJobs` | Boolean | `true` | Collect background job metrics |
| `collectRUM` | Boolean | `false` | Client-side RUM (disabled by default, requires publicKey) |

### MongoDB Pool Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mongoPoolFixedConnectionMemory` | Number | `null` | Optional: fixed bytes per connection for memory estimation |

### Method Tracing Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `traceMethodArguments` | Boolean | `true` | Capture method arguments (sanitized) |
| `maxArgLength` | Number | `1000` | Max string length for arguments |
| `traceMethodOperations` | Boolean | `true` | Capture detailed operation timeline |

### Index Usage Tracking

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `captureIndexUsage` | Boolean | `true` | Capture MongoDB index usage via explain() |
| `indexUsageSampleRate` | Number | `0.05` | Sample 5% of queries for explain() |
| `explainVerbosity` | String | `executionStats` | `queryPlanner` \| `executionStats` \| `allPlansExecution` |
| `explainSlowQueriesOnly` | Boolean | `false` | Only explain queries exceeding slow threshold |

### Performance Safeguards

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxBatchRetries` | Number | `3` | Max retries for failed batches |
| `requestTimeout` | Number | `3000` | API request timeout (3 seconds) |
| `maxMemoryMB` | Number | `50` | Max memory (MB) for batches |

### Worker Offload (Large Pools)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `useWorkerThread` | Boolean | `false` | Enable worker thread for large pools |
| `workerThreshold` | Number | `50` | Spawn worker if pool size exceeds this |

### Background Job Monitoring

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `collectJobs` | Boolean | `true` | Enable background job monitoring |
| `jobsInterval` | Number | `30000` | Job stats collection interval (30 seconds) |
| `jobsPackage` | String | `null` | Auto-detect, or specify: `"msavin:sjobs"` |

## What Gets Monitored

### System Metrics (Automatic)

The agent automatically collects:
- **CPU Usage** - Overall CPU utilization percentage
- **CPU Cores** - Number of CPU cores available
- **Load Average** - 1m, 5m, 15m load averages
- **Memory Usage** - Total, used, free, and percentage
- **Disk Usage** - Disk space utilization (platform-dependent)
- **Network Traffic** - Bytes in/out (platform-dependent)
- **Process Count** - Number of running processes (platform-dependent)

Collected every 60 seconds by default.

### Method Traces

Automatic instrumentation of Meteor Methods:
- Method name and execution time
- Operation-level breakdown (DB queries, async operations, compute time)
- Detailed MongoDB operation tracking with explain() support
- N+1 query detection and slow query analysis
- `this.unblock()` analysis with optimization recommendations
- Wait time tracking (DDP queue, connection pool)
- Error tracking with stack traces
- User context and session correlation

### Publication Monitoring

Track publication performance:
- Publication name and execution time
- Subscription lifecycle tracking
- Document counts (added, changed, removed)
- Data transfer size estimation
- Live query efficiency (oplog vs polling)

### DDP Connection Monitoring

Real-time WebSocket connection tracking:
- Active connection count and status
- Message volume (sent/received) by type
- Bandwidth usage per connection
- Latency measurements (ping/pong)
- Subscription tracking per connection

### MongoDB Pool Monitoring

Connection pool health and performance:
- Pool configuration (min/max size, timeouts)
- Active vs available connections
- Checkout wait times (avg, max, P95)
- Queue length and timeout tracking
- Memory usage estimation

### Live Query Monitoring

Meteor reactive query tracking:
- Observer count by collection
- Oplog vs polling efficiency
- Document update rates
- Performance ratings (optimal/good/slow)
- Query signature deduplication

### Background Job Monitoring

Track `msavin:sjobs` (Steve Jobs) and other job packages:
- Job execution times and status
- Queue length and worker utilization
- Failed job tracking with error details
- Job type categorization

### Error Tracking

Automatic error capture:
- Server-side errors with stack traces
- Client-side errors with browser context
- Error grouping and fingerprinting
- Affected users and methods
- Build hash correlation for source maps

### Real User Monitoring (RUM) - Client-Side

**Automatic browser-side performance monitoring** collecting Core Web Vitals and providing PageSpeed-style performance warnings.

#### What Gets Collected

**Core Web Vitals:**
- **LCP** (Largest Contentful Paint) - Measures loading performance
  - Good: <2.5s | Needs Improvement: 2.5-4s | Poor: >4s
- **FID** (First Input Delay) - Measures interactivity
  - Good: <100ms | Needs Improvement: 100-300ms | Poor: >300ms
- **CLS** (Cumulative Layout Shift) - Measures visual stability
  - Good: <0.1 | Needs Improvement: 0.1-0.25 | Poor: >0.25
- **TTFB** (Time to First Byte) - Measures server response time
  - Good: <800ms | Needs Improvement: 800-1800ms | Poor: >1800ms
- **FCP** (First Contentful Paint) - Measures perceived load speed
  - Good: <1.8s | Needs Improvement: 1.8-3s | Poor: >3s
- **TTI** (Time to Interactive) - Measures time until page is fully interactive
  - Good: <3.8s | Needs Improvement: 3.8-7.3s | Poor: >7.3s

**Additional Context:**
- Browser name and version
- Device type (mobile, tablet, desktop)
- Operating system
- Network connection type, downlink speed, RTT
- Viewport and screen dimensions
- User ID (via Meteor.userId() for correlation with server-side traces)
- Session ID (30-minute sessions with localStorage persistence)
- Page route and referrer
- Top 10 slowest resources

#### Configuration

RUM monitoring **auto-initializes** from your Meteor settings.

**settings-development.json:**
```json
{
  "skysignal": {
    "apiKey": "sk_your_server_api_key_here",
    "endpoint": "http://localhost:3000"
  },
  "public": {
    "skysignal": {
      "publicKey": "pk_your_public_key_here",
      "endpoint": "http://localhost:3000",
      "rum": {
        "enabled": true,
        "sampleRate": 1.0,
        "debug": false
      }
    }
  }
}
```

**Configuration Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `publicKey` | String | *required* | SkySignal Public Key (pk_ prefix) - Safe for client-side use |
| `endpoint` | String | (same origin) | Base URL of SkySignal API (e.g., `http://localhost:3000` or `https://dash.skysignal.app`) |
| `rum.enabled` | Boolean | `true` | Enable/disable RUM collection |
| `rum.sampleRate` | Number | Auto | Sample rate (0-1). Auto: 100% for localhost, 50% for production |
| `rum.debug` | Boolean | `false` | Enable console logging for debugging |

**Key Security Note:**
- **API Key (sk_ prefix)**: Server-side only, keep in private `settings.skysignal`. Used for server-to-server communication.
- **Public Key (pk_ prefix)**: Client-side safe, can be in `settings.public.skysignal`. Used for browser RUM collection.
- This follows the Stripe pattern of separating public/private keys for security.

The agent **automatically**:
- Collects Core Web Vitals using Google's `web-vitals` library
- Tracks SPA route changes and collects metrics for each route
- Batches measurements and sends via fire-and-forget HTTP with `keepalive: true`
- Provides PageSpeed-style console warnings for poor performance
- Correlates metrics with server-side traces via Meteor.userId()

#### SPA Route Change Tracking

The RUM client automatically detects route changes in single-page applications by:
- Overriding `history.pushState` and `history.replaceState`
- Listening for `popstate` events (browser back/forward)
- Listening for `hashchange` events (hash-based routing)

Each route change triggers a new performance collection, allowing you to track performance across your entire application navigation flow.

#### Performance Warnings

When Core Web Vitals exceed recommended thresholds, the RUM collector logs PageSpeed-style warnings to the console:

```
[SkySignal RUM] Largest Contentful Paint (LCP) is slow: 4200ms. LCP should be under 2.5s for good user experience. Consider optimizing images, removing render-blocking resources, and improving server response times.
```

These warnings help developers identify performance issues during development and testing.

#### Manual Usage (Advanced)

While RUM auto-initializes, you can also use it manually:

```javascript
import { SkySignalRUM } from 'meteor/skysignal:agent';

// Check if initialized
if (SkySignalRUM.isInitialized()) {
  // Get current session ID
  const sessionId = SkySignalRUM.getSessionId();

  // Get current metrics (for debugging)
  const metrics = SkySignalRUM.getMetrics();

  // Get performance warnings (for debugging)
  const warnings = SkySignalRUM.getWarnings();

  // Manually track a page view (for custom routing)
  SkySignalRUM.trackPageView('/custom-route');
}
```

#### How It Works

1. **Session Management** - Creates a 30-minute session in localStorage, renews on user activity
2. **Core Web Vitals Collection** - Uses Google's `web-vitals` library for accurate measurements
3. **Browser Context Collection** - Detects browser, device, OS, network info from user agent and Navigator API
4. **Performance Warnings** - Compares metrics against PageSpeed thresholds and logs warnings
5. **Batching** - Batches measurements (default: 10 per batch, 5-second flush interval)
6. **HTTP Transmission** - Sends to `/api/v1/rum` endpoint with `keepalive: true` for reliability
7. **SPA Detection** - Automatically resets and re-collects metrics on route changes

## Advanced Usage

### Manual Metric Collection

Send custom metrics to SkySignal:

```javascript
import { SkySignalAgent } from 'meteor/skysignal:agent';

// Send a custom metric
SkySignalAgent.client.addCustomMetric({
  timestamp: new Date(),
  metricName: 'checkout_completed',
  metricValue: 1,
  unit: 'count',
  tags: {
    product: 'premium',
    region: 'us-east-1'
  }
});
```

### Manual Trace Submission

Track custom operations:

```javascript
const startTime = Date.now();

// Your code here...

SkySignalAgent.client.addTrace({
  traceType: 'method',
  methodName: 'myCustomOperation',
  timestamp: new Date(startTime),
  duration: Date.now() - startTime,
  userId: this.userId,
  operations: [
    { type: 'start', time: 0, details: {} },
    { type: 'db', time: 50, details: { collection: 'users', func: 'findOne' } },
    { type: 'complete', time: 150, details: {} }
  ]
});
```

### Stopping the Agent

To gracefully stop the agent (e.g., during shutdown):

```javascript
SkySignalAgent.stop();
```

This will:
1. Stop all collectors
2. Flush any remaining batched data
3. Clear all intervals

## Performance Impact

The agent is designed to have minimal performance impact:

- **Batching** - Data is batched and sent asynchronously
- **Non-blocking** - HTTP requests use `Meteor.defer()` to avoid blocking
- **Configurable Intervals** - Adjust collection frequency based on your needs
- **Automatic Retries** - Failed requests are re-queued automatically

Typical overhead:
- **CPU**: < 1% additional usage
- **Memory**: ~10-20MB for batching
- **Network**: ~1KB per metric, sent in batches

## Troubleshooting

### Agent Not Sending Data

1. Check that your API key is correct
2. Verify `enabled: true` in configuration
3. Check server logs for error messages
4. Verify network connectivity to SkySignal API

### High Memory Usage

If you notice high memory usage:

1. Reduce `batchSize` to flush data more frequently
2. Reduce collection intervals
3. Disable collectors you don't need

### Missing System Metrics

Some system metrics (disk, network, process count) require platform-specific APIs:
- Use the `systeminformation` npm package for comprehensive cross-platform metrics
- These metrics may return `null` on certain platforms

## API Reference

### SkySignalAgent

Main agent singleton instance.

#### Methods

- `configure(options)` - Configure the agent with options
- `start()` - Start all collectors and monitoring
- `stop()` - Stop all collectors and flush data

#### Properties

- `client` - HTTP client instance for manual data submission
- `config` - Current configuration object
- `collectors` - Active collector instances

## Support

- **Issues**: [https://github.com/skysignalapm/agent/issues](https://github.com/skysignalapm/agent/issues)

## Changelog

### v1.0.3 (Bug Fixes)
- Polyfill for `AbortSignal.timeout()` to support older Node.js versions

### v1.0.2 (Bug Fixes)
- Updated Meteor version compatibility to 2.16

### v1.0.1 (Bug Fixes)
- Fixed incorrect default endpoint URL

### v1.0.0 (Initial Release)

- **Complete Method Tracing** - Automatic instrumentation with operation-level profiling
- **MongoDB Query Analysis** - explain() support, N+1 detection, slow query analysis
- **`this.unblock()` Analysis** - Optimization recommendations for blocking methods
- **DDP Connection Monitoring** - Real-time WebSocket tracking with latency metrics
- **MongoDB Pool Monitoring** - Connection pool health, checkout times, queue tracking
- **Live Query Monitoring** - Oplog vs polling efficiency tracking
- **Background Job Monitoring** - Support for msavin:sjobs with extensible adapter system
- **HTTP Request Monitoring** - Automatic tracking of server HTTP requests
- **Collection Stats** - MongoDB collection size and index statistics
- **App Version Tracking** - Auto-detection from package.json with manual override
- **Build Hash Tracking** - Source map correlation via BUILD_HASH/GIT_SHA env vars
- **Performance Safeguards** - Memory limits, request timeouts, batch retries
- **Real User Monitoring (RUM)** - Client-side Core Web Vitals collection (LCP, FID, CLS, TTFB, FCP, TTI)
- **PageSpeed-Style Warnings** - Automatic performance threshold warnings in console
- **SPA Route Tracking** - Automatic performance collection on every route change
- **Session Management** - 30-minute sessions with localStorage persistence
- **Browser Context Collection** - Automatic device, browser, OS, network information
- **User Correlation** - Uses Meteor.userId() to correlate with server-side traces
- **Fire-and-Forget HTTP** - Reliable transmission with keepalive during page unload
- **Configurable Sampling** - Auto-detects environment (100% dev, 50% prod) or manual configuration
- **web-vitals Integration** - Uses Google's official Core Web Vitals library
- System metrics monitoring (CPU, memory, load average)
- HTTP client with batching and auto-flush
- Configurable collection intervals
- Basic error handling and retry logic
- Multi-tenant ready architecture
