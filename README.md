# claude-code-changelog-checker

Claude Code (`@anthropic-ai/claude-code`) の新バージョンを自動検知し、リリースノートを日本語訳して Discord / Slack に通知する GitHub Actions ツール。

**Anthropic API キー不要。** GitHub の無料機能だけで動作する。

## 機能

- 毎日 JST 8:00 / 12:00 / 18:00 に最新バージョンを自動チェック
- 新バージョン検出時、GitHub Releases のリリースノートを取得
- GitHub Models API（gpt-4o-mini）で日本語翻訳
- Discord Webhook へ通知（2000 文字制限に対応した自動分割）
- Slack Webhook へも通知（`SLACK_WEBHOOK_URL` を設定した場合のみ）

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
| `DISCORD_WEBHOOK_URL` | Discord の Webhook URL | 必須 |
| `SLACK_WEBHOOK_URL` | Slack の Webhook URL | 任意 |

`GITHUB_TOKEN` は GitHub Actions が自動発行するため、登録不要。

### 4. GitHub Actions を有効化

リポジトリの **Actions** タブで、ワークフローを有効化する。

以上で設定完了。翌日 JST 8:00 から自動的にチェックが始まる。

## 手動実行

**Actions > Check Claude Code Changelog > Run workflow** から手動実行できる。

`force_notify: true` を指定すると、前回の検知バージョンをリセットして強制通知できる。（動作確認に便利）

## ローカルでの動作確認

```bash
export GITHUB_TOKEN=your_github_personal_access_token
export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...  # 任意

npm run check
```

`GITHUB_TOKEN` には **GitHub Models** の利用権限が必要（通常の Personal Access Token で利用可能）。

## しくみ

```
GitHub Releases API
       ↓ 最新バージョン取得
state/last-version.txt と比較
       ↓ 新バージョンあり
リリースノート取得
       ↓
GitHub Models API（gpt-4o-mini）で日本語翻訳
       ↓
Discord Webhook へ通知
       ↓（SLACK_WEBHOOK_URL が設定されていれば）
Slack Webhook へ通知
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
