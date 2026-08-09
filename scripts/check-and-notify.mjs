/**
 * Claude Code Changelog Checker
 *
 * GitHub Releases API から @anthropic-ai/claude-code の最新リリースを取得し、
 * 新バージョンがあれば リリースノートを日本語訳して Discord / Slack に通知する。
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchLatestVersion,
  fetchReleasesSince,
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
  writeVersionSiteData,
  rebuildVersionsIndex,
} from './lib/changelog-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT_DIR, 'state', 'last-version.txt');
const DATA_DIR = path.join(ROOT_DIR, 'docs', 'data');

// .env ファイルが存在する場合は環境変数に読み込む（ローカル開発用）
loadDotEnv(ROOT_DIR);

/** Discord embed */
const DISCORD_FIELD_VALUE_MAX = 1024;
const DISCORD_FIELD_NAME_MAX = 256;
const DISCORD_EMBED_DESCRIPTION_MAX = 4096;
const DISCORD_MAX_FIELDS_PER_EMBED = 25;
const DISCORD_EMBED_TOTAL_SAFE = 5600;
const DISCORD_MAX_EMBEDS_PER_MESSAGE = 10;

/** Slack Block Kit */
const SLACK_SECTION_MRKDWN_MAX = 3000;
const SLACK_HEADER_PLAIN_MAX = 150;
const SLACK_MAX_BLOCKS_PER_MESSAGE = 50;

function truncateStr(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)) + '...';
}

/** 見出しを「🆕 新機能 (N件)」形式に正規化 */
function normalizeCategoryHeader(header, totalCount) {
  const base = header.replace(/\(\d+件\)\s*$/, '').trim();
  return `${base} (${totalCount}件)`;
}

/**
 * 箇条書き行を maxChunk 以下の文字列チャンクに分割（全件表示用）
 */
function chunkBulletLines(lines, bullet, maxChunk) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const piece = `${bullet} ${line}\n`;
    if (current.length + piece.length > maxChunk && current.length > 0) {
      chunks.push(current.trimEnd());
      current = piece;
    } else if (piece.length > maxChunk) {
      if (current) chunks.push(current.trimEnd());
      chunks.push(truncateStr(piece.trimEnd(), maxChunk));
      current = '';
    } else {
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.length ? chunks : [''];
}

function discordFieldSize(f) {
  return (f.name?.length || 0) + (f.value?.length || 0);
}

/**
 * 1カテゴリ分を Discord field 配列に（値が長い場合は複数 field に分割）
 */
function buildDiscordFieldsForCategory(header, items) {
  const total = items.length;
  const baseName = truncateStr(normalizeCategoryHeader(header, total), DISCORD_FIELD_NAME_MAX);
  const valueChunks = chunkBulletLines(items, '•', DISCORD_FIELD_VALUE_MAX);
  return valueChunks.map((chunk, i) => ({
    name:
      valueChunks.length > 1
        ? truncateStr(`${baseName} (${i + 1}/${valueChunks.length})`, DISCORD_FIELD_NAME_MAX)
        : baseName,
    value: truncateStr(chunk, DISCORD_FIELD_VALUE_MAX),
    inline: false,
  }));
}

// ---------------------------------------------------------------------------
// Discord / Slack 共通ユーティリティ
// ---------------------------------------------------------------------------

function markdownToDiscord(text) {
  return text
    .replace(/^#{1,6} (.+)$/gm, '**$1**')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
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

function buildPlainNotificationText({ body, summaryLine, notifyVersion, lastVersion }) {
  const prefix =
    lastVersion === '0.0.0'
      ? `**Claude Code v${notifyVersion} - 初回チェック**\n\n`
      : `**Claude Code v${notifyVersion} リリース** (前回: v${lastVersion})\n\n`;
  return prefix + (summaryLine ? `${summaryLine}\n\n` : '') + (body || '（本文なし）');
}

function buildDiscordEmbedPayload({
  release,
  notifyVersion,
  lastVersion,
  summaryLine,
  sections,
  releaseUrl,
}) {
  const breaking = hasBreakingChanges(
    categorizeAndGroup(release.body || ''),
  );
  const color = breaking ? 0xef4444 : 0x22c55e;

  const title =
    lastVersion === '0.0.0'
      ? `Claude Code v${notifyVersion} - 初回チェック`
      : `Claude Code v${notifyVersion} リリース`;

  let description = summaryLine || summaryFromSections(sections);
  if (!description) description = '（カテゴリ件数なし）';
  description = truncateStr(description, DISCORD_EMBED_DESCRIPTION_MAX);

  const allFields = [];
  for (const { header, items } of sections) {
    if (!items.length) continue;
    allFields.push(...buildDiscordFieldsForCategory(header, items));
  }

  if (allFields.length === 0) {
    allFields.push({
      name: 'リリースノート',
      value: truncateStr('（カテゴリ別の箇条書きを解析できませんでした）', DISCORD_FIELD_VALUE_MAX),
      inline: false,
    });
  }

  const published = release.published_at
    ? new Date(release.published_at).toISOString()
    : undefined;

  const contTitle = truncateStr(`${title} — 続き`, 256);
  const footerText = `前回: v${lastVersion}`;

  const embeds = [];
  let batchFields = [];
  let isFirstEmbed = true;
  let currentTitle = title;

  function flushIntermediate() {
    if (batchFields.length === 0) return;
    const emb = {
      title: currentTitle,
      url: releaseUrl,
      color,
      fields: batchFields,
    };
    if (isFirstEmbed) {
      emb.description = description;
      if (published) emb.timestamp = published;
    }
    embeds.push(emb);
    batchFields = [];
    isFirstEmbed = false;
    currentTitle = contTitle;
  }

  function flushFinalWithFooter() {
    if (batchFields.length === 0 && embeds.length > 0) return;
    const emb = {
      title: currentTitle,
      url: releaseUrl,
      color,
      fields: batchFields,
      footer: { text: footerText },
    };
    if (isFirstEmbed) {
      emb.description = description;
      if (published) emb.timestamp = published;
    }
    embeds.push(emb);
    batchFields = [];
  }

  for (const field of allFields) {
    const testBatch = [...batchFields, field];
    const tooManyFields = testBatch.length > DISCORD_MAX_FIELDS_PER_EMBED;
    const overhead = currentTitle.length + (isFirstEmbed ? description.length : 0);
    let bodyChars = 0;
    for (const f of testBatch) bodyChars += discordFieldSize(f);
    const tooBig =
      overhead + bodyChars + footerText.length + 100 > DISCORD_EMBED_TOTAL_SAFE;

    if (batchFields.length > 0 && (tooManyFields || tooBig)) {
      flushIntermediate();
    }
    batchFields.push(field);
  }
  flushFinalWithFooter();

  return { embeds };
}

function summaryFromSections(sections) {
  if (sections.length === 0) return '';
  const counts = sections.map((s) => `${s.header.split(/\s+/)[0] || ''} ${s.items.length}件`.trim());
  return counts.join(' / ');
}

async function postDiscordPayload(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord webhook error: ${res.status} ${err}`);
  }
}

async function postToDiscordRich(args) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL is not set');

  const { release, notifyVersion, lastVersion, body, summaryLine, sections } = args;
  const releaseUrl = release.html_url || releaseTagUrl(release.tag_name);

  const embedPayload = buildDiscordEmbedPayload({
    release,
    notifyVersion,
    lastVersion,
    summaryLine,
    sections: sections.length ? sections : parseBodyIntoSections(body),
    releaseUrl,
  });

  try {
    const { embeds } = embedPayload;
    for (let i = 0; i < embeds.length; i += DISCORD_MAX_EMBEDS_PER_MESSAGE) {
      const slice = embeds.slice(i, i + DISCORD_MAX_EMBEDS_PER_MESSAGE);
      await postDiscordPayload(webhookUrl, { embeds: slice });
      if (i + DISCORD_MAX_EMBEDS_PER_MESSAGE < embeds.length) await sleep(1000);
    }
  } catch (e) {
    console.warn('Discord embed 送信に失敗、プレーンテキストにフォールバック:', e.message);
    const plain = markdownToDiscord(
      buildPlainNotificationText({ body, summaryLine, notifyVersion, lastVersion }),
    );
    const chunks = splitMessage(plain, 2000);
    for (let i = 0; i < chunks.length; i++) {
      await postDiscordPayload(webhookUrl, { content: chunks[i] });
      if (i < chunks.length - 1) await sleep(1000);
    }
  }
}

function packSlackCategoryChunks(prefixBlocks, categoryBlocks, notifyVersion) {
  if (prefixBlocks.length + categoryBlocks.length <= SLACK_MAX_BLOCKS_PER_MESSAGE) {
    return [[...prefixBlocks, ...categoryBlocks]];
  }

  const cont = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_続き v${notifyVersion}_` }],
  };

  const payloads = [];
  let i = 0;
  while (i < categoryBlocks.length) {
    const isFirst = payloads.length === 0;
    const prefixLen = isFirst ? prefixBlocks.length : 1;
    const remaining = categoryBlocks.length - i;
    const slots = SLACK_MAX_BLOCKS_PER_MESSAGE - prefixLen;

    const take = remaining <= slots ? remaining : Math.min(remaining, slots);
    const slice = categoryBlocks.slice(i, i + take);
    i += take;

    const blocks = isFirst ? [...prefixBlocks, ...slice] : [cont, ...slice];
    payloads.push(blocks);
  }
  return payloads;
}

function buildSlackCategorySectionBlocks(sections) {
  const categoryBlocks = [];
  const secs = sections.length ? sections : [];

  for (const { header, items } of secs) {
    if (!items.length) continue;
    const baseTitle = normalizeCategoryHeader(header, items.length);
    const worstHeaderText = `*${truncateStr(`${baseTitle} (10/10)`, 400)}*\n`;
    const maxChunk = SLACK_SECTION_MRKDWN_MAX - worstHeaderText.length;
    const bodyChunks = chunkBulletLines(items, '•', maxChunk);
    for (let i = 0; i < bodyChunks.length; i++) {
      const headerLineRaw =
        bodyChunks.length === 1 ? baseTitle : `${baseTitle} (${i + 1}/${bodyChunks.length})`;
      const md = `*${truncateStr(headerLineRaw, 400)}*\n${bodyChunks[i]}`;
      categoryBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: truncateStr(md, SLACK_SECTION_MRKDWN_MAX) },
      });
    }
  }

  if (categoryBlocks.length === 0) {
    categoryBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '（カテゴリ別の箇条書きを解析できませんでした）',
      },
    });
  }

  return categoryBlocks;
}

/** @returns {{ text: string, blocks: object[] }[]} */
function buildSlackBlocksPayloadList({
  release,
  notifyVersion,
  lastVersion,
  summaryLine,
  sections,
  releaseUrl,
}) {
  const headerText = truncateStr(
    lastVersion === '0.0.0'
      ? `Claude Code v${notifyVersion} - 初回チェック`
      : `Claude Code v${notifyVersion} リリース`,
    SLACK_HEADER_PLAIN_MAX,
  );

  const dateStr = release.published_at
    ? new Date(release.published_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '';

  const prefixBlocks = [
    { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `前回: \`v${lastVersion}\`${dateStr ? ` ・ 公開: ${dateStr}` : ''}`,
        },
      ],
    },
  ];

  if (summaryLine) {
    prefixBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncateStr(summaryLine, SLACK_SECTION_MRKDWN_MAX) },
    });
  }

  prefixBlocks.push({ type: 'divider' });

  const categoryBlocks = buildSlackCategorySectionBlocks(sections);

  const blockRuns = packSlackCategoryChunks(prefixBlocks, categoryBlocks, notifyVersion);

  const fallbackBase = truncateStr(
    `${headerText}\n${summaryLine || 'リリース通知'}\n${releaseUrl}`,
    3000,
  );

  return blockRuns.map((blocks, idx) => ({
    text: idx === 0 ? fallbackBase : truncateStr(`続き v${notifyVersion}: ${releaseUrl}`, 3000),
    blocks,
  }));
}

async function postSlackPayload(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Slack webhook error: ${res.status} ${err}`);
  }
}

async function postToSlackRich(args) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const { release, notifyVersion, lastVersion, body, summaryLine, sections } = args;
  const releaseUrl = release.html_url || releaseTagUrl(release.tag_name);

  const payloads = buildSlackBlocksPayloadList({
    release,
    notifyVersion,
    lastVersion,
    summaryLine,
    sections: sections.length ? sections : parseBodyIntoSections(body),
    releaseUrl,
  });

  try {
    for (let i = 0; i < payloads.length; i++) {
      await postSlackPayload(webhookUrl, payloads[i]);
      if (i < payloads.length - 1) await sleep(1000);
    }
  } catch (e) {
    console.warn('Slack blocks 送信に失敗、プレーンテキストにフォールバック:', e.message);
    const plain =
      (lastVersion === '0.0.0'
        ? `*Claude Code v${notifyVersion} - 初回チェック*\n\n`
        : `*Claude Code v${notifyVersion} リリース* (前回: v${lastVersion})\n\n`) +
      (summaryLine ? `${summaryLine}\n\n` : '') +
      (body || '（本文なし）');
    const chunks = splitMessage(plain, 3000);
    for (let i = 0; i < chunks.length; i++) {
      await postSlackPayload(webhookUrl, { text: chunks[i] });
      if (i < chunks.length - 1) await sleep(1000);
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

  if (!isNewerThan(latestVersion, lastVersion)) {
    if (latestVersion === lastVersion) {
      console.log(`最新バージョンに変化なし: ${latestVersion}`);
    } else {
      console.log(
        `取得バージョンが記録より古いためスキップ: ${latestVersion}（記録: ${lastVersion}）`,
      );
    }
    return;
  }

  console.log(`新バージョン検出: ${latestVersion} (前回: ${lastVersion})`);

  let newReleases = await fetchReleasesSince(lastVersion);
  /** 複数件のときは古い順に通知（読みやすさのため API は新しい順） */
  newReleases = [...newReleases].reverse();

  const dryRun = process.env.DRY_RUN === 'true';

  for (let i = 0; i < newReleases.length; i++) {
    const release = newReleases[i];
    const notifyVersion = release.tag_name.replace(/^v/, '');
    const entry = `## ${release.tag_name}\n\n${release.body || '（リリースノートなし）'}`;
    const groups = categorizeAndGroup(entry);
    const summaryLine = buildSummaryLine(groups);
    const groupedEnglish = buildGroupedText(groups);

    console.log(`リリースノートを翻訳中... v${notifyVersion}`);
    const translatedRaw = await translateToJapanese(
      groupedEnglish || '（箇条書きなし）',
      notifyVersion,
    );
    const body = normalizeTranslatedBody(translatedRaw);
    const sections = parseBodyIntoSections(body);

    const args = {
      release,
      notifyVersion,
      lastVersion,
      body,
      summaryLine,
      sections,
    };

    if (dryRun) {
      const releaseUrl = release.html_url || releaseTagUrl(release.tag_name);
      console.log(`\n--- DRY_RUN: v${notifyVersion} ---`);
      console.log('Summary:', summaryLine);
      console.log(
        'Discord payload:',
        JSON.stringify(
          buildDiscordEmbedPayload({
            release,
            notifyVersion,
            lastVersion,
            summaryLine,
            sections,
            releaseUrl,
          }),
          null,
          2,
        ),
      );
      console.log(
        'Slack payloads:',
        JSON.stringify(
          buildSlackBlocksPayloadList({
            release,
            notifyVersion,
            lastVersion,
            summaryLine,
            sections,
            releaseUrl,
          }),
          null,
          2,
        ),
      );
      console.log('--- end ---\n');
    } else {
      await postToDiscordRich(args);
      console.log(`Discord への通知が完了しました (v${notifyVersion})`);

      const slackSent = await postToSlackRich(args);
      if (slackSent) {
        console.log(`Slack への通知が完了しました (v${notifyVersion})`);
      } else {
        console.log('SLACK_WEBHOOK_URL が未設定のため Slack 通知をスキップしました');
      }

      const structured = await translateToStructuredJapanese(groups, notifyVersion);
      writeVersionSiteData(DATA_DIR, {
        release,
        version: notifyVersion,
        groups,
        sections: structured.sections,
      });
      console.log(`サイトデータを書き出しました (v${notifyVersion})`);
    }

    if (i < newReleases.length - 1) await sleep(1000);
  }

  if (!dryRun) {
    writeLastVersion(latestVersion);
    console.log(`状態を ${latestVersion} に更新しました`);
    rebuildVersionsIndex(DATA_DIR);
    console.log('サイトのバージョン一覧 (versions.json) を再生成しました');
  } else {
    console.log('DRY_RUN: state/last-version.txt は更新していません');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
