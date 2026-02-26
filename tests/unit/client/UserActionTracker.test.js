/**
 * UserActionTracker tests — rage click detection, element info extraction,
 * CSS selector generation, form element detection, action limits,
 * dead click marking, getStats, reset.
 *
 * Tests internal logic with browser mocks. Constructor with enabled=false
 * skips _setupListeners to avoid DOM event binding.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import UserActionTracker from '../../../client/UserActionTracker.js';

describe('UserActionTracker', function () {

  let tracker;

  beforeEach(function () {
    // Create with enabled=false to skip DOM listener setup
    tracker = new UserActionTracker({ enabled: false });
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default config', function () {
      const t = new UserActionTracker({ enabled: false });
      expect(t.config.maxActions).to.equal(50);
      expect(t.config.rageClickThreshold).to.equal(3);
      expect(t.config.deadClickDelay).to.equal(2000);
      expect(t.config.enabled).to.be.false;
    });

    it('respects custom config', function () {
      const t = new UserActionTracker({
        enabled: false,
        maxActions: 20,
        rageClickThreshold: 5,
        deadClickDelay: 3000
      });
      expect(t.config.maxActions).to.equal(20);
      expect(t.config.rageClickThreshold).to.equal(5);
      expect(t.config.deadClickDelay).to.equal(3000);
    });

    it('initializes empty state', function () {
      expect(tracker.actions).to.be.an('array').that.is.empty;
      expect(tracker.lastClickTime).to.equal(0);
      expect(tracker.lastClickElement).to.be.null;
      expect(tracker.clickCount).to.equal(0);
      expect(tracker.pendingDeadClicks).to.be.instanceOf(Map);
    });
  });

  // ==========================================
  // _detectRageClick
  // ==========================================
  describe('_detectRageClick', function () {

    it('returns false on first click', function () {
      const elem = {};
      expect(tracker._detectRageClick(elem, Date.now())).to.be.false;
    });

    it('returns false for different elements', function () {
      const elem1 = {};
      const elem2 = {};
      const now = Date.now();

      tracker._detectRageClick(elem1, now);
      expect(tracker._detectRageClick(elem2, now + 100)).to.be.false;
    });

    it('returns false when clicks are too far apart', function () {
      const elem = {};
      tracker._detectRageClick(elem, 1000);
      tracker._detectRageClick(elem, 1500);
      // More than 1s gap
      expect(tracker._detectRageClick(elem, 3000)).to.be.false;
    });

    it('detects rage click after threshold rapid clicks', function () {
      tracker.config.rageClickThreshold = 3;
      const elem = {};
      const now = Date.now();

      tracker._detectRageClick(elem, now);       // click 1
      tracker._detectRageClick(elem, now + 100);  // click 2
      const result = tracker._detectRageClick(elem, now + 200); // click 3 = rage!
      expect(result).to.be.true;
    });

    it('resets count after detecting rage click', function () {
      tracker.config.rageClickThreshold = 3;
      const elem = {};
      const now = Date.now();

      tracker._detectRageClick(elem, now);
      tracker._detectRageClick(elem, now + 100);
      tracker._detectRageClick(elem, now + 200); // Detected, count resets

      // Next click should not be rage
      expect(tracker._detectRageClick(elem, now + 300)).to.be.false;
    });
  });

  // ==========================================
  // _getElementInfo
  // ==========================================
  describe('_getElementInfo', function () {

    it('extracts tag, id, class, text, selector', function () {
      const elem = {
        tagName: 'BUTTON',
        id: 'submit-btn',
        className: 'btn primary',
        textContent: 'Submit Form'
      };

      const info = tracker._getElementInfo(elem);
      expect(info.tagName).to.equal('button');
      expect(info.id).to.equal('submit-btn');
      expect(info.className).to.equal('btn primary');
      expect(info.text).to.equal('Submit Form');
      expect(info.selector).to.equal('#submit-btn');
    });

    it('handles elements with no id or class', function () {
      const elem = { tagName: 'DIV', textContent: 'Hello' };
      const info = tracker._getElementInfo(elem);
      expect(info.tagName).to.equal('div');
      expect(info.id).to.be.undefined;
      expect(info.className).to.be.undefined;
      expect(info.selector).to.equal('div');
    });
  });

  // ==========================================
  // _getElementText
  // ==========================================
  describe('_getElementText', function () {

    it('returns textContent trimmed to 50 chars', function () {
      const elem = { textContent: '  Hello World  ' };
      expect(tracker._getElementText(elem)).to.equal('Hello World');
    });

    it('truncates at 50 characters', function () {
      const longText = 'A'.repeat(100);
      const elem = { textContent: longText };
      expect(tracker._getElementText(elem).length).to.equal(50);
    });

    it('falls back to value', function () {
      const elem = { value: 'input value' };
      expect(tracker._getElementText(elem)).to.equal('input value');
    });

    it('returns empty string for no text', function () {
      const elem = {};
      expect(tracker._getElementText(elem)).to.equal('');
    });
  });

  // ==========================================
  // _getElementSelector
  // ==========================================
  describe('_getElementSelector', function () {

    it('returns #id when id is present', function () {
      const elem = { id: 'my-btn', tagName: 'BUTTON', className: 'btn' };
      expect(tracker._getElementSelector(elem)).to.equal('#my-btn');
    });

    it('returns tag.class1.class2 when no id', function () {
      const elem = { tagName: 'DIV', className: 'container main extra' };
      // Only first 2 classes
      expect(tracker._getElementSelector(elem)).to.equal('div.container.main');
    });

    it('returns just tag when no id or class', function () {
      const elem = { tagName: 'SPAN' };
      expect(tracker._getElementSelector(elem)).to.equal('span');
    });

    it('returns unknown for empty element', function () {
      const elem = {};
      expect(tracker._getElementSelector(elem)).to.equal('unknown');
    });

    it('handles className that is not a string (SVG elements)', function () {
      const elem = { tagName: 'svg', className: { baseVal: 'icon' } };
      // className is not a string, so no classes appended
      expect(tracker._getElementSelector(elem)).to.equal('svg');
    });
  });

  // ==========================================
  // _isFormElement
  // ==========================================
  describe('_isFormElement', function () {

    it('returns true for input', function () {
      expect(tracker._isFormElement({ tagName: 'INPUT' })).to.be.true;
    });

    it('returns true for textarea', function () {
      expect(tracker._isFormElement({ tagName: 'TEXTAREA' })).to.be.true;
    });

    it('returns true for select', function () {
      expect(tracker._isFormElement({ tagName: 'SELECT' })).to.be.true;
    });

    it('returns false for div', function () {
      expect(tracker._isFormElement({ tagName: 'DIV' })).to.be.false;
    });

    it('returns false for missing tagName', function () {
      expect(tracker._isFormElement({})).to.be.false;
    });
  });

  // ==========================================
  // _shouldTrack
  // ==========================================
  describe('_shouldTrack', function () {

    it('returns false when disabled', function () {
      expect(tracker._shouldTrack()).to.be.false;
    });

    it('returns true when enabled and under limit', function () {
      tracker.config.enabled = true;
      expect(tracker._shouldTrack()).to.be.true;
    });

    it('returns false when at maxActions', function () {
      tracker.config.enabled = true;
      tracker.config.maxActions = 3;
      tracker.actions = [{}, {}, {}]; // At limit
      expect(tracker._shouldTrack()).to.be.false;
    });
  });

  // ==========================================
  // _addAction
  // ==========================================
  describe('_addAction', function () {

    it('adds action to array', function () {
      const action = { type: 'click', timestamp: new Date() };
      tracker._addAction(action);
      expect(tracker.actions).to.have.lengthOf(1);
      expect(tracker.actions[0]).to.equal(action);
    });
  });

  // ==========================================
  // _markDeadClick
  // ==========================================
  describe('_markDeadClick', function () {

    it('marks matching action as dead click', function () {
      tracker.actions.push({ type: 'click', deadClickId: 'dc1' });
      tracker.actions.push({ type: 'click', deadClickId: 'dc2' });

      tracker._markDeadClick('dc1');

      expect(tracker.actions[0].isDeadClick).to.be.true;
      expect(tracker.actions[1].isDeadClick).to.be.undefined;
    });

    it('does nothing if no matching action', function () {
      tracker.actions.push({ type: 'click', deadClickId: 'dc1' });
      tracker._markDeadClick('dc999');
      expect(tracker.actions[0].isDeadClick).to.be.undefined;
    });
  });

  // ==========================================
  // _handleDOMChange
  // ==========================================
  describe('_handleDOMChange', function () {

    it('marks all pending dead clicks as detected', function () {
      tracker.pendingDeadClicks.set('dc1', { detected: false });
      tracker.pendingDeadClicks.set('dc2', { detected: false });

      tracker._handleDOMChange();

      expect(tracker.pendingDeadClicks.get('dc1').detected).to.be.true;
      expect(tracker.pendingDeadClicks.get('dc2').detected).to.be.true;
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns empty stats', function () {
      const stats = tracker.getStats();
      expect(stats.totalActions).to.equal(0);
      expect(stats.clicks).to.equal(0);
      expect(stats.formSubmits).to.equal(0);
      expect(stats.inputInteractions).to.equal(0);
      expect(stats.rageClicks).to.equal(0);
      expect(stats.deadClicks).to.equal(0);
    });

    it('counts action types correctly', function () {
      tracker.actions = [
        { type: 'click' },
        { type: 'click', isRageClick: true },
        { type: 'click', isDeadClick: true },
        { type: 'form_submit' },
        { type: 'input_focus' },
        { type: 'input_change' }
      ];

      const stats = tracker.getStats();
      expect(stats.totalActions).to.equal(6);
      expect(stats.clicks).to.equal(3);
      expect(stats.rageClicks).to.equal(1);
      expect(stats.deadClicks).to.equal(1);
      expect(stats.formSubmits).to.equal(1);
      expect(stats.inputInteractions).to.equal(2);
    });
  });

  // ==========================================
  // getActions
  // ==========================================
  describe('getActions', function () {

    it('returns copy of actions array', function () {
      tracker.actions = [{ type: 'click' }];
      const actions = tracker.getActions();
      expect(actions).to.have.lengthOf(1);
      // Should be a copy
      actions.push({ type: 'test' });
      expect(tracker.actions).to.have.lengthOf(1);
    });
  });

  // ==========================================
  // reset
  // ==========================================
  describe('reset', function () {

    it('clears all state', function () {
      tracker.actions = [{ type: 'click' }];
      tracker.lastClickTime = 12345;
      tracker.lastClickElement = {};
      tracker.clickCount = 5;
      tracker.pendingDeadClicks.set('dc1', {});

      tracker.reset();

      expect(tracker.actions).to.be.empty;
      expect(tracker.lastClickTime).to.equal(0);
      expect(tracker.lastClickElement).to.be.null;
      expect(tracker.clickCount).to.equal(0);
      expect(tracker.pendingDeadClicks.size).to.equal(0);
    });
  });

  // ==========================================
  // isEnabled
  // ==========================================
  describe('isEnabled', function () {

    it('returns config.enabled', function () {
      expect(tracker.isEnabled()).to.be.false;
      tracker.config.enabled = true;
      expect(tracker.isEnabled()).to.be.true;
    });
  });
});
