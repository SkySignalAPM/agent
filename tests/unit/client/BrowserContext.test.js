/**
 * BrowserContext tests — all static pure methods.
 * UA parsing, device/OS detection, network info.
 */

import { expect } from 'chai';
import { setupBrowserMocks, teardownBrowserMocks } from '../../helpers/browserMock.js';
import BrowserContext from '../../../client/BrowserContext.js';

describe('BrowserContext', function () {

  before(function () {
    setupBrowserMocks();
  });

  after(function () {
    teardownBrowserMocks();
  });

  // ==========================================
  // _detectBrowser
  // ==========================================
  describe('_detectBrowser', function () {

    it('detects Chrome', function () {
      expect(BrowserContext._detectBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      )).to.equal('Chrome');
    });

    it('detects Safari (not Chrome)', function () {
      expect(BrowserContext._detectBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Safari/537.36'
      )).to.equal('Safari');
    });

    it('detects Firefox', function () {
      expect(BrowserContext._detectBrowser(
        'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/121.0'
      )).to.equal('Firefox');
    });

    it('detects Edge', function () {
      expect(BrowserContext._detectBrowser(
        'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Edg/120.0.0.0'
      )).to.equal('Edge');
    });

    it('detects Opera (OPR)', function () {
      expect(BrowserContext._detectBrowser(
        'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0 OPR/106.0.0.0'
      )).to.equal('Opera');
    });

    it('detects Internet Explorer (Trident)', function () {
      expect(BrowserContext._detectBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko'
      )).to.equal('Internet Explorer');
    });

    it('detects Internet Explorer (MSIE)', function () {
      expect(BrowserContext._detectBrowser(
        'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1)'
      )).to.equal('Internet Explorer');
    });

    it('returns Other for unknown UA', function () {
      expect(BrowserContext._detectBrowser('UnknownBot/1.0')).to.equal('Other');
    });
  });

  // ==========================================
  // _detectBrowserVersion
  // ==========================================
  describe('_detectBrowserVersion', function () {

    it('extracts Chrome version', function () {
      expect(BrowserContext._detectBrowserVersion(
        'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36'
      )).to.equal('120');
    });

    it('extracts Safari version', function () {
      expect(BrowserContext._detectBrowserVersion(
        'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17 Safari/605.1.15'
      )).to.equal('17');
    });

    it('extracts Firefox version', function () {
      expect(BrowserContext._detectBrowserVersion(
        'Mozilla/5.0 Gecko/20100101 Firefox/121'
      )).to.equal('121');
    });

    it('extracts Edge version', function () {
      expect(BrowserContext._detectBrowserVersion(
        'Mozilla/5.0 Chrome/120.0.0.0 Edg/120'
      )).to.equal('120');
    });

    it('returns Unknown for unrecognized UA', function () {
      expect(BrowserContext._detectBrowserVersion('CustomBot/1.0')).to.equal('Unknown');
    });
  });

  // ==========================================
  // _detectDevice
  // ==========================================
  describe('_detectDevice', function () {

    it('detects mobile', function () {
      expect(BrowserContext._detectDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'
      )).to.equal('mobile');
    });

    it('detects tablet (iPad)', function () {
      expect(BrowserContext._detectDevice(
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      )).to.equal('tablet');
    });

    it('detects tablet (generic)', function () {
      expect(BrowserContext._detectDevice(
        'Mozilla/5.0 (Linux; Android 13) AppleWebKit Tablet'
      )).to.equal('tablet');
    });

    it('defaults to desktop', function () {
      expect(BrowserContext._detectDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      )).to.equal('desktop');
    });
  });

  // ==========================================
  // _detectOS
  // ==========================================
  describe('_detectOS', function () {

    it('detects Windows', function () {
      expect(BrowserContext._detectOS('Mozilla/5.0 (Windows NT 10.0)')).to.equal('Windows');
    });

    it('detects macOS (not iPhone/iPad)', function () {
      expect(BrowserContext._detectOS('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).to.equal('macOS');
    });

    it('detects Linux (not Android)', function () {
      expect(BrowserContext._detectOS('Mozilla/5.0 (X11; Linux x86_64)')).to.equal('Linux');
    });

    it('detects Android', function () {
      expect(BrowserContext._detectOS('Mozilla/5.0 (Linux; Android 13)')).to.equal('Android');
    });

    it('detects iOS (iPhone)', function () {
      expect(BrowserContext._detectOS('Mozilla/5.0 (iPhone; CPU iPhone OS)')).to.equal('iOS');
    });

    it('detects iOS (iPad)', function () {
      expect(BrowserContext._detectOS('Mozilla/5.0 (iPad; CPU OS 17_0)')).to.equal('iOS');
    });

    it('detects Chrome OS', function () {
      expect(BrowserContext._detectOS('Mozilla/5.0 (X11; CrOS x86_64)')).to.equal('Chrome OS');
    });

    it('returns Other for unknown OS', function () {
      expect(BrowserContext._detectOS('UnknownBot/1.0')).to.equal('Other');
    });
  });

  // ==========================================
  // _getNetworkInfo
  // ==========================================
  describe('_getNetworkInfo', function () {

    it('returns unknown when navigator.connection is absent', function () {
      const info = BrowserContext._getNetworkInfo();
      expect(info.connection).to.equal('unknown');
      expect(info.effectiveConnectionType).to.be.null;
    });
  });

  // ==========================================
  // collect
  // ==========================================
  describe('collect', function () {

    it('returns object with expected keys', function () {
      const ctx = BrowserContext.collect();
      expect(ctx).to.have.property('browser');
      expect(ctx).to.have.property('browserVersion');
      expect(ctx).to.have.property('device');
      expect(ctx).to.have.property('os');
      expect(ctx).to.have.property('viewport');
      expect(ctx).to.have.property('screen');
      expect(ctx).to.have.property('connection');
    });
  });

  // ==========================================
  // getUserId
  // ==========================================
  describe('getUserId', function () {

    it('returns null when Meteor is not available', function () {
      expect(BrowserContext.getUserId()).to.be.null;
    });
  });
});
