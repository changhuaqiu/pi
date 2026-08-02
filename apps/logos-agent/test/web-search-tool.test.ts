import assert from "node:assert/strict";
import test from "node:test";
import {
	createBingRssWebSearchOperations,
	createConfiguredWebSearchOperations,
	createSogouWebSearchOperations,
	createTavilyWebSearchOperations,
	createWebSearchTool,
	parseWebSearchInput,
	type WebSearchOperations,
} from "../src/web-search-tool.ts";

test("web_search validates and normalizes a constrained query", () => {
	assert.deepEqual(
		parseWebSearchInput({
			query: "  current TypeScript release  ",
			count: 3,
		}),
		{
			query: "current TypeScript release",
			count: 3,
		},
	);
	assert.throws(
		() => parseWebSearchInput({ query: "word ".repeat(51) }),
		/cannot exceed 50 words/,
	);
	assert.throws(
		() => parseWebSearchInput({ query: "valid", count: 11 }),
		/execution-time validation/,
	);
	assert.throws(
		() => parseWebSearchInput({ query: "valid", url: "https://example.com" }),
		/execution-time validation/,
	);
	assert.throws(
		() => parseWebSearchInput({ query: "visible\nhidden" }),
		/safe single-line text/,
	);
});

test("web_search returns bounded untrusted evidence through its interface", async () => {
	const requests: unknown[] = [];
	const operations: WebSearchOperations = {
		provider: "bing-rss",
		async search(request) {
			requests.push(request);
			return {
				provider: "bing-rss",
				results: [
					{
						title: "Official documentation",
						url: "https://example.com/docs",
						description: "Current release notes.",
					},
				],
				moreResultsAvailable: true,
			};
		},
	};
	const tool = createWebSearchTool(operations);
	const stages: string[] = [];
	const result = await tool.execute(
		"call-1",
		{ query: "typescript release", count: 2 },
		new AbortController().signal,
		(update) => {
			if (update.details) stages.push(update.details.stage);
		},
	);
	const text = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");

	assert.deepEqual(requests, [{ query: "typescript release", count: 2 }]);
	assert.deepEqual(stages, ["validating", "searching"]);
	assert.match(text, /untrusted data/);
	assert.match(text, /https:\/\/example\.com\/docs/);
	assert.deepEqual(result.details, {
		stage: "completed",
		provider: "bing-rss",
		resultCount: 1,
		moreResultsAvailable: true,
	});
});

test("configured web search prefers Tavily when an API key is available", () => {
	assert.equal(
		createConfiguredWebSearchOperations({ tavilyApiKey: "tvly-test" }).provider,
		"tavily",
	);
	assert.equal(createConfiguredWebSearchOperations().provider, "sogou");
});

test("Tavily adapter sends a bounded search request and parses results", async () => {
	let capturedAuthorization: string | null = null;
	let capturedBody: unknown;
	const operations = createTavilyWebSearchOperations({
		apiKey: "tvly-secret-value",
		fetch: async (_input, init) => {
			capturedAuthorization = new Headers(init?.headers).get("Authorization");
			capturedBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					results: [
						{
							title: "Official <b>documentation</b>",
							url: "https://example.com/docs",
							content: "Useful <em>current</em> documentation.",
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
	});
	const result = await operations.search({ query: "current docs", count: 3 });
	assert.equal(capturedAuthorization, "Bearer tvly-secret-value");
	assert.deepEqual(capturedBody, {
		query: "current docs",
		search_depth: "basic",
		max_results: 3,
		include_answer: false,
		include_raw_content: false,
		include_images: false,
	});
	assert.deepEqual(result, {
		provider: "tavily",
		results: [
			{
				title: "Official documentation",
				url: "https://example.com/docs",
				description: "Useful current documentation.",
			},
		],
		moreResultsAvailable: false,
	});
});

test("Sogou adapter keeps valid results when one result link fails", async () => {
	const requests: URL[] = [];
	const operations = createSogouWebSearchOperations({
		fetch: async (input) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input
						: input.url,
			);
			requests.push(url);
			if (url.pathname === "/link") {
				if (url.searchParams.get("url") === "broken") {
					throw new Error("isolated result link failure");
				}
				return new Response(
					'<script>window.location.replace("https://example.com/cloud")</script>',
				);
			}
			return new Response(`
				<div class="results">
					<h3 class="vr-title"><a href="/link?url=broken">Broken result</a></h3>
					<div class="space-txt base-ellipsis">This link fails.</div>
					<h3 class="vr-title"><a href="/link?url=opaque"><em>Cloud</em> tool</a></h3>
					<div class="space-txt base-ellipsis">Useful <b>official</b> result.</div>
				</div>
			`);
		},
	});
	const result = await operations.search({ query: "cloud tool", count: 2 });
	assert.equal(requests[0]?.origin, "https://www.sogou.com");
	assert.equal(requests[0]?.searchParams.get("query"), "cloud tool");
	assert.deepEqual(result, {
		provider: "sogou",
		results: [
			{
				title: "Cloud tool",
				url: "https://example.com/cloud",
				description: "Useful official result.",
			},
		],
		moreResultsAvailable: false,
	});
});

test("configured search falls back from Tavily to Sogou", async () => {
	const requestedHosts: string[] = [];
	const operations = createConfiguredWebSearchOperations({
		tavilyApiKey: "tvly-expired",
		fetch: async (input) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input
						: input.url,
			);
			requestedHosts.push(url.hostname);
			if (url.hostname === "api.tavily.com") {
				return new Response("rate limited", { status: 429 });
			}
			return new Response(`
				<h3 class="vr-title"><a href="https://example.com/result">Fallback result</a></h3>
				<div class="base-ellipsis">Relevant fallback.</div>
			`);
		},
	});
	const result = await operations.search({ query: "fallback", count: 1 });
	assert.equal(result.provider, "sogou");
	assert.deepEqual(requestedHosts, ["api.tavily.com", "www.sogou.com"]);
});

test("configured search falls back from empty Sogou results to Bing RSS", async () => {
	const operations = createConfiguredWebSearchOperations({
		fetch: async (input) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input
						: input.url,
			);
			if (url.hostname === "www.sogou.com") {
				return new Response("<html><body>No results</body></html>");
			}
			return new Response(`
				<rss><channel><item>
					<title>Bing fallback</title>
					<link>https://example.com/bing</link>
					<description>Last provider.</description>
				</item></channel></rss>
			`);
		},
	});
	const result = await operations.search({ query: "fallback", count: 1 });
	assert.equal(result.provider, "bing-rss");
	assert.equal(result.results[0]?.title, "Bing fallback");
});

test("configured search never falls back after user cancellation", async () => {
	const controller = new AbortController();
	const requestedHosts: string[] = [];
	const operations = createConfiguredWebSearchOperations({
		tavilyApiKey: "tvly-test",
		fetch: async (input) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input
						: input.url,
			);
			requestedHosts.push(url.hostname);
			controller.abort(new Error("cancel search"));
			throw controller.signal.reason;
		},
	});
	await assert.rejects(
		operations.search({ query: "cancel", count: 1 }, controller.signal),
		/cancel search/,
	);
	assert.deepEqual(requestedHosts, ["api.tavily.com"]);
});

test("Bing RSS adapter fixes its endpoint and sanitizes external results", async () => {
	const capturedUrls: URL[] = [];
	let capturedHeaders: Headers | undefined;
	const fetchRequest: typeof fetch = async (input, init) => {
		const url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input
					: input.url,
		);
		capturedUrls.push(url);
		capturedHeaders = new Headers(init?.headers);
		if (url.hostname === "www.bing.com") {
			return new Response(null, {
				status: 302,
				headers: { location: `https://cn.bing.com${url.pathname}${url.search}` },
			});
		}
		return new Response(
			`<?xml version="1.0" encoding="utf-8"?>
			<rss version="2.0"><channel>
				<item>
					<title>Safe&#x0; &lt;b&gt;title&lt;/b&gt;</title>
					<link>https://user:password@example.com/path?x=1&amp;y=2</link>
					<description><![CDATA[Useful <b>snippet</b> here]]></description>
					<pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
				</item>
				<item>
					<title>Unsafe scheme</title>
					<link>javascript:alert(1)</link>
					<description>discard me</description>
				</item>
			</channel></rss>`,
			{ status: 200, headers: { "content-type": "text/xml; charset=utf-8" } },
		);
	};
	const operations = createBingRssWebSearchOperations({
		fetch: fetchRequest,
	});
	const result = await operations.search(
		{ query: "safe query", count: 1 },
		new AbortController().signal,
	);

	assert.deepEqual(
		capturedUrls.map((url) => url.origin),
		["https://www.bing.com", "https://cn.bing.com"],
	);
	assert.equal(capturedUrls[0]?.pathname, "/search");
	assert.equal(capturedUrls[0]?.searchParams.get("q"), "safe query");
	assert.equal(capturedUrls[0]?.searchParams.get("format"), "rss");
	assert.equal(
		capturedHeaders?.get("Accept"),
		"application/rss+xml, application/xml, text/xml",
	);
	assert.deepEqual(result, {
		provider: "bing-rss",
		results: [
			{
				title: "Safe title",
				url: "https://example.com/path?x=1&y=2",
				description: "Useful snippet here",
				age: "Wed, 29 Jul 2026 00:00:00 GMT",
			},
		],
		moreResultsAvailable: true,
	});
});

test("Bing RSS adapter bounds failures, response size, and aborts", async () => {
	assert.throws(
		() => createBingRssWebSearchOperations({ timeoutMs: 0 }),
		/timeout must be between 1 and 60000 milliseconds/,
	);
	const httpFailure = createBingRssWebSearchOperations({
		fetch: async () => new Response("", { status: 429 }),
	});
	await assert.rejects(
		httpFailure.search({ query: "query", count: 1 }),
		/HTTP 429/,
	);

	const invalidResponse = createBingRssWebSearchOperations({
		fetch: async () => new Response("<html></html>"),
	});
	await assert.rejects(
		invalidResponse.search({ query: "query", count: 1 }),
		/invalid response/,
	);
	const unsafeRedirect = createBingRssWebSearchOperations({
		fetch: async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://example.com/search" },
			}),
	});
	await assert.rejects(
		unsafeRedirect.search({ query: "query", count: 1 }),
		/redirected outside the allowed host/,
	);

	const oversized = createBingRssWebSearchOperations({
		fetch: async () =>
			new Response("<rss><channel /></rss>", {
				headers: { "content-length": String(1024 * 1024 + 1) },
			}),
	});
	await assert.rejects(
		oversized.search({ query: "query", count: 1 }),
		/exceeds the allowed size/,
	);

	let fetchCalled = false;
	const aborting = createBingRssWebSearchOperations({
		fetch: async () => {
			fetchCalled = true;
			return new Response("<rss><channel /></rss>");
		},
	});
	const controller = new AbortController();
	controller.abort(new Error("stop search"));
	await assert.rejects(
		aborting.search({ query: "query", count: 1 }, controller.signal),
		/stop search/,
	);
	assert.equal(fetchCalled, false);
});

test("Bing RSS adapter enforces its timeout and streamed body limit", async () => {
	const timingOut = createBingRssWebSearchOperations({
		timeoutMs: 5,
		fetch: async (_input, init) =>
			await new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) {
					reject(new Error("missing signal"));
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	});
	await assert.rejects(
		timingOut.search({ query: "query", count: 1 }),
		/timed out after 5ms/,
	);

	const streamedOversized = createBingRssWebSearchOperations({
		fetch: async () => new Response("x".repeat(1024 * 1024 + 1)),
	});
	await assert.rejects(
		streamedOversized.search({ query: "query", count: 1 }),
		/exceeds the allowed size/,
	);
});
