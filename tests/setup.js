/**
 * Global test setup for skysignal:agent tests.
 *
 * - Registers Babel with module-resolver to rewrite `meteor/*` imports
 * - Exports root hooks for sinon auto-restore and global cleanup
 *
 * IMPORTANT: Babel config is inlined here (not in .babelrc) so that
 * Meteor's build system does not pick up the test-only module aliases
 * when building the package for real applications.
 */

require('@babel/register')({
  extensions: ['.js'],
  ignore: [/node_modules/],
  cwd: require('path').resolve(__dirname, '..'),
  presets: [
    ['@babel/preset-env', {
      targets: { node: 'current' },
      modules: 'commonjs'
    }]
  ],
  plugins: [
    ['module-resolver', {
      alias: {
        'meteor/meteor': './tests/helpers/meteorMock.js',
        'meteor/mongo': './tests/helpers/meteorMock.js',
        'meteor/check': './tests/helpers/meteorMock.js',
        'meteor/ddp': './tests/helpers/meteorMock.js',
        'meteor/accounts-base': './tests/helpers/meteorMock.js',
        'meteor/ddp-client': './tests/helpers/meteorMock.js',
        'meteor/random': './tests/helpers/meteorMock.js',
        'meteor/tracker': './tests/helpers/meteorMock.js',
        'meteor/fetch': './tests/helpers/meteorMock.js',
        'meteor/webapp': './tests/helpers/meteorMock.js',
        './ScreenshotCapture': './tests/helpers/screenshotMock.js',
        'html2canvas': './tests/helpers/html2canvasMock.js',
        'web-vitals': './tests/helpers/webVitalsMock.js'
      }
    }]
  ]
});

const sinon = require('sinon');

// Mocha root hooks (available via --require)
module.exports = {
  mochaHooks: {
    afterEach() {
      sinon.restore();
      delete global._skySignalWaitTimeBySession;
      delete global.SkySignalTracer;
    }
  }
};
