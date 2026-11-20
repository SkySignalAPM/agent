/**
 * Shared collector utils — stripUrl/stripUserinfo (secrets in URLs) and
 * trimToMaxSize (batched trimming).
 */

import { expect } from 'chai';
import { stripUrl, stripUserinfo } from '../../../lib/utils/stripUrl.js';
import { trimToMaxSize } from '../../../lib/utils/buffer.js';

describe('stripUrl', function () {

  it('drops query, fragment and userinfo; tolerates relative paths and garbage', function () {
    expect(stripUrl('https://u:p@api.example.com:8443/a/b?token=x#h')).to.equal('https://api.example.com:8443/a/b');
    expect(stripUrl('/reset-password/abc?token=x')).to.equal('/reset-password/abc');
    expect(stripUrl('not a url ?#')).to.equal('not a url ');
    expect(stripUrl(null)).to.equal(null);
    expect(stripUrl(undefined)).to.equal(undefined);
  });

  it('stripUserinfo removes tokens from dependency specs but keeps the ref', function () {
    expect(stripUserinfo('git+https://ghp_xxx@github.com/org/repo.git#v1.2.0'))
      .to.equal('git+https://github.com/org/repo.git#v1.2.0');
    expect(stripUserinfo('^1.2.3')).to.equal('^1.2.3');
    expect(stripUserinfo('github:org/repo')).to.equal('github:org/repo');
  });
});

describe('trimToMaxSize', function () {

  it('drops the excess plus a 10% margin so it does not splice on every push', function () {
    const arr = Array.from({ length: 101 }, (_, i) => i);
    trimToMaxSize(arr, 100);
    expect(arr).to.have.lengthOf(90);
    expect(arr[0]).to.equal(11); // oldest dropped
    for (let i = 0; i < 10; i++) arr.push(i);
    const before = arr.length;
    trimToMaxSize(arr, 100);
    expect(arr.length).to.equal(before); // at max, untouched
  });
});
