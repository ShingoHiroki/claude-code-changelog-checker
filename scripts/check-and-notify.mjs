/**
 * Claude Code Changelog Checker
 *
 * npm registry から @anthropic-ai/claude-code の最新バージョンを取得し、
 * 新バージョンがあれば CHANGELOG を日本語訳して Discord に通知する。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT_DIR, 'state', 'last-version.txt');
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code';
const MAX_TRANSLATE_CHARS = 12000;

// ---------------------------------------------------------------------------
// npm registry
// ---------------------------------------------------------------------------

async function fetchNpmData() {
  const res = await fetch(NPM_REGISTRY_URL);
  if (!res.ok) throw new Error(`npm registry fetch failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// tarball / CHANGELOG
// ---------------------------------------------------------------------------

async function fetchChangelog(tarballUrl) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-'));
  try {
    const tarPath = path.join(tmpDir, 'pkg.tgz');
    const res = await fetch(tarballUrl);
    if (!res.ok) throw new Error(`tarball fetch failed: ${res.status}`);
    fs.writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));

    await tar.extract({
      file: tarPath,
      cwd: tmpDir,
      filter: (p) => /CHANGELOG/i.test(path.basename(p)),
    });

    const files = findFiles(tmpDir, (name) => /CHANGELOG/i.test(name));
    if (files.length === 0) return null;
    return fs.readFileSync(files[0], 'utf8');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function findFiles(dir, predicate) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, predicate));
    } else if (predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// changelog parsing
// ---------------------------------------------------------------------------

/**
 * sinceVersion より新しいバージョンのセクションをまとめて返す。
 * sinceVersion が "0.0.0"（初回実行）の場合は latestVersion のみ返す。
 */
function extractEntriesSince(changelog, sinceVersion, latestVersion) {
  if (!changelog) return null;

  const sections = changelog.split(/^(?=#{1,3} (?:v|\[)?\d+\.\d+)/m);
  const versionRe = /^#{1,3} (?:v|\[)?(\d+\.\d+\.\d+[^\s\]]*)/;

  if (sinceVersion === '0.0.0') {
    // 初回: 最新バージョンのエントリのみ
    for (const section of sections) {
      const match = section.match(versionRe);
      if (match && match[1] === latestVersion) return section.trim();
    }
    // exact match がなければ最初のセクションを返す
    const first = sections.find((s) => versionRe.test(s));
    return first ? first.trim() : null;
  }

  const newSections = [];
  for (const section of sections) {
    const match = section.match(versionRe);
    if (!match) continue;
    if (isNewerThan(match[1], sinceVersion)) {
      newSections.push(section.trim());
    }
  }
  return newSections.length > 0 ? newSections.join('\n\n') : null;
}

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
          content: `以下は Claude Code v${version} の Changelog（英語）です。日本語に翻訳してください。
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
// Discord
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
  const npmData = await fetchNpmData();
  const latestVersion = npmData['dist-tags'].latest;
  const lastVersion = readLastVersion();

  if (latestVersion === lastVersion) {
    console.log(`最新バージョンに変化なし: ${latestVersion}`);
    return;
  }

  console.log(`新バージョン検出: ${latestVersion} (前回: ${lastVersion})`);

  const versionData = npmData.versions[latestVersion];
  if (!versionData) throw new Error(`バージョン ${latestVersion} の情報が取得できません`);

  const changelog = await fetchChangelog(versionData.dist.tarball);
  const entries = extractEntriesSince(changelog, lastVersion, latestVersion);

  let notifyContent;
  if (entries) {
    console.log('Changelog を翻訳中...');
    notifyContent = await translateToJapanese(entries, latestVersion);
  } else {
    notifyContent = changelog
      ? 'このバージョンに対応する Changelog エントリが見つかりませんでした。'
      : 'パッケージに CHANGELOG が含まれていませんでした。';
  }

  await postToDiscord(notifyContent, latestVersion, lastVersion);
  console.log('Discord への通知が完了しました');

  writeLastVersion(latestVersion);
  console.log(`状態を ${latestVersion} に更新しました`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
