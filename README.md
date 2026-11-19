# YouTube 通知

YouTube チャンネルの動画更新を Discord に通知する Cloudflare Worker です。

## 管理画面と Access

管理画面は `https://yt.obi1.dev/manage/` です。チャンネル ID（`UC` から始まる 24 文字）で追加・解除できます。購読はハブへのリクエストが受理された後、確認が非同期で行われます。

**デプロイ前に Cloudflare Access の Self-hosted アプリケーションを設定してください。** 管理画面自体に認証はなく、Access の設定がない状態では誰でも操作できます。`yt.obi1.dev/manage` と `yt.obi1.dev/manage/*` の両方を保護するようパスを設定し、許可するユーザーのポリシーを追加してください。設定後は未認証で画面と POST が拒否されることを確認してください。Access が適用されない別の Worker ルートを追加しないでください。workers.dev とプレビュー URL は無効にしています。

YouTube ハブが利用する `GET` / `POST /webhook/youtube` は Access で保護しないでください。既存の `/admin/*` API は引き続き `Authorization: Bearer <ADMIN_TOKEN>` で保護されます。詳細は [Cloudflare Access の設定](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)を参照してください。

KV の一覧は同時更新時に競合する可能性があるため、管理操作は同時に行わないでください。

## 開発

```sh
pnpm install
pnpm dev
pnpm check
pnpm typecheck
pnpm deploy
```

KV と `DISCORD_WEBHOOK_URL`、`CALLBACK_BASE_URL`、`HUB_SECRET`、`ADMIN_TOKEN` の各シークレットを環境に設定してください。`CALLBACK_BASE_URL` は末尾のスラッシュを除いた公開オリジンです。YouTube Data API v3 のキーは `wrangler.jsonc` で指定した Secrets Store の `YOUTUBE_DATA_API_KEY` から取得します。Secret には Workers スコープが必要です。

通常動画の投稿、ライブ配信予定、ライブ配信開始を Discord に通知します。タイトルや説明の更新は通知しません。配信予定は1分ごとに確認するため、開始通知には遅延が生じる場合があります。YouTube のプッシュ通知や API の取得状況によっては検知できない場合もあります。チャンネルの購読更新は3時間ごとに行います。
