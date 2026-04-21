# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Claude Code (`@anthropic-ai/claude-code`) の npm 新バージョンを検知し、リリースノートを GitHub Models API（gpt-4o-mini）で日本語翻訳して Discord（Embed）/ Slack（Block Kit）に通知する GitHub Actions 自動化ツール。Anthropic API キー不要。

## コマンド

```bash
npm install          # 依存関係インストール
npm run check        # ローカルでの動作確認（環境変数が必要）
```

ローカル実行時は `.env.example` をコピーして `.env` を作成し、値を記入すること:
- `GITHUB_TOKEN` - GitHub Personal Access Token（GitHub Models 利用権限が必要）
- `DISCORD_WEBHOOK_URL` - Discord Webhook URL
- `SLACK_WEBHOOK_URL` - Slack Webhook URL（省略可。設定時のみ通知）
- `DRY_RUN` - `true` にすると Discord/Slack に投稿せず stdout に出力（省略可）

## アーキテクチャ

```
scripts/check-and-notify.mjs  - メイン処理スクリプト（ESM）
state/last-version.txt        - 最後に確認したバージョンの記録
.github/workflows/check-changelog.yml  - 毎日 JST 8:00 / 12:00 / 18:00 に自動実行
```

### 処理フロー

1. GitHub Releases API から最新バージョンを取得
2. `state/last-version.txt` と比較して差分があるか確認
3. 新バージョンがある場合、未取得分のリリース（`body` 等）を取得（複数件は古い順に処理）
4. `categorizeAndGroup()` で箇条書きを 破壊的変更/新機能/改善/その他/バグ修正 に分類
5. `buildGroupedText()` でカテゴリ別に整形した英語テキストを生成
6. GitHub Models API (`gpt-4o-mini`) でカテゴリ別本文を日本語翻訳（英語分類から算出した **件数サマリー** `⚡ 改善: 1件 / …` を通知の説明欄に表示）
7. カテゴリ別の箇条書きを**全件**通知（Discord は field / 複数 Embed に分割、Slack は section 分割・50 ブロック超は複数投稿）
8. **Discord** は Embed（件数サマリー・カテゴリ別フィールド・色分け・リンク）、**Slack** は Block Kit（header / 件数サマリー section / divider / カテゴリ）。送信失敗時は従来のプレーンテキストにフォールバック
9. `DRY_RUN=true` のときは Webhook 送信と state 更新を行わず、Discord/Slack 用 JSON ペイロードを stdout に出力
10. 全リリースの通知が成功した後、`state/last-version.txt` を更新し git commit/push

### 状態管理

`state/last-version.txt` に最後に検知したバージョンを保存し、GitHub Actions Bot がリポジトリにコミットバックする。初期値は `0.0.0`（初回実行時は最新バージョンのエントリのみ通知）。

## GitHub Actions のセットアップ

リポジトリの **Settings > Secrets and variables > Actions** に以下を登録:

| Secret 名 | 内容 |
|-----------|------|
| `DISCORD_WEBHOOK_URL` | Discord チャンネルの Webhook URL |
| `SLACK_WEBHOOK_URL` | Slack チャンネルの Webhook URL（省略可） |

`GITHUB_TOKEN` は GitHub Actions が自動発行するため、Secret 登録不要。

`workflow_dispatch` で手動実行可能。`force_notify: true` を指定すると前回バージョンをリセットして強制通知できる。

## CLAUDE.md修正方針
- 他ファイルに修正が入った時に、CLAUDE.mdとREADMEにも反映が必要かをチェックして必要なら反映してください。

## Gitのルール
- コミットの際は日本語でわかりやすく簡潔に記載してください。