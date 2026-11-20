const TWITCH_API = "https://api.twitch.tv/helix";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
export const TWITCH_CALLBACK_PATH = "/webhook/twitch";

const CHANNEL_LIST_KEY = "twitch_channel_list";
const CHANNEL_KEY_PREFIX = "twitch_channel:";
const EVENT_KEY_PREFIX = "twitch_event:";

export type TwitchBindings = {
	YT_SUBS: KVNamespace;
	DISCORD_WEBHOOK_URL: string;
	CALLBACK_BASE_URL: string;
	TWITCH_CLIENT_ID: string;
	TWITCH_CLIENT_SECRET: { get(): Promise<string> };
	TWITCH_EVENTSUB_SECRET: string;
};

export type TwitchChannel = {
	broadcasterId: string;
	login: string;
	displayName: string;
	subscriptionId?: string;
	status: "pending" | "enabled" | "revoked" | "error";
};

type TwitchUser = { id: string; login: string; display_name: string };
type EventSubSubscription = {
	id: string;
	status: string;
	condition: { broadcaster_user_id?: string };
	transport: { method?: string; callback?: string };
};
type EventSubEnvelope = {
	challenge?: string;
	subscription?: EventSubSubscription;
	event?: {
		id?: string;
		broadcaster_user_id?: string;
		broadcaster_user_login?: string;
		broadcaster_user_name?: string;
	};
};

function channelKey(id: string) {
	return `${CHANNEL_KEY_PREFIX}${id}`;
}

function callbackUrl(env: TwitchBindings) {
	return `${env.CALLBACK_BASE_URL}${TWITCH_CALLBACK_PATH}`;
}

function assertEventSubSecret(secret: string) {
	if (!/^[\x20-\x7e]{10,100}$/.test(secret))
		throw new Error(
			"TWITCH_EVENTSUB_SECRET must be an ASCII string between 10 and 100 characters",
		);
}

async function appToken(env: TwitchBindings) {
	const response = await fetch(TWITCH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.TWITCH_CLIENT_ID,
			client_secret: await env.TWITCH_CLIENT_SECRET.get(),
			grant_type: "client_credentials",
		}),
	});
	if (!response.ok)
		throw new Error(`Twitch token request failed: ${response.status}`);
	const body: { access_token?: string } = await response.json();
	if (!body.access_token)
		throw new Error("Twitch token response did not contain an access token");
	return body.access_token;
}

async function api(env: TwitchBindings, path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${await appToken(env)}`);
	headers.set("Client-Id", env.TWITCH_CLIENT_ID);
	return fetch(`${TWITCH_API}${path}`, { ...init, headers });
}

async function apiJson<T>(
	env: TwitchBindings,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await api(env, path, init);
	if (!response.ok)
		throw new Error(
			`Twitch API request failed: ${response.status} ${await response.text()}`,
		);
	return response.json();
}

async function getChannel(env: TwitchBindings, broadcasterId: string) {
	return env.YT_SUBS.get<TwitchChannel>(channelKey(broadcasterId), "json");
}

async function putChannel(env: TwitchBindings, channel: TwitchChannel) {
	await env.YT_SUBS.put(
		channelKey(channel.broadcasterId),
		JSON.stringify(channel),
	);
}

async function channelIds(env: TwitchBindings) {
	return (
		(await env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ?? []
	);
}

async function putChannelIds(env: TwitchBindings, ids: string[]) {
	await env.YT_SUBS.put(CHANNEL_LIST_KEY, ids.join(","));
}

export async function listTwitchChannels(
	env: TwitchBindings,
): Promise<TwitchChannel[]> {
	const channels = await Promise.all(
		(await channelIds(env)).map((id) => getChannel(env, id)),
	);
	return channels.filter(
		(channel): channel is TwitchChannel => channel !== null,
	);
}

export async function resolveTwitchChannel(
	env: TwitchBindings,
	login: string,
): Promise<TwitchUser> {
	const normalized = login
		.trim()
		.replace(/^https?:\/\/(?:www\.)?twitch\.tv\//i, "")
		.replace(/\/$/, "");
	if (!/^[a-zA-Z0-9_]{4,25}$/.test(normalized))
		throw new Error("Invalid Twitch login name");
	const body = await apiJson<{ data?: TwitchUser[] }>(
		env,
		`/users?login=${encodeURIComponent(normalized)}`,
	);
	const user = body.data?.[0];
	if (!user) throw new Error("Twitch channel was not found");
	return user;
}

export async function createTwitchSubscription(
	env: TwitchBindings,
	broadcasterId: string,
) {
	assertEventSubSecret(env.TWITCH_EVENTSUB_SECRET);
	const body = await apiJson<{ data?: EventSubSubscription[] }>(
		env,
		"/eventsub/subscriptions",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "stream.online",
				version: "1",
				condition: { broadcaster_user_id: broadcasterId },
				transport: {
					method: "webhook",
					callback: callbackUrl(env),
					secret: env.TWITCH_EVENTSUB_SECRET,
				},
			}),
		},
	);
	const subscription = body.data?.[0];
	if (!subscription)
		throw new Error("Twitch did not create an EventSub subscription");
	return subscription;
}

export async function subscribeTwitchChannel(
	env: TwitchBindings,
	login: string,
) {
	const user = await resolveTwitchChannel(env, login);
	const existing = await getChannel(env, user.id);
	if (existing?.status === "enabled" || existing?.status === "pending")
		return existing;
	const channel: TwitchChannel = {
		broadcasterId: user.id,
		login: user.login,
		displayName: user.display_name,
		status: "pending",
	};
	// Save first: Twitch may send the verification request before the API response returns.
	await putChannel(env, channel);
	const ids = new Set(await channelIds(env));
	ids.add(user.id);
	await putChannelIds(env, [...ids]);
	try {
		const subscription = await createTwitchSubscription(env, user.id);
		// Preserve a completed challenge for this exact subscription. KV is eventually
		// consistent, so periodic remote reconciliation remains the final authority.
		const afterChallenge = await getChannel(env, user.id);
		const saved =
			afterChallenge?.subscriptionId === subscription.id &&
			afterChallenge.status === "enabled"
				? afterChallenge
				: {
						...channel,
						subscriptionId: subscription.id,
						status:
							subscription.status === "enabled"
								? ("enabled" as const)
								: ("pending" as const),
					};
		await putChannel(env, saved);
		return saved;
	} catch (error) {
		await putChannel(env, { ...channel, status: "error" });
		throw error;
	}
}

export async function unsubscribeTwitchChannel(
	env: TwitchBindings,
	broadcasterId: string,
) {
	const channel = await getChannel(env, broadcasterId);
	if (!channel) return false;
	if (channel.subscriptionId) {
		const response = await api(
			env,
			`/eventsub/subscriptions?id=${encodeURIComponent(channel.subscriptionId)}`,
			{ method: "DELETE" },
		);
		if (!response.ok && response.status !== 404)
			throw new Error(
				`Twitch subscription deletion failed: ${response.status}`,
			);
	}
	await env.YT_SUBS.delete(channelKey(broadcasterId));
	await putChannelIds(
		env,
		(await channelIds(env)).filter((id) => id !== broadcasterId),
	);
	return true;
}

export async function listTwitchSubscriptions(env: TwitchBindings) {
	const subscriptions: EventSubSubscription[] = [];
	let after: string | undefined;
	do {
		const body = await apiJson<{
			data?: EventSubSubscription[];
			pagination?: { cursor?: string };
		}>(
			env,
			`/eventsub/subscriptions?type=stream.online${after ? `&after=${encodeURIComponent(after)}` : ""}`,
		);
		subscriptions.push(...(body.data ?? []));
		after = body.pagination?.cursor;
	} while (after);
	return subscriptions;
}

export async function refreshTwitchSubscriptions(env: TwitchBindings) {
	const remote = await listTwitchSubscriptions(env);
	const byBroadcaster = new Map<string, EventSubSubscription>();
	for (const subscription of remote) {
		const broadcasterId = subscription.condition.broadcaster_user_id;
		if (
			!broadcasterId ||
			subscription.transport.method !== "webhook" ||
			subscription.transport.callback !== callbackUrl(env)
		)
			continue;
		if (
			subscription.status !== "enabled" &&
			subscription.status !== "webhook_callback_verification_pending"
		)
			continue;
		const current = byBroadcaster.get(broadcasterId);
		if (!current || subscription.status === "enabled")
			byBroadcaster.set(broadcasterId, subscription);
	}
	for (const channel of await listTwitchChannels(env)) {
		const subscription = byBroadcaster.get(channel.broadcasterId);
		if (subscription) {
			const status = subscription.status === "enabled" ? "enabled" : "pending";
			if (
				channel.subscriptionId !== subscription.id ||
				channel.status !== status
			)
				await putChannel(env, {
					...channel,
					subscriptionId: subscription.id,
					status,
				});
			continue;
		}
		try {
			const replacement = await createTwitchSubscription(
				env,
				channel.broadcasterId,
			);
			await putChannel(env, {
				...channel,
				subscriptionId: replacement.id,
				status: replacement.status === "enabled" ? "enabled" : "pending",
			});
		} catch (error) {
			console.error(`[twitch] could not restore ${channel.login}`, error);
			await putChannel(env, { ...channel, status: "error" });
		}
	}
}

function secureEqual(left: string, right: string) {
	if (left.length !== right.length) return false;
	let result = 0;
	for (let i = 0; i < left.length; i++)
		result |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return result === 0;
}

async function signature(secret: string, message: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
	);
	return `sha256=${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyTwitchEvent(
	request: Request,
	body: string,
	secret: string,
) {
	const id = request.headers.get("Twitch-Eventsub-Message-Id");
	const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp");
	const receivedSignature = request.headers.get(
		"Twitch-Eventsub-Message-Signature",
	);
	if (!id || !timestamp || !receivedSignature || !secret) return false;
	const sentAt = Date.parse(timestamp);
	if (Number.isNaN(sentAt) || Math.abs(Date.now() - sentAt) > 10 * 60 * 1000)
		return false;
	return secureEqual(
		await signature(secret, `${id}${timestamp}${body}`),
		receivedSignature,
	);
}

async function notifyTwitchLive(
	env: TwitchBindings,
	event: NonNullable<EventSubEnvelope["event"]>,
) {
	if (!event.id || !event.broadcaster_user_login)
		throw new Error("Twitch stream.online event is missing required fields");
	const response = await fetch(env.DISCORD_WEBHOOK_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			embeds: [
				{
					title: `${event.broadcaster_user_name ?? event.broadcaster_user_login} が配信を開始しました`,
					url: `https://www.twitch.tv/${event.broadcaster_user_login}`,
					description: "🟣 Twitch ライブ配信中",
					color: 0x9146ff,
				},
			],
		}),
	});
	if (!response.ok)
		throw new Error(`Discord webhook failed: ${response.status}`);
}

export type TwitchWebhookResult = { status: number; body: string };

export async function handleTwitchWebhook(
	env: TwitchBindings,
	request: Request,
): Promise<TwitchWebhookResult> {
	const body = await request.text();
	if (!(await verifyTwitchEvent(request, body, env.TWITCH_EVENTSUB_SECRET)))
		return { status: 403, body: "invalid signature" };
	let payload: EventSubEnvelope;
	try {
		payload = JSON.parse(body);
	} catch {
		return { status: 400, body: "invalid JSON" };
	}
	const type = request.headers.get("Twitch-Eventsub-Message-Type");
	const messageId = request.headers.get("Twitch-Eventsub-Message-Id");
	if (!messageId) return { status: 403, body: "missing message ID" };
	if (type === "webhook_callback_verification") {
		const subscription = payload.subscription;
		if (subscription?.condition.broadcaster_user_id) {
			const channel = await getChannel(
				env,
				subscription.condition.broadcaster_user_id,
			);
			if (channel)
				await putChannel(env, {
					...channel,
					subscriptionId: subscription.id,
					status: "enabled",
				});
		}
		return typeof payload.challenge === "string"
			? { status: 200, body: payload.challenge }
			: { status: 400, body: "missing challenge" };
	}
	if (type === "revocation") {
		const subscription = payload.subscription;
		const broadcasterId = subscription?.condition.broadcaster_user_id;
		if (broadcasterId && subscription) {
			const channel = await getChannel(env, broadcasterId);
			// An old subscription may be revoked after a replacement is active.
			if (channel?.subscriptionId === subscription.id)
				await putChannel(env, { ...channel, status: "revoked" });
		}
		return { status: 204, body: "" };
	}
	if (
		type !== "notification" ||
		request.headers.get("Twitch-Eventsub-Subscription-Type") !== "stream.online"
	)
		return { status: 204, body: "" };
	if (await env.YT_SUBS.get(`${EVENT_KEY_PREFIX}${messageId}`))
		return { status: 204, body: "" };
	const event = payload.event;
	if (
		!event?.broadcaster_user_id ||
		!(await getChannel(env, event.broadcaster_user_id))
	)
		return { status: 204, body: "" };
	await notifyTwitchLive(env, event);
	await env.YT_SUBS.put(`${EVENT_KEY_PREFIX}${messageId}`, "1", {
		expirationTtl: 60 * 60 * 24,
	});
	return { status: 204, body: "" };
}
