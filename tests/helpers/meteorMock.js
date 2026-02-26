/**
 * Mock for Meteor core packages: meteor, mongo, check, ddp, accounts-base, tracker.
 *
 * Provides stubs that satisfy import requirements without a real Meteor runtime.
 */

// --- Meteor ---
const Meteor = {
  isServer: true,
  isClient: false,
  isDevelopment: true,
  isProduction: false,

  settings: {
    skysignal: {},
    public: { skysignal: {} }
  },

  server: {
    sessions: new Map()
  },

  // Store registered method definitions for test inspection
  _methodDefs: {},
  methods(defs) {
    Object.assign(Meteor._methodDefs, defs);
  },

  callAsync: async function (name, ...args) {
    const fn = Meteor._methodDefs[name];
    if (!fn) throw new Error(`Method '${name}' not found`);
    return fn.apply({}, args);
  },

  startup(cb) {
    // Execute immediately in tests
    cb();
  },

  defer(cb) {
    setImmediate(cb);
  },

  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,

  // Stubs for accounts
  userId() { return null; },
  user() { return null; }
};

// --- Mongo ---
class CollectionMock {
  constructor(name) {
    this._name = name;
    this._docs = [];
  }

  find(selector, options) {
    return {
      fetch() { return []; },
      fetchAsync() { return Promise.resolve([]); },
      count() { return 0; },
      countAsync() { return Promise.resolve(0); },
      forEach(cb) {},
      map(cb) { return []; },
      observe(cbs) { return { stop() {} }; },
      observeChanges(cbs) { return { stop() {} }; }
    };
  }

  findOne() { return undefined; }
  findOneAsync() { return Promise.resolve(undefined); }
  insert(doc) { return 'mock-id'; }
  insertAsync(doc) { return Promise.resolve('mock-id'); }
  update() { return 0; }
  updateAsync() { return Promise.resolve(0); }
  remove() { return 0; }
  removeAsync() { return Promise.resolve(0); }

  createIndex() {}
  createIndexAsync() { return Promise.resolve(); }

  rawCollection() {
    return {
      aggregate(pipeline) {
        return { toArray() { return Promise.resolve([]); } };
      }
    };
  }
}

const Mongo = {
  Collection: CollectionMock
};

// --- MongoInternals (for MongoPoolCollector) ---
const MongoInternals = {
  defaultRemoteCollectionDriver() {
    return {
      mongo: {
        client: {
          on() {},
          removeListener() {}
        }
      }
    };
  }
};

// --- fetch (for SkySignalClient) ---
function fetch(url, options) {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: async () => ({}),
    text: async () => ''
  });
}

// --- check / Match ---
function check(value, pattern) {
  // Minimal type checking for config validation tests
  if (pattern === String && typeof value !== 'string') {
    throw new Match.Error(`Expected string, got ${typeof value}`);
  }
  if (pattern === Number && typeof value !== 'number') {
    throw new Match.Error(`Expected number, got ${typeof value}`);
  }
  if (pattern === Boolean && typeof value !== 'boolean') {
    throw new Match.Error(`Expected boolean, got ${typeof value}`);
  }

  // Handle object patterns (for validateConfig)
  if (pattern && typeof pattern === 'object' && !Array.isArray(pattern) && !(pattern instanceof Function)) {
    if (typeof value !== 'object' || value === null) {
      throw new Match.Error('Expected object');
    }
    for (const key of Object.keys(pattern)) {
      const patternVal = pattern[key];

      // Match.Optional — skip if key missing or undefined
      if (patternVal && patternVal._isOptional) {
        if (value[key] === undefined) continue;
        // Validate the inner type if present
        // (simplified: skip deep validation for unit tests)
        continue;
      }

      // Required field
      if (value[key] === undefined) {
        throw new Match.Error(`Missing key '${key}'`);
      }
    }
  }
}

const Match = {
  Error: class MatchError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'Match.Error';
    }
  },
  Optional(type) {
    return { _isOptional: true, _type: type };
  },
  OneOf(...types) {
    return { _isOneOf: true, _types: types };
  },
  Integer: { _isInteger: true },
  Where(fn) {
    return { _isWhere: true, _fn: fn };
  }
};

// --- DDP ---
const DDP = {
  _CurrentMethodInvocation: {
    get() { return null; },
    getOrNullIfOutsideFiber() { return null; }
  },
  _CurrentPublicationInvocation: {
    get() { return null; }
  }
};

// --- Tracker ---
const Tracker = {
  autorun(fn) { fn({ stop() {} }); return { stop() {} }; },
  nonreactive(fn) { return fn(); },
  Dependency: class {
    depend() {}
    changed() {}
  }
};

// --- WebApp (for HTTPCollector) ---
const WebApp = {
  handlers: {
    use() {},
    stack: []
  }
};

// --- Accounts ---
const Accounts = {
  onLogin(cb) {
    return { stop() {} };
  },
  onLogout(cb) {
    return { stop() {} };
  }
};

// --- Random ---
let _randomCounter = 0;
const Random = {
  id() {
    return 'random_' + (++_randomCounter);
  }
};

// Export everything
module.exports = {
  Meteor,
  Mongo,
  MongoInternals,
  check,
  Match,
  DDP,
  Tracker,
  Accounts,
  Random,
  WebApp,
  fetch
};
