// Analytics init: runs once per page load on the client.
//
// - Exposes window.la with helpers, so inline scripts (`<script is:inline>`)
//   can call them from any page.
// - Wires global event delegation for outbound_click on every external link.
// - Initializes scroll_depth_75 if the current page is a long article.

import {
	debouncedTrack,
	initScrollDepth,
	sanitizeQueryForTracking,
	sendOutboundClick,
	track,
} from "./analytics.ts";

declare global {
	interface Window {
		la?: {
			track: typeof track;
			sanitize: typeof sanitizeQueryForTracking;
			outbound: typeof sendOutboundClick;
			scrollDepth: typeof initScrollDepth;
			debounced: typeof debouncedTrack;
		};
	}
}

const SAME_HOST_RE = /^(?:[^/]*\/\/)?(?:www\.)?leyabierta\.es(?:[/:?#]|$)/i;

function isOutbound(href: string): boolean {
	if (!href) return false;
	if (href.startsWith("/") || href.startsWith("#") || href.startsWith("?"))
		return false;
	if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;
	// Same-origin (absolute or protocol-relative)
	if (SAME_HOST_RE.test(href)) return false;
	// Heuristic: must look like external URL
	return /^https?:\/\//i.test(href) || href.startsWith("//");
}

function wireOutboundClicks() {
	document.addEventListener(
		"click",
		(e) => {
			const target = e.target as Element | null;
			if (!target) return;
			const anchor = target.closest("a") as HTMLAnchorElement | null;
			if (!anchor) return;
			const href = anchor.getAttribute("href") || "";
			if (!isOutbound(href)) return;

			// Best-effort domain extraction without throwing on relative-ish hrefs.
			let domain = "";
			try {
				domain = new URL(anchor.href, window.location.href).hostname;
			} catch {
				domain = "";
			}

			sendOutboundClick(anchor.href, {
				domain,
				text: (anchor.textContent || "").slice(0, 80).trim(),
			});
		},
		{ capture: true, passive: true },
	);
}

function wireScrollDepthIfArticle() {
	// Long-content pages: /leyes/<id>/, /reforma/, /omnibus/<id>/, /sobre-leyabierta/
	const path = window.location.pathname;
	const isArticle =
		/^\/leyes\/[^/]+\/?$/.test(path) ||
		/^\/reforma\/?$/.test(path) ||
		/^\/omnibus\/[^/]+\/?$/.test(path) ||
		/^\/sobre-leyabierta\/?$/.test(path);
	if (!isArticle) return;

	const article =
		document.querySelector("article") ||
		document.querySelector("main") ||
		document.body;
	if (!article) return;

	// Sentinel at 75% of the article's height, hidden, no layout impact.
	const sentinel = document.createElement("div");
	sentinel.setAttribute("aria-hidden", "true");
	sentinel.style.cssText =
		"position:relative;width:1px;height:1px;pointer-events:none;";
	article.appendChild(sentinel);

	// Position the sentinel at 75% of the article's content height.
	// Run on next paint so layout is settled.
	requestAnimationFrame(() => {
		const totalHeight = article.scrollHeight;
		// Floats from absolute positioning don't disturb layout for the parent.
		sentinel.style.position = "absolute";
		sentinel.style.top = `${Math.floor(totalHeight * 0.75)}px`;
		sentinel.style.left = "0";
		// Ensure parent is positioned for absolute child.
		if (getComputedStyle(article).position === "static") {
			(article as HTMLElement).style.position = "relative";
		}
		const lawId = path.match(/^\/leyes\/([^/]+)\//)?.[1];
		initScrollDepth(sentinel, lawId ? { law_id: lawId } : undefined);
	});
}

export function initAnalytics(): void {
	if (typeof window === "undefined") return;

	window.la = {
		track,
		sanitize: sanitizeQueryForTracking,
		outbound: sendOutboundClick,
		scrollDepth: initScrollDepth,
		debounced: debouncedTrack,
	};

	wireOutboundClicks();

	// Scroll depth init happens after DOM is settled.
	if (
		document.readyState === "complete" ||
		document.readyState === "interactive"
	) {
		wireScrollDepthIfArticle();
	} else {
		document.addEventListener("DOMContentLoaded", wireScrollDepthIfArticle, {
			once: true,
		});
	}
}
