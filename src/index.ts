import { XMLParser } from "fast-xml-parser";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";

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

const app = new Hono<{ Bindings: Bindings }>();

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

app.post("/admin/subscribe/:channelId", async (c) => {
	const channelId = c.req.param("channelId");
	await subscribeChannel(c.env, channelId);

	const list = new Set(
		(await c.env.YT_SUBS.get(CHANNEL_LIST_KEY))?.split(",").filter(Boolean) ??
			[],
	);
	list.add(channelId);
	await c.env.YT_SUBS.put(CHANNEL_LIST_KEY, [...list].join(","));

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

function parseEntries(xml: string): FeedEntry[] {
	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "@_",
	});
	const doc = parser.parse(xml);

	const feed = doc?.feed;
	if (!feed) return [];

	const rawEntries = feed.entry
		? Array.isArray(feed.entry)
			? feed.entry
			: [feed.entry]
		: [];

	return rawEntries.map((e: any) => ({
		videoId: e["yt:videoId"] ?? "",
		channelId: e["yt:channelId"] ?? "",
		title: e.title ?? "",
		author: e.author?.name ?? "",
		link:
			e.link?.["@_href"] ??
			`https://www.youtube.com/watch?v=${e["yt:videoId"] ?? ""}`,
		published: e.published,
		updated: e.updated,
	}));
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
		console.error(
			`[subscribe] failed for ${channelId}: ${res.status} ${await res.text()}`,
		);
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

	await fetch(HUB_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});
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
