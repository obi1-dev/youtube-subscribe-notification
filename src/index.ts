import { XMLParser } from "fast-xml-parser";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { logger } from "hono/logger";
import { managePage } from "./manage";

type Bindings = {
	YT_SUBS: KVNamespace;
	DISCORD_WEBHOOK_URL: string;
	CALLBACK_BASE_URL: string;
	HUB_SECRET: string;
	ADMIN_TOKEN: string;
};

const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const CALLBACK_PATH = "/webhook/youtube";
const CHANNEL_LIST_KEY = "channel_list";
const CHANNEL_NAME_KEY_PREFIX = "channel_name:";

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

	for (const entry of entries) {
		if (!entry.videoId) continue;

		// 同じ通知の重取り(ハブは再送してくることがある)を除外
		const dedupeKey = `seen:${entry.videoId}:${entry.updated ?? ""}`;
		const alreadyHandled = await c.env.YT_SUBS.get(dedupeKey);
		if (alreadyHandled) continue;
		await c.env.YT_SUBS.put(dedupeKey, "1", {
			expirationTtl: 60 * 60 * 24 * 14,
		});

		// published と updated の差が小さければ「新規投稿」、大きければ「編集」とみなす
		const isNewUpload =
			entry.published && entry.updated
				? Math.abs(
						new Date(entry.updated).getTime() -
							new Date(entry.published).getTime(),
					) <
					5 * 60 * 1000
				: true;

		await notifyDiscord(c.env.DISCORD_WEBHOOK_URL, entry, isNewUpload);
	}

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

// ---------------------------------------------------------------------------
// Discord通知
// ---------------------------------------------------------------------------
async function notifyDiscord(
	webhookUrl: string,
	entry: FeedEntry,
	isNewUpload: boolean,
) {
	const embed = {
		title: entry.title || "(タイトル不明)",
		url: entry.link,
		description: isNewUpload ? "📹 新着動画" : "✏️ 動画情報が更新されました",
		author: { name: entry.author },
		color: isNewUpload ? 0xff0000 : 0x999999,
		thumbnail: { url: `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg` },
	};

	const res = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ embeds: [embed] }),
	});

	if (!res.ok) {
		console.error(`[discord] failed: ${res.status} ${await res.text()}`);
	}
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
// Cron: リース切れ前に全チャンネルを再購読
// ---------------------------------------------------------------------------
export default {
	fetch: app.fetch,
	async scheduled(
		_event: ScheduledEvent,
		env: Bindings,
		ctx: ExecutionContext,
	) {
		const list =
			(await env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ??
			[];
		for (const channelId of list) {
			ctx.waitUntil(subscribeChannel(env, channelId));
		}
	},
};
