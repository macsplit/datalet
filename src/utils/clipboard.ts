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
 * Copy text, and say whether it worked.
 *
 * `navigator.clipboard` exists only in a secure context, so a page served over
 * plain http - which is every LAN address short of localhost - has no
 * `navigator.clipboard` at all, and reading `.writeText` off it throws. Both
 * call sites used to swallow that in an empty catch, so pressing Copy on such
 * a page did nothing whatsoever: no copy, no message, no change of label. The
 * clipboard is exactly where a silent failure is most expensive, because the
 * next thing anyone does is paste something stale and not notice.
 *
 * The fallback is `document.execCommand("copy")`, which is deprecated and
 * still the only thing that works without a secure context. It needs a real
 * selection, hence the offscreen textarea.
 *
 * Returning a boolean rather than throwing keeps the decision at the call
 * site: what to tell someone whose browser will not copy is a question about
 * that panel's wording, not about the clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied, or no permission in this context. Fall through and try the
    // legacy path rather than reporting failure on the strength of one API.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.setAttribute("aria-hidden", "true");
  // Offscreen rather than `display: none`: a hidden element cannot hold a
  // selection, and moving the viewport would be its own bug.
  scratch.style.position = "fixed";
  scratch.style.top = "0";
  scratch.style.left = "-9999px";
  scratch.style.opacity = "0";
  const previous = document.activeElement;
  document.body.appendChild(scratch);
  try {
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    scratch.remove();
    // Give focus back, or the button someone just pressed loses it silently.
    if (previous instanceof HTMLElement) previous.focus();
  }
}
