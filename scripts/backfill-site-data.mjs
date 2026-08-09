/**
 * Claude Code Changelog Checker - サイトデータ バックフィル
 *
 * GitHub Releases API から全リリースを取得し、docs/data/<version>.json が
 * 未生成のものだけ構造化翻訳を行って書き出す（初回公開時の一括翻訳用）。
 * 既存 JSON があるバージョンはスキップするため、中断しても再実行で再開できる。
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchAllReleases,
  compareVersions,
  sleep,
  categorizeAndGroup,
  translateToStructuredJapanese,
  loadDotEnv,
  sanitizeVersionForFilename,
  writeVersionSiteData,
  rebuildVersionsIndex,
} from './lib/changelog-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'docs', 'data');

// .env ファイルが存在する場合は環境変数に読み込む（ローカル開発用）
loadDotEnv(ROOT_DIR);

const BACKFILL_SLEEP_MS = Number(process.env.BACKFILL_SLEEP_MS) || 1500;

// ---------------------------------------------------------------------------
// CLI オプション
// ---------------------------------------------------------------------------

/**
 * process.argv から --limit=N / --force / --dry-run を簡易パースする。
 */
function parseCliOptions(argv) {
  const options = { limit: null, force: false, dryRun: false };
  for (const arg of argv) {
    if (arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (Number.isFinite(n) && n >= 0) options.limit = n;
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  console.log(
    `オプション: limit=${options.limit ?? '(なし)'} force=${options.force} dryRun=${options.dryRun}`,
  );

  console.log('全リリースを取得中...');
  const releases = await fetchAllReleases();
  /** compareVersions で昇順（古い順）にソートして処理する */
  releases.sort((a, b) =>
    compareVersions(a.tag_name.replace(/^v/, ''), b.tag_name.replace(/^v/, '')),
  );
  console.log(`取得件数: ${releases.length}`);

  let translatedCount = 0;
  let skippedCount = 0;
  const failedVersions = [];

  for (let i = 0; i < releases.length; i++) {
    const release = releases[i];
    const version = release.tag_name.replace(/^v/, '');
    const progress = `[${i + 1}/${releases.length}] v${version}`;
    const filePath = path.join(DATA_DIR, `${sanitizeVersionForFilename(version)}.json`);

    const alreadyExists = fs.existsSync(filePath);
    if (alreadyExists && !options.force) {
      console.log(`${progress} スキップ（生成済み）`);
      skippedCount += 1;
      continue;
    }

    if (options.limit !== null && translatedCount >= options.limit) {
      console.log(`${progress} --limit=${options.limit} に達したため処理を打ち切ります`);
      break;
    }

    try {
      console.log(`${progress} 翻訳中...`);
      const entry = `## ${release.tag_name}\n\n${release.body || '（リリースノートなし）'}`;
      const groups = categorizeAndGroup(entry);
      const structured = await translateToStructuredJapanese(groups, version);

      if (options.dryRun) {
        console.log(`${progress} 書き込み予定: ${filePath}`);
      } else {
        writeVersionSiteData(DATA_DIR, {
          release,
          version,
          groups,
          sections: structured.sections,
        });
        console.log(`${progress} 書き込み完了: ${filePath}`);
      }

      translatedCount += 1;
      await sleep(BACKFILL_SLEEP_MS);
    } catch (e) {
      console.error(`${progress} 失敗:`, e.message);
      failedVersions.push(version);
    }
  }

  if (!options.dryRun) {
    rebuildVersionsIndex(DATA_DIR);
    console.log('サイトのバージョン一覧 (versions.json) を再生成しました');
  } else {
    console.log('DRY_RUN: versions.json の再生成はスキップしました');
  }

  console.log(
    `完了: 翻訳 ${translatedCount}件 / スキップ ${skippedCount}件 / 失敗 ${failedVersions.length}件`,
  );
  if (failedVersions.length > 0) {
    console.log(`失敗したバージョン: ${failedVersions.join(', ')}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
