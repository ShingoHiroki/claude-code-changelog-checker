# claude-code-changelog-checker

Claude Code (`@anthropic-ai/claude-code`) の新バージョンを自動検知し、リリースノートを日本語訳して Discord / Slack に通知する GitHub Actions ツール。

**Anthropic API キー不要。** 翻訳には「さくらのAI Engine」（さくらインターネットの OpenAI 互換 API）を利用する。

## 機能

- 毎日 JST 8:00 / 12:00 / 18:00 に最新バージョンを自動チェック
- 新バージョン検出時、GitHub Releases のリリースノートを取得
- さくらのAI Engine（gpt-oss-120b）でカテゴリ別本文を日本語翻訳
- 英語ソースから分類した **件数サマリー**（例: `⚡ 改善: 1件 / ➡️ その他: 11件 / 🐛 バグ修正: 12件`）を Embed / Slack の冒頭に表示
- Discord Webhook へ **Embed** で通知（件数サマリー・カテゴリ別フィールド・破壊的変更時は赤色・Release リンク）。失敗時はプレーンテキストにフォールバック
- Slack Webhook へ **Block Kit** で通知（header / 件数サマリー / カテゴリ別 section）。未設定時はスキップ。失敗時はプレーンテキストにフォールバック
- カテゴリ別の変更内容は**全件**掲載（Discord / Slack の1メッセージ上限に応じて field 分割・複数 Embed / 複数投稿）
- 複数バージョンを一度に検知した場合は **古い順** にバージョンごと個別通知

## セットアップ

### 1. リポジトリをフォーク

右上の **Fork** ボタンからこのリポジトリを自分のアカウントへフォークする。

### 2. Webhook URL を取得

**Discord の場合：**
1. 通知を受け取りたい Discord チャンネルの **設定 > 連携サービス > ウェブフック** を開く
2. **新しいウェブフック** を作成し、URL をコピーする

**Slack の場合（任意）：**
1. [Slack API](https://api.slack.com/apps) でアプリを作成し、**Incoming Webhooks** を有効化する
2. 通知先チャンネルの Webhook URL をコピーする

### 3. GitHub Secrets に登録

リポジトリの **Settings > Secrets and variables > Actions** に以下を追加する：

| Secret 名 | 値 | 必須 |
|---|---|---|
| `SAKURA_AI_TOKEN` | さくらのAI Engine のアカウントトークン（翻訳用） | 必須 |
| `DISCORD_WEBHOOK_URL` | Discord の Webhook URL | 必須 |
| `SLACK_WEBHOOK_URL` | Slack の Webhook URL | 任意 |

`GITHUB_TOKEN` は GitHub Actions が自動発行するため、登録不要（GitHub Releases API のレート制限緩和用）。

`SAKURA_AI_TOKEN` はさくらのクラウドのコントロールパネルで発行する。さくらのAI Engine には無料枠（Chat Completions 月3,000リクエスト）があり、この用途であれば無料枠内で運用できる。

### 4. GitHub Actions を有効化

リポジトリの **Actions** タブで、ワークフローを有効化する。

以上で設定完了。翌日 JST 8:00 から自動的にチェックが始まる。

## 手動実行

**Actions > Check Claude Code Changelog > Run workflow** から手動実行できる。

`force_notify: true` を指定すると、前回の検知バージョンをリセットして強制通知できる。（動作確認に便利）

## ローカルでの動作確認

```bash
# 1. .env.example をコピーして値を設定
cp .env.example .env
# .env を開いて SAKURA_AI_TOKEN などを記入

# 2. バージョンをリセット（強制通知）
echo "0.0.0" > state/last-version.txt

# 3. DRY_RUN モードで実行（Discord/Slack に投稿しない、state 更新なし）
DRY_RUN=true npm run check
```

`DRY_RUN=true`（`.env` に書くか環境変数で指定）にすると:
- Discord/Slack への実投稿をスキップ
- `state/last-version.txt` を更新しない
- 検知した各バージョンについて、**Discord Embed / Slack Block Kit 用の JSON ペイロード**を stdout に出力（Webhook に送る内容の確認用）

`SAKURA_AI_TOKEN`（さくらのAI Engine のアカウントトークン）は必須。`GITHUB_TOKEN` は GitHub Releases API のレート制限緩和用で、ローカル実行時は省略可。

## しくみ

```
GitHub Releases API
       ↓ 最新バージョン取得
state/last-version.txt と比較
       ↓ 新バージョンあり
リリースノート取得
       ↓
さくらのAI Engine（gpt-oss-120b）でカテゴリ別本文を日本語翻訳（件数サマリーは英語分類から算出）
       ↓
Discord Webhook へ Embed で通知（失敗時はプレーンテキスト）
       ↓（SLACK_WEBHOOK_URL が設定されていれば）
Slack Webhook へ Block Kit で通知（失敗時はプレーンテキスト）
       ↓
state/last-version.txt を更新・コミット
```

`state/last-version.txt` に最後に検知したバージョンを保存し、GitHub Actions Bot がリポジトリにコミットバックする。初期値 `0.0.0` のときは最新リリース 1 件のみ通知する。

## ファイル構成

```
scripts/check-and-notify.mjs           - メイン処理スクリプト
state/last-version.txt                 - 最後に確認したバージョンの記録
.github/workflows/check-changelog.yml - 自動実行ワークフロー
```

## ライセンス

MIT
