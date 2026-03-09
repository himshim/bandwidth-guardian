// Bandwidth Guardian — content script
//
// ══ ARCHITECTURE ══════════════════════════════════════════════════════════════
//
//  Image interception is now split across two layers:
//
//  Layer 1 — prehook.js (document_start, synchronous)
//    Patches HTMLImageElement.prototype.src, srcset, setAttribute, and Image()
//    BEFORE the HTML parser runs. Catches all images set via JavaScript.
//    Zero wasted bytes — proxy URL is set before any network request fires.
//
//  Layer 2 — THIS FILE (document_start, async after storage read)
//    Catches three categories that prehook cannot:
//
//    A) HTML-parsed <img src="..."> attributes — the browser's C++ HTML parser
//       sets src natively, bypassing our JS property-setter patch. By the time
//       this script's storage callback fires (~5–50ms), the browser may have
//       already started fetching the original image. Rewriting src here causes
//       the browser to cancel the in-flight original request and fetch from the
//       proxy instead. A tiny amount of the original image's bytes may already
//       be in flight — this is unavoidable in MV3 (webRequestBlocking was
//       removed). The alternative (DNR redirect) cannot URL-encode the captured
//       URL, producing malformed proxy requests for any URL with query params.
//
//    B) Lazy-load data attributes (data-src, data-lazy-src…) — rewritten so
//       that when a lazy-loader later does img.src = img.dataset.src, prehook
//       receives the proxy URL and the browser never fetches the original.
//
//    C) Inline CSS background-image — rewritten via el.style.backgroundImage.
//       Best-effort: stylesheet-defined backgrounds may already be loading.
//
//  The previous approach of using DNR regexSubstitution for image redirects
//  was removed because DNR cannot call encodeURIComponent. Any image URL
//  with query params (e.g. tvguide.com/img.jpg?auto=webp&width=1092) would
//  produce a malformed proxy URL with the original query params orphaned into
//  the proxy's own query string, silently breaking compression for those images.
//
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  // ── KEEP IN SYNC WITH defaults.js ─────────────────────────────────────────
  const DEFAULTS = {
    enabled:         true,
    proxyBase:       "",
    quality:         40,
    grayscale:       true,
    maxWidth:        1920,
    excludeDomains:  "google.com gstatic.com",
    isWebpSupported: false
  };
  // ──────────────────────────────────────────────────────────────────────────

  // Lazy-load attributes used by common image libraries
  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo"
  ];

  // Tracking pixel URL patterns (ported from original shouldCompress.js)
  // Catches tracking pixels by URL pattern, regardless of domain.
  const TRACKING_PATTERNS = [
    /pagead/i,
    /(pixel|cleardot)\.*\.(gif|jpg|jpeg)/i,
    /google\.([a-z.]+)\/(ads|generate_204|.*\/log204)+/i,
    /google-analytics\.([a-z.]+)\/(r|collect)+/i,
    /youtube\.([a-z.]+)\/(api|ptracking|player_204|live_204)+/i,
    /doubleclick\.([a-z.]+)\/(pcs|pixel|r)+/i,
    /googlesyndication\.([a-z.]+)\/ddm/i,
    /pixel\.facebook\.([a-z.]+)/i,
    /facebook\.([a-z.]+)\/(impression\.php|tr)+/i,
    /ad\.bitmedia\.io/i,
    /yahoo\.([a-z.]+)\/pixel/i,
    /criteo\.net\/img/i,
    /ad\.doubleclick\.net/i
  ];

  let opts = null;
  const done = new WeakSet(); // elements already processed — no double-rewrites

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = u => { try { return new URL(u); } catch { return null; } };
  const isHttp  = u => /^https?:\/\//i.test(u);

  function domainSet(text) {
    return new Set(
      String(text || "").split(/[,\s]+/)
        .map(s => s.trim().toLowerCase()).filter(Boolean)
        .map(s => s.replace(/^https?:\/\//, "").split("/")[0])
    );
  }

  function shouldSkip(url) {
    if (!opts?.enabled || !opts?.proxyBase) return true;
    if (!isHttp(url)) return true;
    const u = safeURL(url);
    if (!u) return true;
    // Already proxied
    const proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase();
    if (proxyHost && u.hostname.toLowerCase() === proxyHost) return true;
    // Excluded domain (page or image host)
    const ex = domainSet(opts.excludeDomains);
    if (ex.has(u.hostname.toLowerCase())) return true;
    if (ex.has(location.hostname.toLowerCase())) return true;
    // Skip .ico, .svg (original shouldCompress.js check)
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".ico") || path.endsWith(".svg")) return true;
    // Skip favicons
    if (url.toLowerCase().includes("favicon")) return true;
    // Skip tracking pixels
    if (TRACKING_PATTERNS.some(p => p.test(url))) return true;
    return false;
  }

  // Builds the proxy URL with full param set, all values properly encoded.
  // Mirrors original buildCompressUrl() plus himshim proxy2 additions.
  function buildProxyUrl(orig) {
    const base = (opts.proxyBase || "").trim();
    const sep  = base.includes("?") ? "&" : "?";
    // jpeg=1 when WebP not supported — proxy returns JPEG instead (original: jpeg=${isWebpSupported ? 0 : 1})
    const jpeg = opts.isWebpSupported ? "0" : "1";
    // bw= always sent as 0 or 1 — proxy must receive explicit value (original: bw=${convertBw ? 1 : 0})
    const bw   = opts.grayscale ? "1" : "0";
    const parts = [
      "url="       + encodeURIComponent(orig),
      "jpeg="      + jpeg,
      "bw="        + bw,
      "quality="   + (opts.quality ?? 40),
    ];
    if (opts.maxWidth) parts.push("max_width=" + opts.maxWidth);
    return base + sep + parts.join("&");
  }

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements.
  function rewriteImg(el) {
    if (!el || done.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    if (el.tagName === "IMG" || el.tagName === "SOURCE") {
      // src
      const src = el.getAttribute("src");
      if (src && isHttp(src) && !shouldSkip(src)) {
        // Use native src setter to avoid triggering prehook's patch again
        Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")
          ?.set?.call(el, buildProxyUrl(src));
        rewrote = true;
      }

      // srcset
      const ss = el.getAttribute("srcset");
      if (ss) {
        let touched = false;
        const rewritten = ss.split(",").map(part => {
          const m = part.trim().match(/^(\S+)(\s.*)?$/);
          if (!m) return part;
          const [, url, desc = ""] = m;
          if (!isHttp(url) || shouldSkip(url)) return part;
          touched = true;
          return buildProxyUrl(url) + desc;
        }).join(", ");
        if (touched) { el.setAttribute("srcset", rewritten); rewrote = true; }
      }
    }

    if (rewrote) done.add(el);
  }

  // ── B) Lazy-attr rewriting ─────────────────────────────────────────────────
  // Rewrites data-src etc. so lazy-loaders pass proxy URLs to prehook.
  function rewriteLazy(el) {
    if (!el || done.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    for (const attr of LAZY_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val || !isHttp(val) || shouldSkip(val)) continue;
      el.setAttribute(attr, buildProxyUrl(val));
      rewrote = true;
    }

    // data-srcset
    const dss = el.getAttribute("data-srcset");
    if (dss) {
      let touched = false;
      const rewritten = dss.split(",").map(part => {
        const m = part.trim().match(/^(\S+)(\s.*)?$/);
        if (!m) return part;
        const [, url, desc = ""] = m;
        if (!isHttp(url) || shouldSkip(url)) return part;
        touched = true;
        return buildProxyUrl(url) + desc;
      }).join(", ");
      if (touched) { el.setAttribute("data-srcset", rewritten); rewrote = true; }
    }

    if (rewrote) done.add(el);
  }

  // ── C) Inline background-image rewriting ──────────────────────────────────
  // Handles elements with style="background-image: url(...)".
  // CSS stylesheet backgrounds can't be intercepted without getComputedStyle,
  // but overriding inline style is enough for most dynamic content.
  function rewriteBg(el) {
    if (!el || done.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;
    const bg = el.style?.backgroundImage;
    if (!bg || !bg.startsWith("url(")) return;
    const raw = bg.slice(4, -1).replace(/['"]/g, "").trim();
    if (!raw || !isHttp(raw) || shouldSkip(raw)) return;
    el.style.backgroundImage = `url("${buildProxyUrl(raw)}")`;
    done.add(el);
  }

  // ── Full-page scan ────────────────────────────────────────────────────────
  function rewriteAll() {
    // Images and picture sources
    document.querySelectorAll("img, picture source").forEach(rewriteImg);

    // Lazy-loaded images
    const lazySel = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");
    document.querySelectorAll(lazySel).forEach(rewriteLazy);

    // Inline backgrounds on container elements
    document.querySelectorAll(
      "div, section, article, header, footer, aside, main, " +
      "figure, li, a, span, td, th, [style*='background']"
    ).forEach(rewriteBg);
  }

  // ── MutationObserver ───────────────────────────────────────────────────────
  // Catches images added or changed after initial load (infinite scroll, SPAs…)
  const mo = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          rewriteImg(n);
          rewriteLazy(n);
          rewriteBg(n);
          n.querySelectorAll?.("img, source").forEach(rewriteImg);
          const lazySel = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");
          n.querySelectorAll?.(lazySel).forEach(rewriteLazy);
          n.querySelectorAll?.("[style*='background']").forEach(rewriteBg);
        });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;
        if (m.attributeName === "src" || m.attributeName === "srcset") {
          if (t.tagName === "IMG" || t.tagName === "SOURCE") {
            done.delete(t); // allow re-rewrite when src changes
            rewriteImg(t);
          }
        } else if (m.attributeName === "style") {
          done.delete(t);
          rewriteBg(t);
        } else if (LAZY_ATTRS.includes(m.attributeName) || m.attributeName === "data-srcset") {
          done.delete(t);
          rewriteLazy(t);
        }
      }
    }
  });

  mo.observe(document.documentElement, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset"]
  });

  // ── Preconnect to proxy ───────────────────────────────────────────────────
  // Injecting <link rel="preconnect"> opens the TCP+TLS connection to the proxy
  // in parallel with HTML parsing, so the first image request doesn't pay the
  // full handshake cost (~100-300 ms on mobile).
  // dns-prefetch is a lighter fallback for browsers that ignore preconnect.
  function injectPreconnect(proxyBase) {
    try {
      const origin = new URL(proxyBase).origin;
      if (document.querySelector(`link[href="${origin}"]`)) return; // already injected
      const root = document.head || document.documentElement;
      if (!root) return;
      const pc = document.createElement("link");
      pc.rel  = "preconnect";
      pc.href = origin;
      pc.crossOrigin = "anonymous";
      root.prepend(pc);
      const dns = document.createElement("link");
      dns.rel  = "dns-prefetch";
      dns.href = origin;
      root.prepend(dns);
    } catch {}
  }

  // ── Load settings then process page ───────────────────────────────────────
  // Try storage.local first (bhOpts mirror, ~5 ms). If bhOpts isn't there yet
  // (fresh install, service worker hasn't run, browser restart) fall back to
  // storage.sync and write the mirror so subsequent pages are fast.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (d.bhOpts) {
      opts = d.bhOpts;
      if (opts.enabled && opts.proxyBase) {
        injectPreconnect(opts.proxyBase);
        rewriteAll();
      }
    } else {
      chrome.storage.sync.get(DEFAULTS, synced => {
        opts = synced;
        // Write mirror so next page load takes the fast path
        chrome.storage.local.set({ bhOpts: synced });
        if (opts.enabled && opts.proxyBase) {
          injectPreconnect(opts.proxyBase);
          rewriteAll();
        }
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror updated by service worker, instant).
  // Fallback: sync area — catches changes when the service worker is inactive,
  // restarting, or not supported (Kiwi/Cromite). Both paths update opts.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      opts = changes.bhOpts.newValue || DEFAULTS;
    } else if (area === "sync") {
      // Rebuild opts from the sync change and also refresh the local mirror
      chrome.storage.sync.get(DEFAULTS, synced => {
        opts = synced;
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });
})();
