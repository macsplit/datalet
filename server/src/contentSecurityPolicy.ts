// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * The app's Content Security Policy, applied two ways: as a response header
 * when the sync server serves the built app (staticServer.ts), and as a
 * `<meta http-equiv>` injected into the built index.html (vite.config.ts) so
 * the policy still applies under any other static host.
 *
 * `font-src 'self'` is the load-bearing directive for theme-in-graph work
 * (theme-in-graph-plan.md): stored theme values must never be able to cause an
 * outbound request, and a browser-enforced policy is worth more than a
 * convention every future change has to remember. The rest is ordinary
 * hardening for an app that talks only to its own origin.
 */
const DIRECTIVES: Array<[string, string]> = [
  ["default-src", "'self'"],
  ["script-src", "'self'"],
  // React writes style props and the graph-backed theme injects a <style>
  // element, both of which count as inline styles. This does not weaken
  // font-src, which is the directive this policy exists for.
  ["style-src", "'self' 'unsafe-inline'"],
  ["font-src", "'self'"],
  // `data:` is required by the QR pairing view.
  ["img-src", "'self' data:"],
  // Assumes the sync server is same-origin, which remote-sync-deployment.md
  // already requires via the reverse proxy. A split-origin deployment has to
  // widen this deliberately.
  ["connect-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
];

// Only meaningful as a response header - browsers ignore it in a meta tag,
// and warn about it, so the meta variant leaves it out rather than shipping a
// directive that silently does nothing.
const HEADER_ONLY_DIRECTIVES: Array<[string, string]> = [["frame-ancestors", "'none'"]];

function serialize(directives: Array<[string, string]>): string {
  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

/** The full policy, for the `Content-Security-Policy` response header. */
export const CONTENT_SECURITY_POLICY = serialize([...DIRECTIVES, ...HEADER_ONLY_DIRECTIVES]);

/** The policy minus directives a `<meta http-equiv>` cannot express. */
export const CONTENT_SECURITY_POLICY_META = serialize(DIRECTIVES);
