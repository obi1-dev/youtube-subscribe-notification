import { html } from "hono/html";

export type Channel = { channelId: string; channelName: string | null };
export type TwitchChannel = {
	broadcasterId: string;
	login: string;
	displayName: string;
	status: string;
	error?: string;
};

export function managePage(
	channels: Channel[],
	message?: string,
	error = false,
	twitchChannels: TwitchChannel[] = [],
) {
	return html`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>チャンネル管理</title><style>
:root{font-family:Inter,"Noto Sans JP",system-ui,-apple-system,sans-serif;color:#222322;background:#fff}*{box-sizing:border-box}body{margin:0}main{max-width:768px;margin:auto;padding:64px 24px}header{padding-bottom:32px;border-bottom:1px solid #d4d9dc}.eyebrow{color:#39566b;font-weight:700;font-size:13px;letter-spacing:.04em}h1{font-size:28px;line-height:1.4;margin:12px 0}p{color:#505b60;line-height:1.85}.card{padding:32px 0;border-bottom:1px solid #d4d9dc}h2{font-size:18px;line-height:1.5;margin:0 0 8px}.description{font-size:14px;margin:0 0 24px}label{display:block;font-size:14px;font-weight:600;margin-bottom:8px}.add{display:flex;gap:8px}input{min-width:0;flex:1;border:1px solid #78868d;border-radius:4px;padding:10px 12px;font:inherit;color:inherit;background:#fff;min-height:44px}button{border:1px solid #39566b;border-radius:4px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer;background:#39566b;color:#fff;min-height:44px}button:hover{background:#2d4556}.delete{color:#82332d;background:#fff;border-color:#a85e57;white-space:nowrap}.delete:hover{color:#fff;background:#82332d}button:focus-visible,input:focus-visible{outline:3px solid #39566b;outline-offset:3px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-top:1px solid #d4d9dc}.name{font-weight:600;overflow-wrap:anywhere}.id{font-size:13px;color:#505b60;overflow-wrap:anywhere;margin-top:4px}.notice{padding:12px 16px;border-left:3px solid ${error ? "#a32c25" : "#39566b"};background:${error ? "#fdf2f1" : "#f1f5f7"};color:#222322}.empty{padding:16px 0;color:#505b60}@media(max-width:520px){main{padding:40px 16px}.add{flex-direction:column}.row{align-items:flex-start}}
</style></head><body><main><header><div class="eyebrow">STREAM NOTIFICATIONS</div><h1>チャンネル管理</h1><p>YouTube 動画と Twitch 配信開始の通知を受け取るチャンネルを管理します。</p></header>
${message ? html`<p class="notice" role="status">${message}</p>` : ""}
<section class="card"><h2>チャンネルを追加</h2><p class="description">YouTube のチャンネル ID を入力してください。</p><form method="post" action="/manage/subscribe"><label for="channelId">チャンネル ID</label><div class="add"><input id="channelId" name="channelId" placeholder="UC..." required pattern="UC[A-Za-z0-9_-]{22}" title="UC から始まる24文字のチャンネル ID" autocomplete="off"><button type="submit">追加する</button></div></form></section>
<section class="card"><h2>登録チャンネル <span style="color:#505b60;font-weight:400">${channels.length}</span></h2><p class="description">登録したチャンネルの更新を Discord に通知します。</p>
${channels.length ? channels.map((channel) => html`<div class="row"><div><div class="name">${channel.channelName || "名前を取得できませんでした"}</div><div class="id">${channel.channelId}</div></div><form method="post" action="/manage/unsubscribe" onsubmit="return confirm('このチャンネルの登録を解除しますか？')"><input type="hidden" name="channelId" value="${channel.channelId}"><button class="delete" type="submit">解除</button></form></div>`) : html`<div class="empty">登録されているチャンネルはありません。</div>`}</section>
<section class="card"><h2>Twitch チャンネルを追加</h2><p class="description">Twitch のチャンネル名またはチャンネル URL を入力してください。</p><form method="post" action="/manage/twitch/subscribe"><label for="twitchLogin">チャンネル名または URL</label><div class="add"><input id="twitchLogin" name="login" placeholder="twitch.tv/example または example" required autocomplete="off"><button type="submit">追加する</button></div></form></section>
<section class="card"><h2>登録 Twitch チャンネル <span style="color:#505b60;font-weight:400">${twitchChannels.length}</span></h2><p class="description">配信開始を Discord に通知します。</p>
${twitchChannels.length ? twitchChannels.map((channel) => html`<div class="row"><div><div class="name">${channel.displayName}</div><div class="id">twitch.tv/${channel.login} · ${twitchStatusLabel(channel.status)}${channel.error ? ` · ${channel.error}` : ""}</div></div><form method="post" action="/manage/twitch/unsubscribe" onsubmit="return confirm('この Twitch チャンネルの登録を解除しますか？')"><input type="hidden" name="broadcasterId" value="${channel.broadcasterId}"><button class="delete" type="submit">解除</button></form></div>`) : html`<div class="empty">登録されている Twitch チャンネルはありません。</div>`}</section></main></body></html>`;
}

function twitchStatusLabel(status: string) {
	return (
		{
			pending: "確認待ち",
			enabled: "有効",
			revoked: "無効（再登録が必要）",
			failed: "登録に失敗しました",
		}[status] ?? status
	);
}
