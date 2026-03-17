/**
 * Claude Code Changelog Checker
 *
 * GitHub Releases API から @anthropic-ai/claude-code の最新リリースを取得し、
 * 新バージョンがあれば リリースノートを日本語訳して Discord に通知する。
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT_DIR, 'state', 'last-version.txt');

// .env ファイルが存在する場合は環境変数に読み込む（ローカル開発用）
const envPath = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/anthropics/claude-code/releases';
const MAX_TRANSLATE_CHARS = 12000;

// ---------------------------------------------------------------------------
// GitHub Releases API
// ---------------------------------------------------------------------------

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchLatestVersion() {
  const res = await fetch(`${GITHUB_RELEASES_URL}/latest`, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub releases API failed: ${res.status}`);
  const release = await res.json();
  return release.tag_name.replace(/^v/, '');
}

/**
 * lastVersion より新しいリリースを返す。
 * lastVersion が "0.0.0"（初回）の場合は最新リリースのみ返す。
 */
async function fetchReleasesSince(lastVersion) {
  const res = await fetch(`${GITHUB_RELEASES_URL}?per_page=20`, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub releases API failed: ${res.status}`);
  const releases = await res.json();
  if (!Array.isArray(releases) || releases.length === 0) throw new Error('リリースが見つかりません');

  if (lastVersion === '0.0.0') return [releases[0]];

  return releases.filter((r) => isNewerThan(r.tag_name.replace(/^v/, ''), lastVersion));
}

// ---------------------------------------------------------------------------
// semver 比較
// ---------------------------------------------------------------------------

/** semver 比較（プレリリースタグは無視） */
function isNewerThan(version, since) {
  const parse = (v) => v.replace(/[^.\d]/g, '').split('.').map(Number);
  const [ma, mi, pa] = parse(version);
  const [sb, si, sp] = parse(since);
  if (ma !== sb) return ma > sb;
  if (mi !== si) return mi > si;
  return pa > sp;
}

// ---------------------------------------------------------------------------
// カテゴリ分類・グルーピング
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ['新機能', '改善', 'その他', 'バグ修正'];
const CATEGORY_EMOJI = { 新機能: '🆕', 改善: '⚡', その他: '➡️', バグ修正: '🐛' };

function categorizeAndGroup(text) {
  const groups = { 新機能: [], 改善: [], その他: [], バグ修正: [] };
  const bulletRe = /^[-*]\s+(.+)$/gm;
  let m;
  while ((m = bulletRe.exec(text)) !== null) {
    const line = m[1];
    if (/^(Added|Add)\b/i.test(line))
      groups['新機能'].push(line);
    else if (/^(Fixed|Fix)\b/i.test(line))
      groups['バグ修正'].push(line);
    else if (/^(Improved?|Faster|Better|Updated?|Performance|Optimized?)\b/i.test(line))
      groups['改善'].push(line);
    else
      groups['その他'].push(line);
  }
  return groups;
}

function buildGroupedText(groups) {
  const sections = [];
  for (const cat of CATEGORY_ORDER) {
    const items = groups[cat];
    if (items.length === 0) continue;
    const header = `${CATEGORY_EMOJI[cat]} ${cat} (${items.length}件)`;
    const body = items.map((l) => `- ${l}`).join('\n');
    sections.push(`${header}\n${body}`);
  }
  return sections.join('\n\n');
}

function buildSummaryLine(groups) {
  const parts = CATEGORY_ORDER
    .filter((cat) => groups[cat].length > 0)
    .map((cat) => `${CATEGORY_EMOJI[cat]} ${cat}: ${groups[cat].length}件`);
  return parts.join(' / ');
}

// ---------------------------------------------------------------------------
// translation（GitHub Models API - GITHUB_TOKEN で無料利用可能）
// ---------------------------------------------------------------------------

async function translateToJapanese(text, version) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');

  // 長すぎる場合は末尾を切り詰める
  const truncated =
    text.length > MAX_TRANSLATE_CHARS
      ? text.slice(0, MAX_TRANSLATE_CHARS) + '\n\n...(以下省略)'
      : text;

  const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `以下は Claude Code v${version} のリリースノート（英語）です。日本語に翻訳してください。
技術用語・コマンド・固有名詞はそのまま残し、自然な日本語にしてください。
Markdown の構造（見出し・箇条書き・コードブロックなど）は保持してください。

${truncated}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub Models API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ---------------------------------------------------------------------------
// Discord / Slack 共通ユーティリティ
// ---------------------------------------------------------------------------

function markdownToDiscord(text) {
  return text
    .replace(/^#{1,6} (.+)$/gm, '**$1**') // 見出し → ボールド
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // リンク → テキストのみ
}

function splitMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

async function postToDiscord(content, latestVersion, lastVersion) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL is not set');

  const prefix =
    lastVersion === '0.0.0'
      ? `**Claude Code v${latestVersion} - 初回チェック**\n\n`
      : `**Claude Code v${latestVersion} リリース** (前回: v${lastVersion})\n\n`;

  const discordContent = markdownToDiscord(prefix + content);
  const chunks = splitMessage(discordContent, 2000);

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunks[i] }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Discord webhook error: ${res.status} ${err}`);
    }
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

async function postToSlack(content, latestVersion, lastVersion) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return false; // 未設定の場合はスキップ

  const prefix =
    lastVersion === '0.0.0'
      ? `*Claude Code v${latestVersion} - 初回チェック*\n\n`
      : `*Claude Code v${latestVersion} リリース* (前回: v${lastVersion})\n\n`;

  const text = prefix + content;
  // Slack は 1 メッセージあたり 40,000 文字まで対応しているが、安全のため 3000 文字で分割
  const chunks = splitMessage(text, 3000);

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunks[i] }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Slack webhook error: ${res.status} ${err}`);
    }
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

function readLastVersion() {
  if (!fs.existsSync(STATE_FILE)) return '0.0.0';
  return fs.readFileSync(STATE_FILE, 'utf8').trim() || '0.0.0';
}

function writeLastVersion(version) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, version);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const lastVersion = readLastVersion();
  const latestVersion = await fetchLatestVersion();

  if (latestVersion === lastVersion) {
    console.log(`最新バージョンに変化なし: ${latestVersion}`);
    return;
  }

  console.log(`新バージョン検出: ${latestVersion} (前回: ${lastVersion})`);

  const newReleases = await fetchReleasesSince(lastVersion);
  const entries = newReleases
    .map((r) => `## ${r.tag_name}\n\n${r.body || '（リリースノートなし）'}`)
    .join('\n\n---\n\n');

  const groups = categorizeAndGroup(entries);
  const summaryLine = buildSummaryLine(groups);
  const groupedEnglish = buildGroupedText(groups);

  console.log('リリースノートを翻訳中...');
  const translated = await translateToJapanese(groupedEnglish, latestVersion);
  const notificationBody = summaryLine + '\n\n' + translated;

  if (process.env.DRY_RUN === 'true') {
    console.log('--- 通知プレビュー ---');
    console.log(notificationBody);
    console.log('--- プレビュー終了 ---');
  } else {
    await postToDiscord(notificationBody, latestVersion, lastVersion);
    console.log('Discord への通知が完了しました');

    const slackSent = await postToSlack(notificationBody, latestVersion, lastVersion);
    if (slackSent) {
      console.log('Slack への通知が完了しました');
    } else {
      console.log('SLACK_WEBHOOK_URL が未設定のため Slack 通知をスキップしました');
    }

    writeLastVersion(latestVersion);
    console.log(`状態を ${latestVersion} に更新しました`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
