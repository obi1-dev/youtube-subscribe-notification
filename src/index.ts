import { XMLParser } from "fast-xml-parser";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { logger } from "hono/logger";
import { managePage } from "./manage.ts";

type Bindings = {
	YT_SUBS: KVNamespace;
	DISCORD_WEBHOOK_URL: string;
	CALLBACK_BASE_URL: string;
	HUB_SECRET: string;
	ADMIN_TOKEN: string;
	YOUTUBE_DATA_API_KEY: { get(): Promise<string> };
};

const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const CALLBACK_PATH = "/webhook/youtube";
const CHANNEL_LIST_KEY = "channel_list";
const CHANNEL_NAME_KEY_PREFIX = "channel_name:";
const PENDING_LIVE_KEY_PREFIX = "pending_live:";
const NOTIFIED_KEY_PREFIX = "notified:";

const app = new Hono<{ Bindings: Bindings }>();
app.use(logger());

function topicUrl(channelId: string) {
	return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

// ---------------------------------------------------------------------------
// GET: 購読確認(hub.challengeをそのまま返すだけ)
// ---------------------------------------------------------------------------
app.get(CALLBACK_PATH, (c) => {
	const mode = c.req.query("hub.mode");
	const topic = c.req.query("hub.topic");
	const challenge = c.req.query("hub.challenge");
	const lease = c.req.query("hub.lease_seconds");

	if (!challenge) {
		return c.text("missing hub.challenge", 400);
	}

	console.log(`[verify] mode=${mode} topic=${topic} lease=${lease}`);
	// ハブはここで200 + challenge文字列そのままのレスポンスを期待している
	return c.text(challenge, 200);
});

// ---------------------------------------------------------------------------
// POST: 通知本体(Atom XML)を受信
// ---------------------------------------------------------------------------
app.post(CALLBACK_PATH, async (c) => {
	const bodyText = await c.req.text();
	const signature = c.req.header("X-Hub-Signature"); // 例: "sha1=xxxxx"

	if (c.env.HUB_SECRET) {
		const ok = await verifySignature(bodyText, signature, c.env.HUB_SECRET);
		if (!ok) {
			console.warn("[notify] invalid signature, rejecting");
			return c.text("invalid signature", 403);
		}
	}

	const entries = parseEntries(bodyText);

	for (const entry of entries) await handleFeedEntry(c.env, entry);

	return c.text("OK", 200);
});

// ---------------------------------------------------------------------------
// 手動で購読チャンネルを追加/削除するための簡易API
// Authorization: Bearer <ADMIN_TOKEN> が一致しないと 401 を返す
// ---------------------------------------------------------------------------
app.use("/admin/*", async (c, next) => {
	if (!c.env.ADMIN_TOKEN) {
		// Secret未設定のまま公開されるのを防ぐフェイルセーフ
		return c.text("ADMIN_TOKEN is not configured", 500);
	}
	const auth = bearerAuth<{ Bindings: Bindings }>({
		verifyToken: async (token, ctx) => token === ctx.env.ADMIN_TOKEN,
	});
	return auth(c, next);
});

app.get("/admin/channels", async (c) => {
	const list =
		(await c.env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ??
		[];

	const channels = await Promise.all(
		list.map(async (channelId) => ({
			channelId,
			channelName: await getChannelName(c.env, channelId),
		})),
	);

	return c.json(channels);
});

app.post("/admin/subscribe/:channelId", async (c) => {
	const channelId = c.req.param("channelId");
	await subscribeChannel(c.env, channelId);

	const list = new Set(
		(await c.env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ??
			[],
	);
	list.add(channelId);
	await c.env.YT_SUBS.put(CHANNEL_LIST_KEY, [...list].join(","));
	await getChannelName(c.env, channelId);

	return c.text(`subscribed: ${channelId}`);
});

app.post("/admin/unsubscribe/:channelId", async (c) => {
	const channelId = c.req.param("channelId");
	await unsubscribeChannel(c.env, channelId);

	const list = new Set(
		(await c.env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ??
			[],
	);
	list.delete(channelId);
	await c.env.YT_SUBS.put(CHANNEL_LIST_KEY, [...list].join(","));

	return c.text(`unsubscribed: ${channelId}`);
});

// /manage/ は Cloudflare Access による保護を前提とする。
app.get("/manage", (c) => c.redirect("/manage/"));
app.get("/manage/", async (c) => {
	const list =
		(await c.env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ??
		[];
	const channels = await Promise.all(
		list.map(async (channelId) => ({
			channelId,
			channelName: await getChannelName(c.env, channelId),
		})),
	);
	const messages: Record<string, string> = {
		added: "購読リクエストを送信しました。",
		removed: "購読解除リクエストを送信しました。",
		invalid: "正しいチャンネル ID を入力してください。",
		failed:
			"ハブへのリクエストに失敗しました。時間をおいて再度お試しください。",
	};
	const status = c.req.query("status") ?? "";
	c.header("Cache-Control", "no-store");
	return c.html(
		managePage(
			channels,
			messages[status],
			status === "invalid" || status === "failed",
		),
	);
});

app.post("/manage/:action", async (c) => {
	// Cookie を使う Access セッションに対するクロスサイト送信を防ぐ。
	if (c.req.header("Origin") !== new URL(c.req.url).origin)
		return c.text("Forbidden", 403);
	const action = c.req.param("action");
	if (action !== "subscribe" && action !== "unsubscribe") return c.notFound();
	const body = await c.req.parseBody();
	const channelId =
		typeof body.channelId === "string" ? body.channelId.trim() : "";
	if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId))
		return c.redirect("/manage/?status=invalid", 303);
	try {
		const list = new Set(
			(await c.env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ??
				[],
		);
		if (action === "subscribe") {
			await subscribeChannel(c.env, channelId);
			list.add(channelId);
		} else {
			await unsubscribeChannel(c.env, channelId);
			list.delete(channelId);
		}
		await c.env.YT_SUBS.put(CHANNEL_LIST_KEY, [...list].join(","));
		if (action === "subscribe") await getChannelName(c.env, channelId);
		return c.redirect(
			`/manage/?status=${action === "subscribe" ? "added" : "removed"}`,
			303,
		);
	} catch (error) {
		console.error("[manage] request failed", error);
		return c.redirect("/manage/?status=failed", 303);
	}
});

// ---------------------------------------------------------------------------
// XMLパース(fast-xml-parserはWorkers環境でも依存なしで動く)
// ---------------------------------------------------------------------------
type FeedEntry = {
	videoId: string;
	channelId: string;
	title: string;
	author: string;
	link: string;
	published?: string;
	updated?: string;
};

type XmlRecord = Record<string, unknown>;

function isXmlRecord(value: unknown): value is XmlRecord {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseEntries(xml: string): FeedEntry[] {
	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "@_",
	});
	const doc: unknown = parser.parse(xml);
	if (!isXmlRecord(doc) || !isXmlRecord(doc.feed)) return [];

	const rawEntries = doc.feed.entry
		? Array.isArray(doc.feed.entry)
			? doc.feed.entry
			: [doc.feed.entry]
		: [];

	return rawEntries.filter(isXmlRecord).map((entry) => {
		const videoId = stringValue(entry["yt:videoId"]) ?? "";
		const author = isXmlRecord(entry.author)
			? (stringValue(entry.author.name) ?? "")
			: "";
		const link = isXmlRecord(entry.link)
			? stringValue(entry.link["@_href"])
			: undefined;

		return {
			videoId,
			channelId: stringValue(entry["yt:channelId"]) ?? "",
			title: stringValue(entry.title) ?? "",
			author,
			link: link ?? `https://www.youtube.com/watch?v=${videoId}`,
			published: stringValue(entry.published),
			updated: stringValue(entry.updated),
		};
	});
}

// ---------------------------------------------------------------------------
// HMAC-SHA1署名検証(hub.secretを指定して購読した場合のみ付与される)
// ---------------------------------------------------------------------------
async function verifySignature(
	body: string,
	header: string | undefined,
	secret: string,
): Promise<boolean> {
	if (!header) return false;
	const [algo, sigHex] = header.split("=");
	if (algo !== "sha1" || !sigHex) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["verify"],
	);

	const sigBytes = new Uint8Array(
		sigHex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [],
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		sigBytes,
		new TextEncoder().encode(body),
	);
}

type YouTubeVideo = {
	id: string;
	snippet: {
		title: string;
		channelTitle: string;
		liveBroadcastContent: "live" | "upcoming" | "none";
	};
	liveStreamingDetails?: { scheduledStartTime?: string };
};

type NotificationKind = "video" | "scheduled" | "live";

async function handleFeedEntry(env: Bindings, entry: FeedEntry) {
	if (!entry.videoId) return;
	const video = await getYouTubeVideo(env, entry.videoId);
	if (!video) return;

	if (video.snippet.liveBroadcastContent === "live") {
		await notifyOnce(env, video, "live");
		await removePendingLive(env, entry.videoId);
		return;
	}
	if (video.snippet.liveBroadcastContent === "upcoming") {
		await addPendingLive(env, entry.videoId);
		await notifyOnce(env, video, "scheduled");
		return;
	}

	// 終了済みライブは liveStreamingDetails が残るため、通常動画として通知しない。
	if (video.liveStreamingDetails) return;
	// ハブはタイトル・説明の編集でも通知する。初回投稿時の通知だけを送る。
	if (isInitialPublication(entry)) await notifyOnce(env, video, "video");
}

function isInitialPublication(entry: FeedEntry) {
	if (!entry.published || !entry.updated) return true;
	return (
		Math.abs(
			new Date(entry.updated).getTime() - new Date(entry.published).getTime(),
		) <
		5 * 60 * 1000
	);
}

async function getYouTubeVideo(
	env: Bindings,
	videoId: string,
): Promise<YouTubeVideo | null> {
	return (await getYouTubeVideos(env, [videoId]))[0] ?? null;
}

async function getYouTubeVideos(
	env: Bindings,
	videoIds: string[],
): Promise<YouTubeVideo[]> {
	if (videoIds.length === 0) return [];
	const apiKey = await env.YOUTUBE_DATA_API_KEY.get();
	const url = new URL("https://www.googleapis.com/youtube/v3/videos");
	url.search = new URLSearchParams({
		part: "snippet,liveStreamingDetails",
		id: videoIds.join(","),
		key: apiKey,
	}).toString();
	const res = await fetch(url);
	if (!res.ok) {
		console.error(`[youtube] failed: ${res.status} ${await res.text()}`);
		throw new Error(`YouTube Data API failed: ${res.status}`);
	}
	const data: { items?: YouTubeVideo[] } = await res.json();
	return data.items ?? [];
}

async function notifyOnce(
	env: Bindings,
	video: YouTubeVideo,
	kind: NotificationKind,
) {
	const key = `${NOTIFIED_KEY_PREFIX}${kind}:${video.id}`;
	if (await env.YT_SUBS.get(key)) return;
	await notifyDiscord(env.DISCORD_WEBHOOK_URL, video, kind);
	await env.YT_SUBS.put(key, "1", { expirationTtl: 60 * 60 * 24 * 90 });
}

// ---------------------------------------------------------------------------
// Discord通知
// ---------------------------------------------------------------------------
async function notifyDiscord(
	webhookUrl: string,
	video: YouTubeVideo,
	kind: NotificationKind,
) {
	const labels: Record<
		NotificationKind,
		{ description: string; color: number }
	> = {
		video: { description: "📹 新着動画", color: 0xff0000 },
		scheduled: { description: "📅 ライブ配信予定", color: 0x3498db },
		live: { description: "🔴 ライブ配信中", color: 0xe74c3c },
	};
	const label = labels[kind];
	const embed = {
		title: video.snippet.title || "(タイトル不明)",
		url: `https://www.youtube.com/watch?v=${video.id}`,
		description:
			kind === "scheduled" && video.liveStreamingDetails?.scheduledStartTime
				? `${label.description}\n開始予定: <t:${Math.floor(new Date(video.liveStreamingDetails.scheduledStartTime).getTime() / 1000)}:F>`
				: label.description,
		author: { name: video.snippet.channelTitle },
		color: label.color,
		thumbnail: { url: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` },
	};

	const res = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ embeds: [embed] }),
	});

	if (!res.ok) {
		const body = await res.text();
		console.error(`[discord] failed: ${res.status} ${body}`);
		throw new Error(`Discord webhook failed: ${res.status}`);
	}
}

async function addPendingLive(env: Bindings, videoId: string) {
	await env.YT_SUBS.put(`${PENDING_LIVE_KEY_PREFIX}${videoId}`, "1");
}

async function removePendingLive(env: Bindings, videoId: string) {
	await env.YT_SUBS.delete(`${PENDING_LIVE_KEY_PREFIX}${videoId}`);
}

async function checkPendingLives(env: Bindings) {
	let cursor: string | undefined;
	do {
		const page = await env.YT_SUBS.list({
			prefix: PENDING_LIVE_KEY_PREFIX,
			cursor,
		});
		for (let start = 0; start < page.keys.length; start += 50) {
			const videoIds = page.keys
				.slice(start, start + 50)
				.map((key) => key.name.slice(PENDING_LIVE_KEY_PREFIX.length));
			try {
				const videos = await getYouTubeVideos(env, videoIds);
				const byId = new Map(videos.map((video) => [video.id, video]));
				for (const videoId of videoIds) {
					const video = byId.get(videoId);
					if (!video || video.snippet.liveBroadcastContent === "none") {
						await removePendingLive(env, videoId);
						continue;
					}
					if (video.snippet.liveBroadcastContent !== "live") continue;
					try {
						await notifyOnce(env, video, "live");
						await removePendingLive(env, videoId);
					} catch (error) {
						console.error(`[live] notification failed for ${videoId}`, error);
					}
				}
			} catch (error) {
				console.error("[live] status check failed", error);
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
}

// ---------------------------------------------------------------------------
// チャンネル名の取得(YouTubeの動画フィードXMLから、KVにキャッシュ)
// ---------------------------------------------------------------------------
async function getChannelName(
	env: Bindings,
	channelId: string,
): Promise<string | null> {
	const cacheKey = `${CHANNEL_NAME_KEY_PREFIX}${channelId}`;
	const cached = await env.YT_SUBS.get(cacheKey);
	if (cached) return cached;

	const name = await fetchChannelName(channelId);
	if (name) {
		await env.YT_SUBS.put(cacheKey, name);
	}
	return name;
}

async function fetchChannelName(channelId: string): Promise<string | null> {
	try {
		// topicUrl() はハブ用の静的なトピック記述ファイルで、
		// <title>が常に "YouTube video feed" 固定なのでチャンネル名の取得には使えない
		const res = await fetch(
			`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
		);
		if (!res.ok) return null;

		const parser = new XMLParser();
		const doc = parser.parse(await res.text());
		const title = doc?.feed?.title;
		return typeof title === "string" && title ? title : null;
	} catch (err) {
		console.error(`[channel-name] failed to fetch for ${channelId}:`, err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// ハブへの購読/解除リクエスト
// ---------------------------------------------------------------------------
async function subscribeChannel(env: Bindings, channelId: string) {
	const params = new URLSearchParams({
		"hub.mode": "subscribe",
		"hub.topic": topicUrl(channelId),
		"hub.callback": `${env.CALLBACK_BASE_URL}${CALLBACK_PATH}`,
		"hub.lease_seconds": String(60 * 60 * 24 * 5), // 5日を希望(実際の付与値はハブ側が決定)
	});
	if (env.HUB_SECRET) params.set("hub.secret", env.HUB_SECRET);

	const res = await fetch(HUB_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!res.ok) {
		throw new Error(`[subscribe] failed for ${channelId}: ${res.status}`);
	} else {
		console.log(`[subscribe] requested for ${channelId}`);
	}
}

async function unsubscribeChannel(env: Bindings, channelId: string) {
	const params = new URLSearchParams({
		"hub.mode": "unsubscribe",
		"hub.topic": topicUrl(channelId),
		"hub.callback": `${env.CALLBACK_BASE_URL}${CALLBACK_PATH}`,
	});

	const res = await fetch(HUB_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});
	if (!res.ok)
		throw new Error(`[unsubscribe] failed for ${channelId}: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Cron: 毎分のライブ開始確認と、3時間ごとの購読リース更新
// ---------------------------------------------------------------------------
export default {
	fetch: app.fetch,
	async scheduled(
		_event: ScheduledEvent,
		env: Bindings,
		ctx: ExecutionContext,
	) {
		if (_event.cron === "* * * * *") {
			ctx.waitUntil(checkPendingLives(env));
			return;
		}

		const list =
			(await env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ??
			[];
		for (const channelId of list) {
			ctx.waitUntil(subscribeChannel(env, channelId));
		}
	},
};
