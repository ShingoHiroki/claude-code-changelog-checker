# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Claude Code (`@anthropic-ai/claude-code`) の npm 新バージョンを検知し、リリースノートを「さくらのAI Engine」（さくらインターネットの OpenAI 互換 API、gpt-oss-120b）で日本語翻訳して Discord（Embed）/ Slack（Block Kit）に通知する GitHub Actions 自動化ツール。Anthropic API キー不要。

## コマンド

```bash
npm install          # 依存関係インストール
npm run check        # ローカルでの動作確認（環境変数が必要）
```

ローカル実行時は `.env.example` をコピーして `.env` を作成し、値を記入すること:
- `SAKURA_AI_TOKEN` - さくらのAI Engine のアカウントトークン（翻訳用。さくらのクラウドのコントロールパネルで発行）
- `GITHUB_TOKEN` - GitHub Personal Access Token（GitHub Releases API のレート制限緩和用。省略可）
- `DISCORD_WEBHOOK_URL` - Discord Webhook URL
- `SLACK_WEBHOOK_URL` - Slack Webhook URL（省略可。設定時のみ通知）
- `SITE_URL` - 通知に載せる公開サイトURL（省略可。Actions 上では `GITHUB_REPOSITORY` から自動導出されるためローカル実行時のみ意味を持つ）
- `DRY_RUN` - `true` にすると Discord/Slack に投稿せず stdout に出力（省略可）

## アーキテクチャ

```
scripts/check-and-notify.mjs  - メイン処理スクリプト（ESM。検知・翻訳・通知・サイトデータ書き出し）
scripts/lib/changelog-core.mjs - 共通ロジック（副作用のない関数のみ。通知/バックフィル両方から import）
scripts/backfill-site-data.mjs - 過去リリースの一括翻訳スクリプト（初回のみ・再実行可能）
state/last-version.txt        - 最後に確認したバージョンの記録
docs/                         - GitHub Pages 用サイト（index.html / style.css / app.js / .nojekyll / claudecode-color.svg）
docs/data/                    - 翻訳済みリリースデータ（versions.json + <version>.json）
.github/workflows/check-changelog.yml  - 毎日 JST 8:00 / 12:00 / 18:00 に自動実行
```

**注意**: `check-and-notify.mjs` は末尾で `main()` を実行するため、他スクリプトから import しないこと。共有ロジックは必ず `scripts/lib/changelog-core.mjs` に置く。

### 処理フロー

1. GitHub Releases API から最新バージョンを取得
2. `state/last-version.txt` と比較して差分があるか確認
3. 新バージョンがある場合、未取得分のリリース（`body` 等）を取得（複数件は古い順に処理）
4. `categorizeAndGroup()` で箇条書きを 破壊的変更/新機能/改善/その他/バグ修正 に分類
5. `buildGroupedText()` でカテゴリ別に整形した英語テキストを生成
6. さくらのAI Engine (`gpt-oss-120b`) でカテゴリ別本文を日本語翻訳（英語分類から算出した **件数サマリー** `⚡ 改善: 1件 / …` を通知の説明欄に表示）
7. カテゴリ別の箇条書きを**全件**通知（Discord は field / 複数 Embed に分割、Slack は section 分割・50 ブロック超は複数投稿）
8. **Discord** は Embed（件数サマリー・カテゴリ別フィールド・色分け・リンク）、**Slack** は Block Kit（header / 件数サマリー section / divider / カテゴリ）。送信失敗時は従来のプレーンテキストにフォールバック。いずれも**公開サイトの該当バージョンページへのリンク**を含む（URL は `SITE_URL` → `GITHUB_REPOSITORY` の順で導出。導出不能時はリンク省略）
9. 通知成功後、サイト用に**構造化翻訳**（各項目を `title`/`description` に分けた JSON 出力）を追加で1リクエスト実行し、`docs/data/<version>.json` を書き出し。全リリース処理後に `docs/data/versions.json`（一覧インデックス）を再生成
10. `DRY_RUN=true` のときは Webhook 送信・state 更新・サイトデータ書き出しを行わず、Discord/Slack 用 JSON ペイロードを stdout に出力
11. 全リリースの通知が成功した後、`state/last-version.txt` と `docs/data/` を更新し git commit/push → GitHub Pages に自動反映

### 状態管理

`state/last-version.txt` に最後に検知したバージョンを保存し、GitHub Actions Bot がリポジトリにコミットバックする。初期値は `0.0.0`（初回実行時は最新バージョンのエントリのみ通知）。

## GitHub Actions のセットアップ

リポジトリの **Settings > Secrets and variables > Actions** に以下を登録:

| Secret 名 | 内容 |
|-----------|------|
| `SAKURA_AI_TOKEN` | さくらのAI Engine のアカウントトークン（翻訳用。必須） |
| `DISCORD_WEBHOOK_URL` | Discord チャンネルの Webhook URL |
| `SLACK_WEBHOOK_URL` | Slack チャンネルの Webhook URL（省略可） |

`GITHUB_TOKEN` は GitHub Actions が自動発行するため、Secret 登録不要（GitHub Releases API のレート制限緩和用）。

さくらのAI Engine には無料枠（Chat Completions 月3,000リクエスト）があり、本ツールの用途であれば無料枠内で運用できる。トークンはさくらのクラウドのコントロールパネルで発行する。

`workflow_dispatch` で手動実行可能。`force_notify: true` を指定すると前回バージョンをリセットして強制通知できる。

## Webサイト公開の仕組み（GitHub Pages）

- `docs/` を main ブランチから直接配信する（Settings > Pages > Deploy from a branch > main / `/docs`）。ビルド不要・依存ゼロの静的 SPA
- SPA はハッシュルーティング（`#/<version>`）で動作。`data/versions.json`（左メニュー用一覧）と `data/<version>.json`（詳細）を fetch して描画する
- **相対パス必須**（先頭 `/` 禁止）: プロジェクトページは `https://<user>.github.io/<repo>/` のサブパス配信のため
- **XSS対策**: 翻訳文は外部由来コンテンツなので `innerHTML` は使用禁止。`createElement` + `textContent` のみで描画（バッククォートの `<code>` 変換も専用パーサで行う）
- `docs/data/<version>.json` の `sections[].items[]` は `{title, description}` の構造化翻訳（`translateToStructuredJapanese()`）。通知用の行翻訳 `translateToJapanese()` とは別系統
- `versions.json` は `rebuildVersionsIndex()` が `docs/data/*.json` のフルスキャンで毎回再生成する（増分更新しない）
- 過去リリースの一括生成は `npm run backfill`（`--limit=N` / `--force` / `--dry-run` オプションあり）。生成済みバージョンはスキップされるため中断・再実行に強い
- ローカルでのサイト確認は**リポジトリルート**で `python3 -m http.server 8000` を起動して `http://localhost:8000/docs/` を開く（サブパス配信を模して絶対パスバグを検出するため。`cd docs` での起動は不可）

## GitHub Actions デプロイへの切り替え手順（将来用）

現在は「main ブランチの `/docs` から配信」方式。Actions デプロイ方式に切り替える場合:

1. **Settings > Pages > Source** を「GitHub Actions」に変更
2. `.github/workflows/deploy-pages.yml` を新規作成:
   - トリガー: `push`（`paths: ['docs/**']`）+ `workflow_dispatch`
   - `permissions: { pages: write, id-token: write }`、`environment: github-pages`
   - ステップ: `actions/checkout@v4` → `actions/upload-pages-artifact@v3`（`path: docs`）→ `actions/deploy-pages@v4`
3. 旧ブランチデプロイ設定は Source 変更で自動的に無効化されるため後始末不要

## CLAUDE.md修正方針
- 他ファイルに修正が入った時に、CLAUDE.mdとREADMEにも反映が必要かをチェックして必要なら反映してください。

## Gitのルール
- コミットの際は日本語でわかりやすく簡潔に記載してください。