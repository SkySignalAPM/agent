import { expect } from 'chai';
import { setupBrowserMocks, teardownBrowserMocks } from '../../helpers/browserMock.js';
import stripUrl from '../../../client/stripUrl.js';

describe('stripUrl', function () {

  before(setupBrowserMocks);
  after(teardownBrowserMocks);

  it('keeps origin + path and drops query and hash', function () {
    expect(stripUrl('https://a.com/#/reset-password/TOKEN')).to.equal('https://a.com/');
    expect(stripUrl('https://b.s3.amazonaws.com/f.png?X-Amz-Signature=abc')).to.equal('https://b.s3.amazonaws.com/f.png');
  });

  it('resolves relative URLs against the page', function () {
    expect(stripUrl('/login?next=/x')).to.equal('http://localhost:3000/login');
  });

  it('reduces non-http URLs to their scheme', function () {
    expect(stripUrl('data:text/plain,secret')).to.equal('data:');
    expect(stripUrl('blob:https://a.com/uuid')).to.equal('blob:');
  });

  it('returns empty string for non-strings and empty input', function () {
    expect(stripUrl(undefined)).to.equal('');
    expect(stripUrl('')).to.equal('');
    expect(stripUrl({ tagName: 'INPUT' })).to.equal('');
  });
});
