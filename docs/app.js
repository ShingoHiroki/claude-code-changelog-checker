const CATEGORY_META = {
  '破壊的変更': { iconClass: 'icon-breaking', icon: '!' },
  '新機能':     { iconClass: 'icon-new',      icon: '+' },
  '改善':       { iconClass: 'icon-improve',  icon: '↑' },
  'その他':     { iconClass: 'icon-other',    icon: '→' },
  'バグ修正':   { iconClass: 'icon-fix',      icon: '✕' },
};

let VERSIONS = [];
let latestVersion = null;
const detailCache = new Map();

/**
 * ISO8601文字列を日本時間の yyyy/MM/dd 形式に整形する。
 * 不正な日付の場合は空文字を返す。
 */
function formatDateJST(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // en-CA ロケールは yyyy-MM-dd を安定して返すため、区切り文字だけ置換する
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return formatted.replace(/-/g, '/');
}

function appendRichText(parent, text) {
  const parts = String(text ?? '').split('`');
  parts.forEach((part, i) => {
    if (part === '') return;
    if (i % 2 === 1) {
      const c = document.createElement('code');
      c.textContent = part.trim();
      parent.appendChild(c);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

function renderSidebar(listEl, current) {
  listEl.replaceChildren();
  for (const v of VERSIONS) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#/' + encodeURIComponent(v.version);
    if (v.version === current) a.setAttribute('aria-current', 'page');
    const label = document.createElement('span');
    label.textContent = 'v' + v.version;
    if (v.hasBreakingChanges) {
      const dot = document.createElement('span');
      dot.className = 'breaking-dot';
      dot.title = '破壊的変更あり';
      label.appendChild(dot);
    }
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = formatDateJST(v.publishedAt);
    a.append(label, date);
    li.appendChild(a);
    listEl.appendChild(li);
  }
}

function renderErrorContent(message) {
  const content = document.getElementById('content');
  content.replaceChildren();
  const inner = document.createElement('div');
  inner.className = 'content-inner';
  const p = document.createElement('p');
  p.textContent = message;
  p.style.color = 'var(--text-secondary)';
  p.style.margin = '2rem';
  inner.appendChild(p);
  content.appendChild(inner);
}

function renderContent(detail) {
  const content = document.getElementById('content');
  content.replaceChildren();
  const inner = document.createElement('div');
  inner.className = 'content-inner';

  const hero = document.createElement('header');
  hero.className = 'hero';
  const logo = document.createElement('img');
  logo.className = 'logo';
  logo.src = 'claudecode-color.svg';
  logo.alt = '';
  const box = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.className = 'release-title';
  h1.append('Claude Code ');
  const ver = document.createElement('span');
  ver.className = 'ver';
  ver.textContent = detail.version;
  h1.appendChild(ver);
  const meta = document.createElement('div');
  meta.className = 'release-meta';
  const date = document.createElement('span');
  date.textContent = formatDateJST(detail.publishedAt) + ' 公開';
  const link = document.createElement('a');
  link.href = detail.releaseUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'GitHub Release ↗';
  meta.append(date, link);
  box.append(h1, meta);
  hero.append(logo, box);
  inner.appendChild(hero);

  const sections = Array.isArray(detail.sections) ? detail.sections : [];
  if (sections.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = '（リリースノートなし）';
    empty.style.color = 'var(--text-secondary)';
    empty.style.margin = '2rem 0 0 0.5rem';
    inner.appendChild(empty);
  }

  for (const section of sections) {
    const metaInfo = CATEGORY_META[section.category] || CATEGORY_META['その他'];
    const sec = document.createElement('section');
    sec.className = 'category';

    const head = document.createElement('div');
    head.className = 'category-header';
    const name = document.createElement('h2');
    name.className = 'category-name';
    name.textContent = section.category;
    const count = document.createElement('span');
    count.className = 'category-count';
    count.textContent = section.items.length + '件';
    head.append(name, count);
    sec.appendChild(head);

    for (const item of section.items) {
      const row = document.createElement('article');
      row.className = 'item';
      const icon = document.createElement('span');
      icon.className = 'item-icon ' + metaInfo.iconClass;
      icon.textContent = metaInfo.icon;
      icon.setAttribute('aria-hidden', 'true');
      const body = document.createElement('div');
      const h3 = document.createElement('h3');
      appendRichText(h3, item.title);
      const p = document.createElement('p');
      appendRichText(p, item.description);
      body.append(h3, p);
      row.append(icon, body);
      sec.appendChild(row);
    }
    inner.appendChild(sec);
  }

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.textContent = 'AIによる自動翻訳';
  inner.appendChild(footer);

  content.appendChild(inner);
}

async function loadVersionDetail(version) {
  if (detailCache.has(version)) return detailCache.get(version);
  const res = await fetch('data/' + encodeURIComponent(version) + '.json');
  if (!res.ok) throw new Error('detail fetch failed: ' + res.status);
  const data = await res.json();
  detailCache.set(version, data);
  return data;
}

async function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\//, ''));
  let version = hash;
  if (!hash || !VERSIONS.some((x) => x.version === hash)) {
    version = latestVersion;
    history.replaceState(null, '', '#/' + encodeURIComponent(version));
  }

  renderSidebar(document.getElementById('version-list'), version);
  renderSidebar(document.getElementById('version-list-mobile'), version);
  document.querySelector('.mobile-nav')?.removeAttribute('open');

  try {
    const detail = await loadVersionDetail(version);
    renderContent(detail);
  } catch (err) {
    renderErrorContent('データを取得できませんでした（' + version + '）');
  }
}

async function init() {
  try {
    const res = await fetch('data/versions.json');
    if (!res.ok) throw new Error('versions fetch failed: ' + res.status);
    const data = await res.json();
    VERSIONS = Array.isArray(data.versions) ? data.versions : [];
    latestVersion = data.latest || (VERSIONS[0] && VERSIONS[0].version) || null;
  } catch (err) {
    renderErrorContent('データを取得できませんでした（バージョン一覧）');
    return;
  }

  if (!latestVersion) {
    renderErrorContent('表示できるリリースがありません');
    return;
  }

  window.addEventListener('hashchange', route);
  route();
}

init();
