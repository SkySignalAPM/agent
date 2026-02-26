/**
 * DDPCollector tests — subscription tracking state machine,
 * connection close handling, _sendUpdates, _sendSubscriptionUpdates cleanup,
 * getStats.
 *
 * Does NOT hook into real Meteor sessions — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import DDPCollector from '../../../lib/collectors/DDPCollector.js';

describe('DDPCollector', function () {

  let collector;
  let mockClient;

  beforeEach(function () {
    mockClient = {
      sendDDPConnections: sinon.stub(),
      sendSubscriptions: sinon.stub()
    };
    collector = new DDPCollector({
      client: mockClient,
      appVersion: '1.0.0',
      buildHash: 'abc123',
      interval: 30000,
      debug: false
    });
  });

  afterEach(function () {
    collector.stop();
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      const c = new DDPCollector({});
      expect(c.interval).to.equal(30000);
      expect(c.connections).to.be.instanceOf(Map);
      expect(c.subscriptions).to.be.instanceOf(Map);
      expect(c.intervalId).to.be.null;
      expect(c.debug).to.be.false;
    });

    it('respects custom options', function () {
      expect(collector.appVersion).to.equal('1.0.0');
      expect(collector.buildHash).to.equal('abc123');
    });

    it('has complete message type map', function () {
      expect(collector.messageTypeMap).to.include.keys(
        'connect', 'connected', 'method', 'result',
        'sub', 'unsub', 'nosub', 'ready',
        'added', 'changed', 'removed', 'ping', 'pong'
      );
    });
  });

  // ==========================================
  // _trackSubscriptionMessage
  // ==========================================
  describe('_trackSubscriptionMessage', function () {

    it('tracks "sub" message — creates pending subscription', function () {
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts', params: [{ limit: 10 }] },
        'session1',
        100
      );

      expect(collector.subscriptions.has('sub1')).to.be.true;
      const sub = collector.subscriptions.get('sub1');
      expect(sub.publicationName).to.equal('posts');
      expect(sub.status).to.equal('pending');
      expect(sub.connectionId).to.equal('session1');
      expect(sub.params).to.deep.equal([{ limit: 10 }]);
      expect(sub.dataTransferred).to.equal(100);
      expect(sub.documentsAdded).to.equal(0);
    });

    it('ignores sub with missing id or name', function () {
      collector._trackSubscriptionMessage({ msg: 'sub', id: null, name: 'posts' }, 's1', 50);
      collector._trackSubscriptionMessage({ msg: 'sub', id: 'sub2', name: null }, 's1', 50);
      expect(collector.subscriptions.size).to.equal(0);
    });

    it('tracks "ready" message — marks subscriptions as ready', function () {
      // First create a pending sub
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts' },
        's1', 50
      );

      // Now mark it ready
      collector._trackSubscriptionMessage(
        { msg: 'ready', subs: ['sub1'] },
        's1', 20
      );

      const sub = collector.subscriptions.get('sub1');
      expect(sub.status).to.equal('ready');
      expect(sub.readyAt).to.be.instanceOf(Date);
      expect(sub.responseTime).to.be.a('number');
    });

    it('ready does not change non-pending subscriptions', function () {
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts' },
        's1', 50
      );
      // Set status to something other than pending
      collector.subscriptions.get('sub1').status = 'stopped';

      collector._trackSubscriptionMessage(
        { msg: 'ready', subs: ['sub1'] },
        's1', 20
      );

      expect(collector.subscriptions.get('sub1').status).to.equal('stopped');
    });

    it('tracks "nosub" — marks subscription as error', function () {
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts' },
        's1', 50
      );

      collector._trackSubscriptionMessage(
        { msg: 'nosub', id: 'sub1', error: { error: 404, reason: 'Not found' } },
        's1', 30
      );

      const sub = collector.subscriptions.get('sub1');
      expect(sub.status).to.equal('error');
      expect(sub.stoppedAt).to.be.instanceOf(Date);
      expect(sub.errorMessage).to.equal('404: Not found');
    });

    it('nosub with no error sets unknown message', function () {
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts' },
        's1', 50
      );
      collector._trackSubscriptionMessage(
        { msg: 'nosub', id: 'sub1' },
        's1', 30
      );

      expect(collector.subscriptions.get('sub1').errorMessage).to.equal('Unknown error');
    });

    it('tracks "unsub" — marks subscription as stopped', function () {
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts' },
        's1', 50
      );

      collector._trackSubscriptionMessage(
        { msg: 'unsub', id: 'sub1' },
        's1', 20
      );

      const sub = collector.subscriptions.get('sub1');
      expect(sub.status).to.equal('stopped');
      expect(sub.stoppedAt).to.be.instanceOf(Date);
    });

    it('tracks "added" — increments documentsAdded on ready subscriptions', function () {
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts' },
        's1', 50
      );
      collector._trackSubscriptionMessage(
        { msg: 'ready', subs: ['sub1'] },
        's1', 20
      );

      collector._trackSubscriptionMessage(
        { msg: 'added', collection: 'posts' },
        's1', 80
      );

      const sub = collector.subscriptions.get('sub1');
      expect(sub.documentsAdded).to.equal(1);
      expect(sub.dataTransferred).to.be.greaterThan(50);
    });

    it('tracks "changed" and "removed" on ready subscriptions', function () {
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts' },
        's1', 50
      );
      collector._trackSubscriptionMessage(
        { msg: 'ready', subs: ['sub1'] },
        's1', 20
      );

      collector._trackSubscriptionMessage(
        { msg: 'changed', collection: 'posts' },
        's1', 60
      );
      collector._trackSubscriptionMessage(
        { msg: 'removed', collection: 'posts' },
        's1', 40
      );

      const sub = collector.subscriptions.get('sub1');
      expect(sub.documentsChanged).to.equal(1);
      expect(sub.documentsRemoved).to.equal(1);
    });

    it('does not increment counters on non-ready subscriptions', function () {
      collector._trackSubscriptionMessage(
        { msg: 'sub', id: 'sub1', name: 'posts' },
        's1', 50
      );
      // Still pending

      collector._trackSubscriptionMessage(
        { msg: 'added', collection: 'posts' },
        's1', 80
      );

      expect(collector.subscriptions.get('sub1').documentsAdded).to.equal(0);
    });

    it('handles unknown message types gracefully', function () {
      expect(() => {
        collector._trackSubscriptionMessage(
          { msg: 'unknown_type' },
          's1', 10
        );
      }).to.not.throw();
    });
  });

  // ==========================================
  // _handleConnectionClose
  // ==========================================
  describe('_handleConnectionClose', function () {

    it('marks connection as disconnected and sends update', function () {
      // Create a mock connection
      collector.connections.set('conn1', {
        connectionId: 'conn1',
        clientAddress: '127.0.0.1',
        userId: null,
        userAgent: 'test',
        connectedAt: new Date(),
        disconnectedAt: null,
        status: 'active',
        messagesSent: 5,
        messagesReceived: 3,
        bytesSent: 100,
        bytesReceived: 50,
        messageTypes: {},
        activeSubscriptions: [],
        avgLatency: null,
        lastPingLatency: null,
        reconnectCount: 0,
        httpHeaders: {}
      });

      collector._handleConnectionClose('conn1');

      // Connection should be removed after sending
      expect(collector.connections.has('conn1')).to.be.false;
      expect(mockClient.sendDDPConnections.calledOnce).to.be.true;

      const sent = mockClient.sendDDPConnections.firstCall.args[0];
      expect(sent[0].status).to.equal('disconnected');
      expect(sent[0].disconnectedAt).to.be.instanceOf(Date);
    });

    it('cleans up wrappedSessions tracking', function () {
      collector.wrappedSessions = new Set(['conn1']);
      collector.connections.set('conn1', {
        connectionId: 'conn1',
        status: 'active',
        clientAddress: '127.0.0.1',
        userId: null,
        userAgent: 'test',
        connectedAt: new Date(),
        disconnectedAt: null,
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        messageTypes: {},
        activeSubscriptions: [],
        avgLatency: null,
        lastPingLatency: null,
        reconnectCount: 0,
        httpHeaders: {}
      });

      collector._handleConnectionClose('conn1');
      expect(collector.wrappedSessions.has('conn1')).to.be.false;
    });

    it('ignores unknown connection IDs', function () {
      collector._handleConnectionClose('unknown');
      expect(mockClient.sendDDPConnections.called).to.be.false;
    });
  });

  // ==========================================
  // _sendUpdates
  // ==========================================
  describe('_sendUpdates', function () {

    it('does nothing when no connections', function () {
      collector._sendUpdates();
      expect(mockClient.sendDDPConnections.called).to.be.false;
    });

    it('sends connection data and includes appVersion/buildHash', function () {
      collector.connections.set('conn1', {
        connectionId: 'conn1',
        clientAddress: '127.0.0.1',
        userId: 'user1',
        userAgent: 'Mozilla/5.0',
        connectedAt: new Date(),
        disconnectedAt: null,
        status: 'active',
        messagesSent: 10,
        messagesReceived: 5,
        bytesSent: 200,
        bytesReceived: 100,
        messageTypes: { method: 3, result: 3 },
        activeSubscriptions: ['sub1'],
        avgLatency: 15,
        lastPingLatency: 12,
        reconnectCount: 0,
        httpHeaders: { 'user-agent': 'test' }
      });

      collector._sendUpdates();

      expect(mockClient.sendDDPConnections.calledOnce).to.be.true;
      const conns = mockClient.sendDDPConnections.firstCall.args[0];
      expect(conns).to.have.lengthOf(1);
      expect(conns[0].appVersion).to.equal('1.0.0');
      expect(conns[0].buildHash).to.equal('abc123');
      expect(conns[0].messagesSent).to.equal(10);
    });

    it('also sends subscription updates', function () {
      collector.connections.set('conn1', {
        connectionId: 'conn1',
        clientAddress: '127.0.0.1',
        userId: null,
        userAgent: 'test',
        connectedAt: new Date(),
        disconnectedAt: null,
        status: 'active',
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        messageTypes: {},
        activeSubscriptions: [],
        avgLatency: null,
        lastPingLatency: null,
        reconnectCount: 0,
        httpHeaders: {}
      });
      collector.subscriptions.set('sub1', {
        subscriptionId: 'sub1',
        publicationName: 'posts',
        status: 'ready'
      });

      collector._sendUpdates();

      expect(mockClient.sendSubscriptions.calledOnce).to.be.true;
    });
  });

  // ==========================================
  // _sendSubscriptionUpdates
  // ==========================================
  describe('_sendSubscriptionUpdates', function () {

    it('does nothing when no subscriptions', function () {
      collector._sendSubscriptionUpdates();
      expect(mockClient.sendSubscriptions.called).to.be.false;
    });

    it('sends all subscriptions', function () {
      collector.subscriptions.set('sub1', { subscriptionId: 'sub1', status: 'ready' });
      collector.subscriptions.set('sub2', { subscriptionId: 'sub2', status: 'pending' });

      collector._sendSubscriptionUpdates();

      expect(mockClient.sendSubscriptions.calledOnce).to.be.true;
      expect(mockClient.sendSubscriptions.firstCall.args[0]).to.have.lengthOf(2);
    });

    it('cleans up stopped subscriptions older than 60s', function () {
      const oldTime = new Date(Date.now() - 120000); // 2 minutes ago
      collector.subscriptions.set('sub1', {
        subscriptionId: 'sub1',
        status: 'stopped',
        stoppedAt: oldTime
      });
      collector.subscriptions.set('sub2', {
        subscriptionId: 'sub2',
        status: 'ready',
        stoppedAt: null
      });

      collector._sendSubscriptionUpdates();

      // Old stopped sub should be cleaned up
      expect(collector.subscriptions.has('sub1')).to.be.false;
      // Active sub should remain
      expect(collector.subscriptions.has('sub2')).to.be.true;
    });

    it('cleans up error subscriptions older than 60s', function () {
      const oldTime = new Date(Date.now() - 120000);
      collector.subscriptions.set('sub1', {
        subscriptionId: 'sub1',
        status: 'error',
        stoppedAt: oldTime
      });

      collector._sendSubscriptionUpdates();

      expect(collector.subscriptions.has('sub1')).to.be.false;
    });

    it('keeps recent stopped subscriptions', function () {
      const recentTime = new Date(Date.now() - 10000); // 10s ago
      collector.subscriptions.set('sub1', {
        subscriptionId: 'sub1',
        status: 'stopped',
        stoppedAt: recentTime
      });

      collector._sendSubscriptionUpdates();

      expect(collector.subscriptions.has('sub1')).to.be.true;
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns empty stats when no data', function () {
      const stats = collector.getStats();
      expect(stats.activeConnections).to.equal(0);
      expect(stats.activeSubscriptions).to.equal(0);
      expect(stats.connections).to.be.an('array').that.is.empty;
      expect(stats.subscriptions).to.be.an('array').that.is.empty;
    });

    it('returns connection and subscription summaries', function () {
      collector.connections.set('conn1', {
        connectionId: 'conn1',
        status: 'active',
        messagesSent: 10,
        messagesReceived: 5,
        avgLatency: 20
      });
      collector.subscriptions.set('sub1', {
        subscriptionId: 'sub1',
        publicationName: 'posts',
        status: 'ready',
        documentsAdded: 50,
        documentsChanged: 3,
        documentsRemoved: 1
      });

      const stats = collector.getStats();
      expect(stats.activeConnections).to.equal(1);
      expect(stats.activeSubscriptions).to.equal(1);
      expect(stats.connections[0].connectionId).to.equal('conn1');
      expect(stats.subscriptions[0].publicationName).to.equal('posts');
      expect(stats.subscriptions[0].documentsAdded).to.equal(50);
    });
  });

  // ==========================================
  // stop
  // ==========================================
  describe('stop', function () {

    it('clears all state', function () {
      collector.intervalId = setInterval(() => {}, 100000);
      collector.sessionPollInterval = setInterval(() => {}, 100000);
      collector.wrappedSessions = new Set(['s1']);
      collector.connections.set('c1', {});
      collector.subscriptions.set('s1', {});
      collector._loginHandle = { stop: sinon.stub() };
      collector._logoutHandle = { stop: sinon.stub() };

      collector.stop();

      expect(collector.intervalId).to.be.null;
      expect(collector.sessionPollInterval).to.be.null;
      expect(collector.connections.size).to.equal(0);
      expect(collector.subscriptions.size).to.equal(0);
    });

    it('safe to call when not started', function () {
      expect(() => collector.stop()).to.not.throw();
    });
  });
});
