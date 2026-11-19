import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

type LiveState = "none" | "upcoming" | "live";

class MemoryKv {
	values = new Map<string, string>();

	async get(key: string) {
		return this.values.get(key) ?? null;
	}

	async put(key: string, value: string) {
		this.values.set(key, value);
	}

	async delete(key: string) {
		this.values.delete(key);
	}

	async list({ prefix = "", cursor }: { prefix?: string; cursor?: string }) {
		assert.equal(cursor, undefined);
		return {
			keys: [...this.values.keys()]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ name })),
			list_complete: true,
		};
	}
}

function feed(videoId: string, updated = "2026-11-19T10:00:00Z") {
	return `<?xml version="1.0"?><feed><entry><yt:videoId>${videoId}</yt:videoId><yt:channelId>UC123</yt:channelId><title>通知テスト</title><author><name>投稿者</name></author><published>2026-11-19T10:00:00Z</published><updated>${updated}</updated></entry></feed>`;
}

function environment(kv: MemoryKv) {
	return {
		YT_SUBS: kv,
		DISCORD_WEBHOOK_URL: "https://discord.test/webhook",
		CALLBACK_BASE_URL: "https://worker.test",
		HUB_SECRET: "",
		ADMIN_TOKEN: "admin",
		YOUTUBE_DATA_API_KEY: { get: async () => "test-key" },
	};
}

function fetchMock(state: () => LiveState, discordBodies: unknown[], failDiscord = false) {
	return async (input: URL | string, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://www.googleapis.com/youtube/v3/videos")) {
			return Response.json({
				items: [
					{
						id: new URL(url).searchParams.get("id"),
						snippet: {
							title: "通知テスト",
							channelTitle: "投稿者",
							liveBroadcastContent: state(),
						},
						...(state() === "none"
							? {}
							: {
									liveStreamingDetails: {
										scheduledStartTime: "2026-11-20T12:00:00Z",
									},
								}),
					},
				],
			});
		}
		if (url === "https://discord.test/webhook") {
			discordBodies.push(JSON.parse(String(init?.body)));
			return failDiscord
				? new Response("failed", { status: 500 })
				: new Response(null, { status: 204 });
		}
		throw new Error(`Unexpected fetch: ${url}`);
	};
}

async function webhook(env: ReturnType<typeof environment>, body: string) {
	return worker.fetch(
		new Request("https://worker.test/webhook/youtube", { method: "POST", body }),
		env as never,
		{} as never,
	);
}

test("notifies once for an uploaded video and suppresses later metadata updates", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	const discordBodies: unknown[] = [];
	globalThis.fetch = fetchMock(() => "none", discordBodies) as typeof fetch;
	try {
		assert.equal((await webhook(environment(kv), feed("video-1"))).status, 200);
		assert.equal(
			(await webhook(environment(kv), feed("video-1", "2026-11-19T10:10:00Z"))).status,
			200,
		);
		assert.equal(discordBodies.length, 1);
		assert.match(JSON.stringify(discordBodies[0]), /📹 新着動画/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("records an upcoming live and sends its scheduled notification only once", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	const discordBodies: unknown[] = [];
	globalThis.fetch = fetchMock(() => "upcoming", discordBodies) as typeof fetch;
	try {
		await webhook(environment(kv), feed("live-1"));
		await webhook(environment(kv), feed("live-1"));
		assert.equal(discordBodies.length, 1);
		assert.match(JSON.stringify(discordBodies[0]), /📅 ライブ配信予定/);
		assert.equal(await kv.get("pending_live:live-1"), "1");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("minute cron announces a pending live once it becomes live and removes it from polling", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	kv.values.set("pending_live:live-2", "1");
	const discordBodies: unknown[] = [];
	globalThis.fetch = fetchMock(() => "live", discordBodies) as typeof fetch;
	const pending: Promise<unknown>[] = [];
	try {
		await worker.scheduled(
			{ cron: "* * * * *" } as never,
			environment(kv) as never,
			{ waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as never,
		);
		await Promise.all(pending);
		assert.equal(discordBodies.length, 1);
		assert.match(JSON.stringify(discordBodies[0]), /🔴 ライブ配信中/);
		assert.equal(await kv.get("pending_live:live-2"), null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("does not mark a notification sent when Discord rejects it", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	const failedBodies: unknown[] = [];
	globalThis.fetch = fetchMock(() => "none", failedBodies, true) as typeof fetch;
	try {
		assert.equal((await webhook(environment(kv), feed("retry-1"))).status, 500);
		assert.equal(await kv.get("notified:video:retry-1"), null);

		const successfulBodies: unknown[] = [];
		globalThis.fetch = fetchMock(() => "none", successfulBodies) as typeof fetch;
		assert.equal((await webhook(environment(kv), feed("retry-1"))).status, 200);
		assert.equal(successfulBodies.length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
