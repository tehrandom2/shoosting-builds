(() => {
  "use strict";

  const state = {
    releases: [],
    query: "",
    sortAsc: false,
  };

  const els = {
    stats: {
      count: document.querySelector('[data-stat="count"]'),
      downloads: document.querySelector('[data-stat="downloads"]'),
      platforms: document.querySelector('[data-stat="platforms"]'),
      span: document.querySelector('[data-stat="span"]'),
    },
    latestSlot: document.getElementById("latest-slot"),
    list: document.getElementById("list"),
    empty: document.getElementById("empty"),
    emptyQuery: document.getElementById("empty-query"),
    search: document.getElementById("search"),
    sortToggle: document.getElementById("sortToggle"),
    tpl: document.getElementById("release-tpl"),
    generatedAt: document.getElementById("generated-at"),
  };

  // -- helpers -------------------------------------------------------------

  function fmtBytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function fmtRelative(iso) {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - then);
    const min = 60000, hr = 3600000, day = 86400000;
    if (diff < hr) return `${Math.max(1, Math.round(diff / min))}m ago`;
    if (diff < day) return `${Math.round(diff / hr)}h ago`;
    if (diff < day * 30) return `${Math.round(diff / day)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function platformOf(name) {
    const n = name.toLowerCase();
    if (n.includes("win")) return { label: "Windows", icon: iconWindows };
    if (n.includes("linux")) return { label: "Linux", icon: iconLinux };
    if (n.includes("mac") || n.includes("osx") || n.includes("darwin")) return { label: "macOS", icon: iconApple };
    return { label: name, icon: iconFile };
  }

  function codeOf(tag) {
    const stripped = tag.replace(/^dev-/, "").replace(/^v/, "");
    return stripped.slice(0, 2).toUpperCase() || "??";
  }

  function renderMarkdown(md) {
    if (!md) return "<p>No notes for this build.</p>";
    const raw = window.marked ? window.marked.parse(md) : md;
    return window.DOMPurify ? window.DOMPurify.sanitize(raw) : raw;
  }

  const iconWindows = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.3 6.5 1.4v6.1H0zm7.3-1L16 0v7.5H7.3zM0 8.5h6.5v6.1L0 13.7zm7.3 0H16V16l-8.6-1.2z"/></svg>`;
  const iconLinux = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c1.5 0 2.3 1.6 2.3 3.4 0 .9-.2 1.5-.4 2.1.5.3 1.1.9 1.5 1.8.6 1.3.6 2.9.1 4.1.4.3.6.8.5 1.3-.2.9-1.4 1.5-2.3 1.9-.7.3-1.2.9-2 1.2-.6.2-1.3.2-1.9 0-.8-.3-1.3-.9-2-1.2-.9-.4-2.1-1-2.3-1.9-.1-.5.1-1 .5-1.3-.5-1.2-.5-2.8.1-4.1.4-.9 1-1.5 1.5-1.8-.2-.6-.4-1.2-.4-2.1C3.2 1.6 4.5 0 6 0h2z"/></svg>`;
  const iconApple = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.2 0c.1 1-.3 2-.9 2.7-.6.7-1.6 1.3-2.5 1.2-.1-1 .4-2 .9-2.6C9.4.6 10.4.1 11.2 0zM13.9 11.6c-.4.9-.6 1.3-1.1 2.1-.7 1.1-1.7 2.5-2.9 2.5-1.1 0-1.4-.7-2.9-.7s-1.8.7-2.9.7c-1.2 0-2.1-1.3-2.8-2.4-1.9-2.9-2.1-6.4-.9-8.2.8-1.3 2.1-2.1 3.3-2.1 1.2 0 2 .8 3 .8.9 0 1.6-.8 3-.8 1.1 0 2.2.6 3 1.6-2.6 1.4-2.2 5.1.2 6.5z"/></svg>`;
  const iconFile = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1h5l3 3v11H4V1zm5 0v3h3"/></svg>`;

  // -- rendering -------------------------------------------------------------

  function renderStats(all) {
    const totalDownloads = all.reduce(
      (sum, r) => sum + r.assets.reduce((s, a) => s + (a.download_count || 0), 0),
      0
    );
    const platforms = new Set();
    all.forEach((r) => r.assets.forEach((a) => platforms.add(platformOf(a.name).label)));
    els.stats.count.textContent = all.length;
    els.stats.downloads.textContent = totalDownloads.toLocaleString();
    els.stats.platforms.textContent = platforms.size;

    if (all.length) {
      const dates = all.map((r) => new Date(r.published_at).getTime());
      const spanDays = Math.max(1, Math.round((Math.max(...dates) - Math.min(...dates)) / 86400000));
      els.stats.span.textContent = spanDays;
    } else {
      els.stats.span.textContent = "0";
    }
  }

  function assetButton(a) {
    const p = platformOf(a.name);
    const btn = document.createElement("a");
    btn.className = "dl";
    btn.href = a.browser_download_url;
    btn.innerHTML = `${p.icon}<span class="dl__plat">${p.label}</span><span class="dl__size">${fmtBytes(a.size)}</span>`;
    return btn;
  }

  function renderLatest(release) {
    if (!release) {
      els.latestSlot.innerHTML = `<p class="empty">No builds published yet.</p>`;
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "spot";
    wrap.innerHTML = `
      <div class="spot__inner">
        <p class="spot__eyebrow">Latest build</p>
        <h3 class="spot__title">${escapeHtml(release.name || release.tag_name)}</h3>
        <div class="spot__meta">
          <span class="tag">${escapeHtml(release.tag_name)}</span>
          <span class="time">${fmtRelative(release.published_at)}</span>
          ${release.prerelease ? '<span class="badge badge--pre">pre-release</span>' : ""}
        </div>
        <div class="spot__notes" data-spot-notes>${renderMarkdown(release.body)}</div>
        <button class="spot__more" type="button" data-spot-more>Read full notes</button>
        <div class="spot__assets" data-spot-assets></div>
      </div>
    `;
    const assetsEl = wrap.querySelector("[data-spot-assets]");
    release.assets.forEach((a) => assetsEl.appendChild(assetButton(a)));

    const notesEl = wrap.querySelector("[data-spot-notes]");
    const moreBtn = wrap.querySelector("[data-spot-more]");
    moreBtn.addEventListener("click", () => {
      const expanded = notesEl.classList.toggle("is-expanded");
      moreBtn.textContent = expanded ? "Show less" : "Read full notes";
    });

    els.latestSlot.innerHTML = "";
    els.latestSlot.appendChild(wrap);
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  function renderList(releases) {
    els.list.innerHTML = "";
    releases.forEach((release) => {
      const node = els.tpl.content.cloneNode(true);
      const head = node.querySelector(".card__head");
      const body = node.querySelector("[data-body]");

      node.querySelector("[data-code]").textContent = codeOf(release.tag_name);
      node.querySelector("[data-title]").textContent = release.name || release.tag_name;
      node.querySelector("[data-tag]").textContent = release.tag_name;
      node.querySelector("[data-time]").textContent = fmtRelative(release.published_at);
      if (release.prerelease) node.querySelector("[data-prerelease]").hidden = false;

      node.querySelector("[data-notes]").innerHTML = renderMarkdown(release.body);
      const assetsEl = node.querySelector("[data-assets]");
      release.assets.forEach((a) => assetsEl.appendChild(assetButton(a)));

      head.addEventListener("click", () => {
        const open = head.getAttribute("aria-expanded") === "true";
        head.setAttribute("aria-expanded", String(!open));
        body.hidden = open;
      });

      els.list.appendChild(node);
    });
  }

  function applyFilters() {
    const q = state.query.trim().toLowerCase();
    let filtered = state.releases;
    if (q) {
      filtered = filtered.filter((r) => {
        const hay = `${r.name} ${r.tag_name} ${r.body}`.toLowerCase();
        return hay.includes(q);
      });
    }
    filtered = [...filtered].sort((a, b) => {
      const da = new Date(a.published_at).getTime();
      const db = new Date(b.published_at).getTime();
      return state.sortAsc ? da - db : db - da;
    });

    els.empty.hidden = filtered.length !== 0 || !q;
    els.emptyQuery.textContent = state.query;
    renderList(filtered);
  }

  // -- wiring -------------------------------------------------------------

  els.search.addEventListener("input", (e) => {
    state.query = e.target.value;
    applyFilters();
  });

  els.sortToggle.addEventListener("click", () => {
    state.sortAsc = !state.sortAsc;
    els.sortToggle.setAttribute("aria-pressed", String(state.sortAsc));
    els.sortToggle.querySelector("[data-sort-label]").textContent = state.sortAsc
      ? "Oldest first"
      : "Newest first";
    applyFilters();
  });

  async function init() {
    try {
      const res = await fetch("releases.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`releases.json: ${res.status}`);
      const data = await res.json();
      state.releases = data.filter((r) => r.assets && r.assets.length);

      const newest = [...state.releases].sort(
        (a, b) => new Date(b.published_at) - new Date(a.published_at)
      )[0];

      renderStats(state.releases);
      renderLatest(newest);
      applyFilters();
    } catch (err) {
      els.latestSlot.innerHTML = `<p class="empty">Couldn&rsquo;t load releases.json (${escapeHtml(err.message)}). If this page was just deployed, the build workflow may still be running.</p>`;
      els.list.innerHTML = "";
    } finally {
      if (els.generatedAt) {
        els.generatedAt.textContent = new Date().toLocaleString();
        els.generatedAt.setAttribute("datetime", new Date().toISOString());
      }
    }
  }

  init();
})();
