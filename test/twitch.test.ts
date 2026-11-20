import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

class MemoryKv {
	values = new Map<string, string>();

	async get(key: string, type?: "json") {
		const value = this.values.get(key) ?? null;
		return type === "json" && value ? JSON.parse(value) : value;
	}

	async put(key: string, value: string) {
		this.values.set(key, value);
	}

	async delete(key: string) {
		this.values.delete(key);
	}
}

function environment(kv: MemoryKv) {
	return {
		YT_SUBS: kv,
		DISCORD_WEBHOOK_URL: "https://discord.test/webhook",
		CALLBACK_BASE_URL: "https://worker.test",
		HUB_SECRET: "",
		ADMIN_TOKEN: "admin",
		YOUTUBE_DATA_API_KEY: { get: async () => "youtube-key" },
		TWITCH_CLIENT_ID: "twitch-client-id",
		TWITCH_CLIENT_SECRET: { get: async () => "twitch-client-secret" },
		TWITCH_EVENTSUB_SECRET: { get: async () => "eventsub-test-secret" },
	};
}

async function eventSignature(id: string, timestamp: string, body: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode("eventsub-test-secret"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(`${id}${timestamp}${body}`),
		),
	);
	return `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function twitchWebhook(
	env: ReturnType<typeof environment>,
	type: string,
	payload: unknown,
	options: { id?: string; signature?: string; timestamp?: string } = {},
) {
	const body = JSON.stringify(payload);
	const id = options.id ?? "message-1";
	const timestamp = options.timestamp ?? new Date().toISOString();
	const signature =
		options.signature ?? (await eventSignature(id, timestamp, body));
	return worker.fetch(
		new Request("https://worker.test/webhook/twitch", {
			method: "POST",
			headers: {
				"Twitch-Eventsub-Message-Id": id,
				"Twitch-Eventsub-Message-Timestamp": timestamp,
				"Twitch-Eventsub-Message-Signature": signature,
				"Twitch-Eventsub-Message-Type": type,
				"Twitch-Eventsub-Subscription-Type": "stream.online",
			},
			body,
		}),
		env as never,
		{} as never,
	);
}

function fetchMock(
	discordBodies: unknown[],
	deletedSubscriptions: string[],
	failDiscord = false,
) {
	return async (input: URL | string, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://id.twitch.tv/oauth2/token")
			return Response.json({ access_token: "app-token" });
		if (url === "https://api.twitch.tv/helix/users?login=streamer")
			return Response.json({
				data: [{ id: "42", login: "streamer", display_name: "Streamer" }],
			});
		if (
			url === "https://api.twitch.tv/helix/eventsub/subscriptions" &&
			init?.method === "POST"
		)
			return Response.json({
				data: [
					{ id: "sub-42", status: "webhook_callback_verification_pending" },
				],
			});
		if (
			url === "https://api.twitch.tv/helix/eventsub/subscriptions?id=sub-42" &&
			init?.method === "DELETE"
		) {
			deletedSubscriptions.push("sub-42");
			return new Response(null, { status: 204 });
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

async function subscribe(
	env: ReturnType<typeof environment>,
	login = "streamer",
) {
	return worker.fetch(
		new Request("https://worker.test/manage/twitch/subscribe", {
			method: "POST",
			headers: {
				Origin: "https://worker.test",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ login }).toString(),
		}),
		env as never,
		{} as never,
	);
}

test("Twitch callback challenge validates its signature and enables the registered channel", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	const discordBodies: unknown[] = [];
	globalThis.fetch = fetchMock(discordBodies, []) as typeof fetch;
	try {
		assert.equal((await subscribe(environment(kv))).status, 303);
		const response = await twitchWebhook(
			environment(kv),
			"webhook_callback_verification",
			{
				challenge: "challenge-text",
				subscription: {
					id: "sub-42",
					condition: { broadcaster_user_id: "42" },
				},
			},
		);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "challenge-text");
		assert.match(
			(await kv.get("twitch_channel:42")) as string,
			/"status":"enabled"/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Twitch callback rejects a forged signature without sending Discord", async () => {
	const originalFetch = globalThis.fetch;
	const discordBodies: unknown[] = [];
	globalThis.fetch = fetchMock(discordBodies, []) as typeof fetch;
	try {
		const response = await twitchWebhook(
			environment(new MemoryKv()),
			"notification",
			{
				event: {
					id: "stream-1",
					broadcaster_user_id: "42",
					broadcaster_user_login: "streamer",
				},
			},
			{ signature: "sha256=forged" },
		);
		assert.equal(response.status, 403);
		assert.equal(discordBodies.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Twitch callback rejects a correctly signed event outside its replay window", async () => {
	const originalFetch = globalThis.fetch;
	const discordBodies: unknown[] = [];
	globalThis.fetch = fetchMock(discordBodies, []) as typeof fetch;
	try {
		const response = await twitchWebhook(
			environment(new MemoryKv()),
			"notification",
			{
				event: {
					id: "stream-1",
					broadcaster_user_id: "42",
					broadcaster_user_login: "streamer",
				},
			},
			{ timestamp: new Date(Date.now() - 11 * 60 * 1000).toISOString() },
		);
		assert.equal(response.status, 403);
		assert.equal(discordBodies.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Twitch management rejects cross-origin registration before contacting Twitch", async () => {
	const originalFetch = globalThis.fetch;
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		throw new Error("Twitch must not be contacted");
	}) as typeof fetch;
	try {
		const response = await worker.fetch(
			new Request("https://worker.test/manage/twitch/subscribe", {
				method: "POST",
				headers: {
					Origin: "https://attacker.test",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ login: "streamer" }).toString(),
			}),
			environment(new MemoryKv()) as never,
			{} as never,
		);
		assert.equal(response.status, 403);
		assert.equal(called, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Twitch management records a failed EventSub subscription for operator recovery", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://id.twitch.tv/oauth2/token")
			return Response.json({ access_token: "app-token" });
		if (url === "https://api.twitch.tv/helix/users?login=streamer")
			return Response.json({
				data: [{ id: "42", login: "streamer", display_name: "Streamer" }],
			});
		if (
			url === "https://api.twitch.tv/helix/eventsub/subscriptions" &&
			init?.method === "POST"
		)
			return new Response("unavailable", { status: 503 });
		throw new Error(`Unexpected fetch: ${url}`);
	}) as typeof fetch;
	try {
		assert.equal((await subscribe(environment(kv))).status, 303);
		assert.match(
			(await kv.get("twitch_channel:42")) as string,
			/"status":"error"/,
		);
		assert.equal(await kv.get("twitch_channel_list"), "42");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Twitch stream.online sends Discord only once when EventSub retries the same message", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	const discordBodies: unknown[] = [];
	globalThis.fetch = fetchMock(discordBodies, []) as typeof fetch;
	try {
		await subscribe(environment(kv));
		const payload = {
			event: {
				id: "stream-1",
				broadcaster_user_id: "42",
				broadcaster_user_login: "streamer",
				broadcaster_user_name: "Streamer",
			},
		};
		assert.equal(
			(
				await twitchWebhook(environment(kv), "notification", payload, {
					id: "retry-1",
				})
			).status,
			204,
		);
		assert.equal(
			(
				await twitchWebhook(environment(kv), "notification", payload, {
					id: "retry-1",
				})
			).status,
			204,
		);
		assert.equal(discordBodies.length, 1);
		assert.match(
			JSON.stringify(discordBodies[0]),
			/https:\/\/www\.twitch\.tv\/streamer/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Twitch retries a stream event after Discord rejects the first delivery", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	const failedBodies: unknown[] = [];
	const payload = {
		event: {
			id: "stream-2",
			broadcaster_user_id: "42",
			broadcaster_user_login: "streamer",
		},
	};
	try {
		globalThis.fetch = fetchMock(failedBodies, [], true) as typeof fetch;
		await subscribe(environment(kv));
		assert.equal(
			(
				await twitchWebhook(environment(kv), "notification", payload, {
					id: "retry-after-failure",
				})
			).status,
			500,
		);
		assert.equal(await kv.get("twitch_event:retry-after-failure"), null);

		const successfulBodies: unknown[] = [];
		globalThis.fetch = fetchMock(successfulBodies, []) as typeof fetch;
		assert.equal(
			(
				await twitchWebhook(environment(kv), "notification", payload, {
					id: "retry-after-failure",
				})
			).status,
			204,
		);
		assert.equal(successfulBodies.length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Twitch revocation marks a channel revoked, and management unsubscribe removes its remote subscription", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	const deletedSubscriptions: string[] = [];
	globalThis.fetch = fetchMock([], deletedSubscriptions) as typeof fetch;
	try {
		await subscribe(environment(kv));
		assert.equal(
			(
				await twitchWebhook(environment(kv), "revocation", {
					subscription: {
						id: "sub-42",
						condition: { broadcaster_user_id: "42" },
					},
				})
			).status,
			204,
		);
		assert.match(
			(await kv.get("twitch_channel:42")) as string,
			/"status":"revoked"/,
		);
		const response = await worker.fetch(
			new Request("https://worker.test/manage/twitch/unsubscribe", {
				method: "POST",
				headers: {
					Origin: "https://worker.test",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ broadcasterId: "42" }).toString(),
			}),
			environment(kv) as never,
			{} as never,
		);
		assert.equal(response.status, 303);
		assert.deepEqual(deletedSubscriptions, ["sub-42"]);
		assert.equal(await kv.get("twitch_channel:42"), null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("three-hour reconciliation marks a pending channel enabled when Twitch reports its subscription enabled", async () => {
	const originalFetch = globalThis.fetch;
	const kv = new MemoryKv();
	kv.values.set("twitch_channel_list", "42");
	kv.values.set(
		"twitch_channel:42",
		JSON.stringify({
			broadcasterId: "42",
			login: "streamer",
			displayName: "Streamer",
			subscriptionId: "sub-42",
			status: "pending",
		}),
	);
	globalThis.fetch = (async (input: URL | string) => {
		const url = String(input);
		if (url === "https://id.twitch.tv/oauth2/token")
			return Response.json({ access_token: "app-token" });
		if (
			url ===
			"https://api.twitch.tv/helix/eventsub/subscriptions?type=stream.online"
		)
			return Response.json({
				data: [
					{
						id: "sub-42",
						status: "enabled",
						condition: { broadcaster_user_id: "42" },
						transport: {
							method: "webhook",
							callback: "https://worker.test/webhook/twitch",
						},
					},
				],
			});
		throw new Error(`Unexpected fetch: ${url}`);
	}) as typeof fetch;
	const pending: Promise<unknown>[] = [];
	try {
		await worker.scheduled(
			{ cron: "0 */3 * * *" } as never,
			environment(kv) as never,
			{
				waitUntil: (promise: Promise<unknown>) => pending.push(promise),
			} as never,
		);
		await Promise.all(pending);
		assert.match(
			(await kv.get("twitch_channel:42")) as string,
			/"status":"enabled"/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
