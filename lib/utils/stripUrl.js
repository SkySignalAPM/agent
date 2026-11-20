/**
 * Remove `user:pass@` / `token@` userinfo from a `scheme://` URL or spec.
 * Non-strings are returned as-is.
 */
export function stripUserinfo(url) {
  if (typeof url !== "string") return url;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
}

/**
 * Remove the parts of a URL that commonly carry secrets: query string,
 * fragment and userinfo. Accepts absolute URLs, relative paths and garbage;
 * never throws. Non-strings are returned as-is.
 */
export function stripUrl(url) {
  if (typeof url !== "string") return url;
  return stripUserinfo(url.replace(/[?#][\s\S]*$/, ""));
}
