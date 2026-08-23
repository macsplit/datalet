// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { safeWebUrl } from "./urlSafety";

/**
 * A soft, client-side ceiling on the markdown field, well under the app's
 * real backstops (a 2MB request body, an 8MB vault quota) - those already
 * make a huge paste impossible to lose data over. This exists only to keep
 * the textarea and the re-parse on every render pleasant to use, not as a
 * security boundary.
 */
export const MARKDOWN_FIELD_MAX_LENGTH = 50_000;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);
}

// Tried in this order at each position: code span, link, `**`/`__` bold,
// then `*`/`_` italic. Deliberately not a full CommonMark inline grammar -
// no nesting (bold inside a link, italic inside bold), just the handful of
// effects worth reaching for in a note.
//
// The underscore alternatives require a non-word character on each outer
// edge, or `snake_case_identifiers` and `__dunder_names__` - both common in
// pasted logs and code, exactly the content this field is for - open a bold
// span at the first one and go hunting for the next `__` anywhere later in
// the note to close it, swallowing everything unrelated in between.
//
// No image token (`![alt](url)`), and none is planned: an <img> fetches its
// src the moment the record renders, with no user action in between. For a
// field that can hold someone else's synced or COPY-code data, that is a
// tracking pixel by construction - viewing a note would silently tell
// whatever url was pasted into it that it had been viewed, and from where.
// It would also just be a broken icon offline. `![alt](url)` therefore
// falls through as a literal `!` followed by an ordinary link - visible,
// inert until clicked, ordinary.
const INLINE_TOKEN = /(`[^`]+`)|(\[[^\]]*\]\([^\s)]+\))|(\*\*[^*]+\*\*)|((?<!\w)__[^_]+__(?!\w))|(\*[^*]+\*)|((?<!\w)_[^_]+_(?!\w))/g;

/**
 * Turns one line's worth of markdown into HTML, with every character that
 * didn't come from this function's own template strings passed through
 * `escapeHtml` first. A raw `<script>` in the source is never treated as a
 * token - it can only ever end up as a plain run of text, HTML-escaped
 * along with everything else, so it renders as visible text rather than
 * being interpreted.
 */
function renderInline(raw: string): string {
  let result = "";
  let lastIndex = 0;
  for (const match of raw.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0;
    result += escapeHtml(raw.slice(lastIndex, index));
    const token = match[0];
    if (token.startsWith("`")) {
      result += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith("[")) {
      const parsed = /^\[([^\]]*)\]\(([^\s)]+)\)$/.exec(token);
      const text = parsed ? parsed[1] : "";
      const url = parsed ? parsed[2] : "";
      const href = safeWebUrl(url);
      // A link this app can't call safe - a relative path, an anchor, a
      // non-http(s) scheme - degrades to its literal markdown source rather
      // than being dropped silently or rendered as a dead link. A record
      // field has no base location to resolve a relative link against, so
      // there is no "safe" way to resolve it either.
      result += href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(text)}</a>`
        : escapeHtml(token);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      result += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
    } else {
      result += `<em>${escapeHtml(token.slice(1, -1))}</em>`;
    }
    lastIndex = index + token.length;
  }
  result += escapeHtml(raw.slice(lastIndex));
  return result;
}

/**
 * A small, safe-by-construction markdown-to-HTML renderer for the
 * `markdown` field type: headings, bold, italic, inline code, fenced code
 * blocks, lists, blockquotes, and http(s)-only links. Nothing more.
 *
 * "Safe by construction" rather than "sanitized after the fact": raw HTML
 * in the source is never given a code path that could turn it into a real
 * element. Every tag in the output comes from this file's own template
 * strings; the only thing ever interpolated from user input is text that
 * has gone through `escapeHtml`, or a URL that has gone through
 * `safeWebUrl`. There is no dependency to trust here, no allowlist to keep
 * in sync with a parser's defaults - a `<script>` typed into the field can
 * only ever come out the other end as the visible text `<script>`.
 */
export function renderMarkdownToSafeHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // the closing fence, if the block was ever closed
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(`<blockquote><p>${renderInline(quoted.join(" "))}</p></blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length
      && lines[i].trim() !== ""
      && !/^```/.test(lines[i])
      && !/^#{1,3}\s+/.test(lines[i])
      && !/^>\s?/.test(lines[i])
      && !/^[-*]\s+/.test(lines[i])
      && !/^\d+\.\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${paragraph.map(renderInline).join("<br />")}</p>`);
  }

  return blocks.join("\n");
}
