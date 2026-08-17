import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import {
  CONTENT_SECURITY_POLICY,
  CONTENT_SECURITY_POLICY_META,
} from "../src/contentSecurityPolicy.js";
import { serveStatic } from "../src/staticServer.js";

test("the policy keeps the directives the theme work depends on", () => {
  // font-src is the reason this policy exists: a theme value stored in the
  // graph must not be able to cause an outbound request. connect-src and
  // img-src carry deliberate allowances that are easy to widen by accident.
  for (const policy of [CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY_META]) {
    assert.match(policy, /(^|; )font-src 'self'(;|$)/);
    assert.match(policy, /(^|; )default-src 'self'(;|$)/);
    assert.match(policy, /(^|; )script-src 'self'(;|$)/);
    assert.match(policy, /(^|; )connect-src 'self'(;|$)/);
    assert.match(policy, /(^|; )img-src 'self' data:(;|$)/);
    assert.doesNotMatch(policy, /font-src[^;]*https?:/);
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  }
});

test("only the header form carries directives a meta tag cannot express", () => {
  // Browsers ignore frame-ancestors in a meta tag and warn about it, so
  // shipping it there would be a directive that silently does nothing.
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY_META, /frame-ancestors/);
});

test("every static response carries the policy, not just the document", async () => {
  const staticDir = mkdtempSync(join(tmpdir(), "localgraph-csp-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(staticDir, "app.js"), "export const ok = true;\n");

  const server = createServer((req, res) => serveStatic(staticDir, req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");

  try {
    // A policy that only covered index.html would leave a directly-opened
    // asset unprotected, so both are checked.
    for (const path of ["/", "/app.js"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
    }
  } finally {
    server.close();
    await once(server, "close");
    rmSync(staticDir, { recursive: true, force: true });
  }
});
