# アーキテクチャ構成図

Claude Code の新バージョンを検知し、リリースノートを日本語翻訳して Discord / Slack に通知し、GitHub Pages で公開するまでの構成をまとめたドキュメント。

- 画像（SVG）版: [概要図](assets/architecture-overview.svg) / [詳細図](assets/architecture-detail.svg)
- HTML 版（ダークテーマ対応・ブラウザで直接開く）: [assets/architecture.html](assets/architecture.html)

> **図の正本は本ファイルの Mermaid** とし、SVG / HTML は閲覧用の派生物として扱う。処理フローを変更したら、まず Mermaid を更新し、続けて SVG / HTML も合わせて更新すること。

## 概要図

GitHub Actions のスケジュール実行を起点に、外部サービスとどう連携するかの全体像。

```mermaid
flowchart TB
    subgraph trigger["トリガー"]
        CRON["cron スケジュール<br/>JST 8:00 / 12:00 / 18:00"]
        MANUAL["workflow_dispatch<br/>手動実行"]
    end

    subgraph repo["GitHub リポジトリ"]
        subgraph actions["GitHub Actions（check-changelog.yml）"]
            SCRIPT["scripts/check-and-notify.mjs<br/>検知・翻訳・通知・サイトデータ書き出し"]
        end
        STATE[("state/last-version.txt<br/>前回検知バージョン")]
        DOCS[("docs/data/*.json<br/>翻訳済みリリースデータ")]
    end

    RELEASES["GitHub Releases API<br/>@anthropic-ai/claude-code"]
    SAKURA["さくらのAI Engine<br/>gpt-oss-120b で日本語翻訳"]
    DISCORD["Discord<br/>Embed で全件通知"]
    SLACK["Slack<br/>Block Kit でコンパクト通知"]
    PAGES["GitHub Pages<br/>翻訳済みリリースノート公開サイト"]

    CRON --> SCRIPT
    MANUAL --> SCRIPT
    SCRIPT -->|"1 最新バージョン取得"| RELEASES
    SCRIPT <-->|"2 前回バージョンと比較"| STATE
    SCRIPT -->|"3 リリースノートを翻訳"| SAKURA
    SCRIPT -->|"4 Webhook 通知"| DISCORD
    SCRIPT -->|"4 Webhook 通知"| SLACK
    SCRIPT -->|"5 書き出し"| DOCS
    STATE -->|"6 commit / push"| PAGES
    DOCS -->|"6 commit / push"| PAGES
    DISCORD -.->|"通知内のリンク"| PAGES
    SLACK -.->|"通知内のリンク"| PAGES
```

処理の流れ:

1. 毎日 JST 8:00 / 12:00 / 18:00 の cron（または手動実行）で GitHub Actions が起動
2. GitHub Releases API から最新バージョンを取得し、`state/last-version.txt` と比較
3. 新バージョンがあれば、さくらのAI Engine（gpt-oss-120b）でリリースノートを日本語翻訳
4. Discord（Embed・全件掲載）と Slack（Block Kit・サマリーのみ）へ Webhook 通知
5. サイト用の翻訳データを `docs/data/` に書き出し
6. state とサイトデータを commit / push すると、main ブランチの `/docs` を配信する GitHub Pages に自動反映。通知には公開サイトの該当バージョンページへのリンクを掲載

## 詳細図

分類・翻訳の2系統、フォールバック、`DRY_RUN` / `force_notify`、バックフィルまで含めた詳細フロー。

```mermaid
flowchart TB
    subgraph trigger["トリガー"]
        CRON["cron<br/>JST 8:00 / 12:00 / 18:00"]
        MANUAL["workflow_dispatch"]
        FORCE["force_notify: true なら<br/>last-version.txt を 0.0.0 にリセット"]
        MANUAL --> FORCE
    end

    subgraph secrets["GitHub Secrets"]
        SEC["SAKURA_AI_TOKEN<br/>DISCORD_WEBHOOK_URL<br/>SLACK_WEBHOOK_URL（任意）<br/>GITHUB_TOKEN は自動発行"]
    end

    subgraph job["GitHub Actions ジョブ（check-changelog.yml）"]
        MAIN["scripts/check-and-notify.mjs"]

        subgraph core["scripts/lib/changelog-core.mjs（共通ロジック）"]
            FETCH["GitHub Releases API から<br/>最新・未取得リリースを取得"]
            DIFF{"state/last-version.txt<br/>と差分あり？"}
            CAT["categorizeAndGroup()<br/>破壊的変更 / 新機能 / 改善 /<br/>その他 / バグ修正 に分類<br/>→ 件数サマリーを英語分類から算出"]
            T1["translateToJapanese()<br/>通知用: カテゴリ別本文を翻訳"]
            T2["translateToStructuredJapanese()<br/>サイト用: title / description の<br/>構造化 JSON 翻訳（+1 リクエスト）"]
            IDX["rebuildVersionsIndex()<br/>docs/data/*.json をフルスキャンして<br/>versions.json を再生成"]
        end

        COMMIT["state/last-version.txt と docs/data/ を<br/>git commit / push（Actions Bot）"]
    end

    SAKURA["さくらのAI Engine<br/>gpt-oss-120b<br/>OpenAI 互換 API"]

    subgraph notify["通知（バージョンごと・古い順）"]
        DISCORD["Discord Webhook<br/>Embed: 件数サマリー + カテゴリ別<br/>フィールドで全件掲載<br/>上限超過時は field / Embed 分割"]
        SLACK["Slack Webhook<br/>Block Kit: header + 件数サマリー +<br/>サイトリンクのみのコンパクト通知<br/>未設定時はスキップ"]
        FB1["送信失敗時:<br/>プレーンテキストにフォールバック"]
        DISCORD -.-> FB1
        SLACK -.-> FB1
    end

    subgraph site["公開サイト（GitHub Pages）"]
        DATA[("docs/data/&lt;version&gt;.json<br/>+ versions.json")]
        SPA["docs/ の静的 SPA<br/>ハッシュルーティング #/&lt;version&gt;<br/>main ブランチ /docs から配信"]
        DATA --> SPA
    end

    DRY["DRY_RUN=true:<br/>送信・state 更新・書き出しを行わず<br/>Discord / Slack 用 JSON を stdout 出力"]
    BACKFILL["scripts/backfill-site-data.mjs<br/>過去リリースの一括翻訳（初回・ローカル実行）<br/>生成済みはスキップ、再実行可能"]

    CRON --> MAIN
    MANUAL --> MAIN
    SEC -.-> MAIN
    MAIN --> FETCH --> DIFF
    DIFF -->|"なし"| END["終了"]
    DIFF -->|"あり"| CAT
    CAT --> T1
    T1 <--> SAKURA
    T1 --> DISCORD
    T1 --> SLACK
    DISCORD --> T2
    SLACK --> T2
    T2 <--> SAKURA
    T2 --> DATA
    T2 --> IDX --> DATA
    IDX --> COMMIT
    COMMIT --> SPA
    DISCORD -.->|"該当バージョンページへのリンク"| SPA
    SLACK -.->|"該当バージョンページへのリンク"| SPA
    MAIN -.-> DRY
    BACKFILL <--> SAKURA
    BACKFILL --> DATA
```

補足:

- **翻訳は2系統**: 通知用の行翻訳（`translateToJapanese()`）とサイト用の構造化翻訳（`translateToStructuredJapanese()`）は別リクエスト。件数サマリーは翻訳前の英語分類から算出する
- **通知順序**: 複数バージョンを一度に検知した場合は古い順に、バージョンごとに個別通知する。全リリースの通知が成功してから state 更新・サイトデータのコミットを行う
- **リンク導出**: 通知に載せる公開サイト URL は `SITE_URL` → `GITHUB_REPOSITORY` の順で導出（導出不能時はリンク省略）
- **バックフィル**: `npm run backfill` は初回のみローカルで実行し、過去リリースの `docs/data/*.json` を一括生成する（`--limit=N` / `--force` / `--dry-run` オプションあり）
