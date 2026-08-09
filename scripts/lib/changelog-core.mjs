/**
 * Claude Code Changelog Checker - 共通ロジック
 *
 * 副作用のない（あるいは呼び出し側が明示的に指定したディレクトリにのみ書き込む）
 * 関数群を集約したライブラリ。check-and-notify.mjs と backfill-site-data.mjs の
 * 両方から import される。このファイル自身は import 時に何も実行しない。
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// .env 読み込み
// ---------------------------------------------------------------------------

/** .env ファイルが存在する場合は環境変数に読み込む（ローカル開発用） */
function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
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

// ---------------------------------------------------------------------------
// GitHub Releases API
// ---------------------------------------------------------------------------

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/anthropics/claude-code/releases';

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
 * lastVersion より新しいリリースを返す（新しい順）。
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

/**
 * 全リリースを per_page=100 でページネーションして全件取得する（draft は除外）。
 * ページ間は sleep(500) で GitHub API への負荷を抑える。
 */
async function fetchAllReleases() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${GITHUB_RELEASES_URL}?per_page=100&page=${page}`, {
      headers: githubHeaders(),
    });
    if (!res.ok) throw new Error(`GitHub releases API failed: ${res.status}`);
    const releases = await res.json();
    if (!Array.isArray(releases) || releases.length === 0) break;

    for (const r of releases) {
      if (r.draft === true) continue;
      all.push(r);
    }

    page += 1;
    await sleep(500);
  }
  return all;
}

// ---------------------------------------------------------------------------
// semver 比較
// ---------------------------------------------------------------------------

/** semver 文字列を比較して -1/0/1 を返す（プレリリースタグは無視） */
function compareVersions(a, b) {
  const parse = (v) => v.replace(/[^.\d]/g, '').split('.').map(Number);
  const [ma, mi, pa] = parse(a);
  const [mb, mib, pb] = parse(b);
  if (ma !== mb) return ma > mb ? 1 : -1;
  if (mi !== mib) return mi > mib ? 1 : -1;
  if (pa !== pb) return pa > pb ? 1 : -1;
  return 0;
}

/** semver 比較（プレリリースタグは無視） */
function isNewerThan(version, since) {
  return compareVersions(version, since) > 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// カテゴリ分類・グルーピング
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ['破壊的変更', '新機能', '改善', 'その他', 'バグ修正'];
const CATEGORY_EMOJI = {
  破壊的変更: '🚨',
  新機能: '🆕',
  改善: '⚡',
  その他: '➡️',
  バグ修正: '🐛',
};

function categorizeAndGroup(text) {
  const groups = {
    破壊的変更: [],
    新機能: [],
    改善: [],
    その他: [],
    バグ修正: [],
  };
  const bulletRe = /^[-*]\s+(.+)$/gm;
  let m;
  while ((m = bulletRe.exec(text)) !== null) {
    const line = m[1];
    if (/^(Breaking|BREAKING|Removed|Deprecated)\b/i.test(line)) groups['破壊的変更'].push(line);
    else if (/^(Added|Add)\b/i.test(line)) groups['新機能'].push(line);
    else if (/^(Fixed|Fix)\b/i.test(line)) groups['バグ修正'].push(line);
    else if (/^(Improved?|Faster|Better|Updated?|Performance|Optimized?)\b/i.test(line))
      groups['改善'].push(line);
    else groups['その他'].push(line);
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
  const parts = CATEGORY_ORDER.filter((cat) => groups[cat].length > 0).map(
    (cat) => `${CATEGORY_EMOJI[cat]} ${cat}: ${groups[cat].length}件`,
  );
  return parts.join(' / ');
}

function hasBreakingChanges(groups) {
  return groups['破壊的変更'].length > 0;
}

// ---------------------------------------------------------------------------
// translation（さくらのAI Engine - OpenAI 互換 Chat Completions API）
// ---------------------------------------------------------------------------

const MAX_TRANSLATE_CHARS = 12000;

async function translateToJapanese(text, version) {
  const token = process.env.SAKURA_AI_TOKEN;
  if (!token) throw new Error('SAKURA_AI_TOKEN is not set');

  const truncated =
    text.length > MAX_TRANSLATE_CHARS
      ? text.slice(0, MAX_TRANSLATE_CHARS) + '\n\n...(以下省略)'
      : text;

  const res = await fetch('https://api.ai.sakura.ad.jp/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      // 推論モデルのため思考分のトークンも見込んで多めに確保
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: `以下は Claude Code v${version} のリリースノート（英語の箇条書きをカテゴリ別にまとめたもの）です。
日本語に翻訳した結果だけを出力してください（余計な前置きや見出しは付けない）。

ルール:
- 入力と同じカテゴリ見出し・件数・空行区切りのブロック構造を保つ
- 各箇条書きの本文のみ日本語にし、技術用語・コマンド・固有名詞はそのまま残す
- カテゴリ行の絵文字・「○○ (N件)」形式は維持する
- 箇条書きは各行先頭の \`- \` を維持する

入力:

${truncated}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`さくらのAI Engine API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

/** モデルが付けた ## TL;DR / ## 本文 などを取り除き、カテゴリ本文だけにする */
function normalizeTranslatedBody(raw) {
  let t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return '';
  t = t.replace(/^##\s*TL;DR\s*[\s\S]*?(?=\n##\s|$)/im, '').trim();
  t = t.replace(/^##\s*本文\s*\n?/im, '').trim();
  return t;
}

/**
 * 本文をカテゴリブロックに分割（1行目=見出し、以降=箇条書き）
 */
function parseBodyIntoSections(body) {
  const sections = [];
  const parts = body.split(/\n\n+/);
  for (const part of parts) {
    const lines = part
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const header = lines[0];
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^[-*]\s+/.test(l)) items.push(l.replace(/^[-*]\s+/, ''));
    }
    if (items.length > 0) sections.push({ header, items });
  }
  return sections;
}

function releaseTagUrl(tagName) {
  const enc = encodeURIComponent(tagName);
  return `https://github.com/anthropics/claude-code/releases/tag/${enc}`;
}

/** 見出し文字列の先頭にある CATEGORY_EMOJI から日本語カテゴリ名を逆引きする */
function categoryFromHeader(header) {
  for (const cat of CATEGORY_ORDER) {
    if (header.startsWith(CATEGORY_EMOJI[cat])) return cat;
  }
  return 'その他';
}

/**
 * サイト用の構造化翻訳。
 * カテゴリ別の英語箇条書き（groups）から、さくらのAI Engine に
 * { sections: [{ category, items: [{ title, description }] }] } 形式の
 * JSON のみを出力するよう指示して生成する。
 *
 * パース失敗時は、既存の行翻訳（translateToJapanese）の結果を
 * parseBodyIntoSections で分割し、各行を { title: 行全文, description: '' } として
 * 組み立てるフォールバックを行う（サイトにデータが欠落しないことを優先）。
 *
 * 入力が空（全カテゴリ0件）の場合は API を呼ばず { sections: [] } を返す。
 */
async function translateToStructuredJapanese(groups, version) {
  const groupedEnglish = buildGroupedText(groups);
  if (!groupedEnglish) return { sections: [] };

  const token = process.env.SAKURA_AI_TOKEN;
  if (!token) throw new Error('SAKURA_AI_TOKEN is not set');

  const truncated =
    groupedEnglish.length > MAX_TRANSLATE_CHARS
      ? groupedEnglish.slice(0, MAX_TRANSLATE_CHARS) + '\n\n...(以下省略)'
      : groupedEnglish;

  const prompt = `以下は Claude Code v${version} のリリースノート（英語の箇条書きをカテゴリ別にまとめたもの）です。
各カテゴリの箇条書きを日本語に翻訳し、以下のJSON形式のみを出力してください（前置き・説明文・コードフェンス以外の文章は不要です）。

出力形式:
{"sections":[{"category":"新機能","items":[{"title":"短い日本語見出し","description":"補足説明（原文の情報を落とさない）"}]}]}

ルール:
- category は「破壊的変更」「新機能」「改善」「その他」「バグ修正」のいずれかとし、入力の英語カテゴリ構成と一致させる
- 各箇条書き1件につき items 内の1オブジェクト（title, description）を作る
- title は短い日本語見出し、description は原文の情報を落とさない補足説明とする
- インラインコードやフラグ名（バッククォートで囲まれた部分）はバッククォート付きのまま維持する
- 技術用語・コマンド・固有名詞は翻訳せずそのまま残す
- JSON以外の文字列（前置き、コードフェンスなど）は一切出力しない

入力:

${truncated}`;

  const res = await fetch('https://api.ai.sakura.ad.jp/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`さくらのAI Engine API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;

  try {
    const cleaned = String(raw)
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.sections)) {
      return parsed;
    }
    throw new Error('sections is not an array');
  } catch (e) {
    console.warn(
      `translateToStructuredJapanese: JSONパースに失敗、行翻訳へフォールバック (v${version}):`,
      e.message,
    );
    const translatedRaw = await translateToJapanese(groupedEnglish, version);
    const body = normalizeTranslatedBody(translatedRaw);
    const parsedSections = parseBodyIntoSections(body);
    const sections = parsedSections.map(({ header, items }) => ({
      category: categoryFromHeader(header),
      items: items.map((line) => ({ title: line, description: '' })),
    }));
    return { sections };
  }
}

// ---------------------------------------------------------------------------
// サイトデータ（docs/data/*.json）
// ---------------------------------------------------------------------------

function sanitizeVersionForFilename(version) {
  return version.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 1バージョン分のサイトデータ（docs/data/<sanitized>.json）を書き出す。
 */
function writeVersionSiteData(dataDir, { release, version, groups, sections }) {
  fs.mkdirSync(dataDir, { recursive: true });

  const counts = {};
  for (const cat of CATEGORY_ORDER) counts[cat] = groups[cat].length;

  const data = {
    version,
    tagName: release.tag_name,
    publishedAt: release.published_at,
    releaseUrl: release.html_url || releaseTagUrl(release.tag_name),
    counts,
    hasBreakingChanges: hasBreakingChanges(groups),
    sections,
    translatedAt: new Date().toISOString(),
  };

  const filePath = path.join(dataDir, `${sanitizeVersionForFilename(version)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return filePath;
}

/**
 * docs/data/*.json（versions.json 自身は除く）を全読みし、
 * compareVersions で version 降順に並べた versions.json を再生成する。
 * dataDir が存在しない、または対象ファイルが1件もない場合は versions: [] で生成する。
 */
function rebuildVersionsIndex(dataDir) {
  let entries = [];

  if (fs.existsSync(dataDir)) {
    const files = fs
      .readdirSync(dataDir)
      .filter((f) => f.endsWith('.json') && f !== 'versions.json');

    for (const file of files) {
      const filePath = path.join(dataDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const json = JSON.parse(raw);
        entries.push({
          version: json.version,
          tagName: json.tagName,
          publishedAt: json.publishedAt,
          releaseUrl: json.releaseUrl,
          counts: json.counts,
          hasBreakingChanges: json.hasBreakingChanges,
        });
      } catch (e) {
        console.warn(`rebuildVersionsIndex: ${file} の読み込みに失敗しました:`, e.message);
      }
    }
  }

  entries.sort((a, b) => compareVersions(b.version, a.version));

  const indexData = {
    generatedAt: new Date().toISOString(),
    latest: entries.length > 0 ? entries[0].version : null,
    versions: entries,
  };

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'versions.json'),
    JSON.stringify(indexData, null, 2) + '\n',
  );
  return indexData;
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export {
  GITHUB_RELEASES_URL,
  MAX_TRANSLATE_CHARS,
  CATEGORY_ORDER,
  CATEGORY_EMOJI,
  githubHeaders,
  fetchLatestVersion,
  fetchReleasesSince,
  fetchAllReleases,
  compareVersions,
  isNewerThan,
  sleep,
  categorizeAndGroup,
  buildGroupedText,
  buildSummaryLine,
  hasBreakingChanges,
  translateToJapanese,
  translateToStructuredJapanese,
  normalizeTranslatedBody,
  parseBodyIntoSections,
  releaseTagUrl,
  loadDotEnv,
  sanitizeVersionForFilename,
  writeVersionSiteData,
  rebuildVersionsIndex,
};
