/* ანალიტიკოსის ვაკანსიები — კლიენტის აპი (ფრეიმვორკის გარეშე) */
(() => {
  "use strict";

  // ------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("aj:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("aj:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const MONTHS = ["იან", "თებ", "მარ", "აპრ", "მაი", "ივნ", "ივლ", "აგვ", "სექ", "ოქტ", "ნოე", "დეკ"];
  const MONTHS_FULL = ["იანვარი", "თებერვალი", "მარტი", "აპრილი", "მაისი", "ივნისი", "ივლისი", "აგვისტო", "სექტემბერი", "ოქტომბერი", "ნოემბერი", "დეკემბერი"];
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const parseISO = (s) => (s ? new Date(s.slice(0, 10) + "T00:00:00") : null);
  const fmtDate = (s) => { const d = parseISO(s); return d ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : "—"; };
  const daysLeft = (s) => { const d = parseISO(s); if (!d) return null; return Math.round((d - parseISO(todayISO())) / 864e5); };
  const RATE = { "₾": 1, "$": 2.7, "€": 2.95 };
  const salGEL = (j) => { const s = j.salary; if (!s) return null; const v = s.to && s.from ? (s.from + s.to) / 2 : s.from || s.to; return Math.round(v * (RATE[s.cur] || 1)); };
  const fmtNum = (n) => n == null ? "" : n.toLocaleString("en-US").replace(/,/g, "\u00a0");
  const fmtSal = (s) => {
    if (!s) return "";
    if (s.from && s.to && s.from !== s.to) return `${fmtNum(s.from)}–${fmtNum(s.to)} ${s.cur}`;
    return `${fmtNum(s.from || s.to)} ${s.cur}`;
  };
  const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : Math.round((b[m - 1] + b[m]) / 2); };
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) | 0; return Math.abs(h); };
  const LOGO_COLORS = ["#4c7fd9", "#3b8fb5", "#5a6fd1", "#2f8f9d", "#6b7fc4", "#3f74b8", "#4a90c2", "#5c82a8"];

  const ICON = {
    money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.9M6.6 7.6A17 17 0 0 0 2.5 12S6 18 12 18a9.5 9.5 0 0 0 4-.9"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  };

  // ------------------------------------------------------------ state
  const DEFAULT_FILTERS = {
    q: "", sites: [], dirs: [], levels: [], salaryOnly: false, minSalary: "", remote: false,
    english: false, soon: false, newOnly: false, showExpired: false, showHidden: false,
  };
  const S = {
    jobs: [], meta: null, updated: null,
    tab: "all",
    filters: { ...DEFAULT_FILTERS, ...store.get("filters", {}), q: "", newOnly: false },
    sort: store.get("sort", "new"),
    status: store.get("status", {}), // id -> saved | applied | hidden
    prevVisit: store.get("prevVisit", null),
  };

  // "ახალი" = დაემატა შენი წინა ვიზიტის შემდეგ
  (() => {
    const last = store.get("lastVisit", null);
    const sessionMark = sessionStorage.getItem("aj:session");
    if (!sessionMark) {
      S.prevVisit = last;
      store.set("prevVisit", last);
      store.set("lastVisit", new Date().toISOString());
      try { sessionStorage.setItem("aj:session", "1"); } catch { /* ignore */ }
    }
  })();
  const isNew = (j) => !!S.prevVisit && j.firstSeen && new Date(j.firstSeen) > new Date(S.prevVisit);

  // ------------------------------------------------------------ theme
  const applyTheme = () => {
    const t = store.get("theme", "auto");
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  };
  applyTheme();

  // ------------------------------------------------------------ data
  async function loadData(bust = false) {
    const t = bust ? `?t=${Date.now()}` : `?d=${todayISO()}`;
    const [jr, mr] = await Promise.all([fetch("data/jobs.json" + t, { cache: bust ? "no-store" : "default" }), fetch("data/meta.json" + t, { cache: "no-store" })]);
    if (!jr.ok) throw new Error("jobs.json " + jr.status);
    const data = await jr.json();
    S.jobs = data.jobs || [];
    S.updated = data.updated;
    S.meta = mr.ok ? await mr.json() : null;
    const u = new Date(S.updated);
    $("#updated").textContent = isNaN(u) ? "" : `განახლდა: ${u.getDate()} ${MONTHS[u.getMonth()]}, ${String(u.getHours()).padStart(2, "0")}:${String(u.getMinutes()).padStart(2, "0")}`;
  }

  // ------------------------------------------------------------ filtering
  function matches(j, f = S.filters, ignore = {}) {
    const st = S.status[j.id];
    if (!f.showHidden && st === "hidden") return false;
    if (!f.showExpired && !j.active) return false;
    if (f.q) {
      const hay = `${j.title} ${j.company} ${(j.skills || []).join(" ")} ${j.direction} ${j.location} ${j.level}`.toLowerCase();
      if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    if (!ignore.sites && f.sites.length && !j.sources.some((s) => f.sites.includes(s.site))) return false;
    if (!ignore.dirs && f.dirs.length && !f.dirs.includes(j.direction)) return false;
    if (!ignore.levels && f.levels.length && !f.levels.includes(j.level)) return false;
    if (f.salaryOnly && !j.salary) return false;
    if (f.minSalary && (salGEL(j) || 0) < +f.minSalary) return false;
    if (f.remote && !j.remote) return false;
    if (f.english && !(j.languages || []).includes("ინგლისური")) return false;
    if (f.soon) { const d = daysLeft(j.deadline); if (d == null || d < 0 || d > 7) return false; }
    if (f.newOnly && !isNew(j)) return false;
    return true;
  }

  function sorted(list) {
    const by = {
      new: (a, b) => (b.published || "").localeCompare(a.published || "") || (b.firstSeen || "").localeCompare(a.firstSeen || ""),
      deadline: (a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"),
      salary: (a, b) => (salGEL(b) || -1) - (salGEL(a) || -1),
      company: (a, b) => a.company.localeCompare(b.company, "ka"),
    }[S.sort];
    return [...list].sort(by);
  }

  const activeFilterCount = () => {
    const f = S.filters;
    return f.sites.length + f.dirs.length + f.levels.length + (f.minSalary ? 1 : 0) + (f.showExpired ? 1 : 0) + (f.showHidden ? 1 : 0);
  };

  // ------------------------------------------------------------ pieces
  function logoHTML(j, cls = "") {
    const letter = (j.company || "?").replace(/^(სს|შპს|ს\.ს\.|შ\.პ\.ს\.)\s*/i, "").replace(/["'„“]/g, "").trim().charAt(0).toUpperCase() || "?";
    const color = LOGO_COLORS[hash(j.company || "") % LOGO_COLORS.length];
    const ph = `<div class="logo ph ${cls}" style="background:${color}">${esc(letter)}</div>`;
    if (!j.logo) return ph;
    return `<div class="logo ${cls}"><img src="${esc(j.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ph="${esc(letter)}" data-color="${color}"></div>`;
  }
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.dataset.ph) {
      const box = img.parentElement;
      box.classList.add("ph");
      box.style.background = img.dataset.color;
      box.textContent = img.dataset.ph;
    }
  }, true);

  function leftHTML(j) {
    const d = daysLeft(j.deadline);
    if (d == null) return "";
    if (d < 0) return `<span class="left over">ვადა გავიდა</span>`;
    if (d === 0) return `<span class="left soon">დღეს იწურება</span>`;
    return `<span class="left ${d <= 7 ? "soon" : ""}">დარჩა ${d} დღე</span>`;
  }

  function tagsHTML(j) {
    const t = [];
    if (isNew(j)) t.push(`<span class="tag new">ახალი</span>`);
    const st = S.status[j.id];
    if (st === "saved") t.push(`<span class="tag status-saved">★ შენახული</span>`);
    if (st === "applied") t.push(`<span class="tag status-applied">✓ გაგზავნილი</span>`);
    t.push(`<span class="tag lvl">${esc(j.level)}</span>`);
    t.push(`<span class="tag">${esc(j.direction)}</span>`);
    if (j.remote) t.push(`<span class="tag">${j.remote === "hybrid" ? "ჰიბრიდული" : "დისტანციური"}</span>`);
    if (!j.active) t.push(`<span class="tag">არააქტიური</span>`);
    return `<div class="tags">${t.join("")}</div>`;
  }

  function rowHTML(j) {
    const sal = j.salary ? `<span class="salary">${esc(fmtSal(j.salary))}</span>` : `<span class="salary none">არ არის მითითებული</span>`;
    const src = j.sources.map((s) => esc(s.site)).join(", ");
    return `<tr data-id="${j.id}" class="${j.active ? "" : "inactive"}">
      <td class="c-logo">${logoHTML(j)}</td>
      <td class="c-company"><div class="co-name" title="${esc(j.company)}">${esc(j.company)}</div></td>
      <td class="c-title">
        <div class="title">${esc(j.title)}</div>
        <div class="co-mobile">${esc(j.company)}</div>
        ${tagsHTML(j)}
      </td>
      <td class="c-sal">${sal}</td>
      <td class="c-pub"><span class="date">${fmtDate(j.published)}</span></td>
      <td class="c-dl"><span class="date">${fmtDate(j.deadline)}</span><br>${leftHTML(j)}</td>
      <td class="c-src"><span class="src">${src}</span></td>
      <td class="c-act"><button class="sum-btn" data-sum="${j.id}">მოკლედ</button></td>
      <td class="c-meta">
        <div class="meta-line">
          <span class="meta-item">${ICON.money}${j.salary ? esc(fmtSal(j.salary)) : "—"}</span>
          <span class="meta-item">${ICON.cal}${fmtDate(j.published)} → ${fmtDate(j.deadline)}</span>
          ${leftHTML(j)}
          <button class="sum-btn" data-sum="${j.id}">მოკლედ</button>
        </div>
      </td>
    </tr>`;
  }

  function tableHTML(list) {
    if (!list.length) return `<div class="empty">ამ ფილტრებით ვაკანსია ვერ მოიძებნა.<br><br><button class="chip" data-action="reset">ფილტრების გასუფთავება</button></div>`;
    return `<div class="table-wrap"><table>
      <thead><tr><th></th><th>კომპანია</th><th>პოზიცია</th><th>ხელფასი</th><th>დაიდო</th><th>ბოლო ვადა</th><th>წყარო</th><th></th></tr></thead>
      <tbody>${list.map(rowHTML).join("")}</tbody></table></div>`;
  }

  // ------------------------------------------------------------ quick chips
  const QUICK = [
    { key: "newOnly", label: "🆕 ახალი" },
    { key: "salaryOnly", label: "💰 ხელფასით" },
    { key: "soon", label: "⏳ 7 დღეში იწურება" },
    { key: "remote", label: "🏠 დისტანციური / ჰიბრიდი" },
    { key: "english", label: "🇬🇧 ინგლისური" },
    { level: "Junior", label: "Junior" },
    { level: "სტაჟირება", label: "სტაჟირება" },
  ];
  function renderChips() {
    $("#quickChips").innerHTML = QUICK.map((c, i) => {
      const on = c.key ? S.filters[c.key] : S.filters.levels.includes(c.level);
      return `<button class="chip" data-quick="${i}" aria-pressed="${on}">${esc(c.label)}</button>`;
    }).join("");
    const n = activeFilterCount();
    $("#filterCount").hidden = !n;
    $("#filterCount").textContent = n;
  }

  // ------------------------------------------------------------ views
  function render() {
    renderChips();
    document.querySelectorAll(".nav button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === S.tab ? "page" : "false"));
    const newCount = S.jobs.filter((j) => j.active && isNew(j)).length;
    $("#newBadge").hidden = !newCount;
    $("#newBadge").textContent = newCount;
    $("#listControls").hidden = S.tab === "stats";
    $("#sort").value = S.sort;
    const view = $("#view");
    if (S.tab === "all") view.innerHTML = viewAll();
    else if (S.tab === "month") view.innerHTML = viewMonth();
    else if (S.tab === "stats") view.innerHTML = viewStats();
    else view.innerHTML = viewMine();
    $("#pageTitle").textContent = { all: "ანალიტიკოსის ვაკანსიები", month: "დაემატა ამ თვეში", stats: "სტატისტიკა", mine: "ჩემი ვაკანსიები" }[S.tab];
  }

  function viewAll() {
    const list = sorted(S.jobs.filter((j) => matches(j)));
    const total = S.jobs.filter((j) => j.active).length;
    $("#resultCount").textContent = `${list.length} ვაკანსია${list.length !== total ? ` (სულ ${total})` : ""}`;
    return tableHTML(list);
  }

  function viewMonth() {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const list = S.jobs
      .filter((j) => (j.published || "").startsWith(ym) && matches(j, { ...S.filters, showExpired: true }))
      .sort((a, b) => (b.published || "").localeCompare(a.published || "") || (b.firstSeen || "").localeCompare(a.firstSeen || ""));
    $("#resultCount").textContent = `${MONTHS_FULL[now.getMonth()]}: ${list.length} ვაკანსია · უახლესიდან ძველამდე`;
    if (!list.length) return `<div class="empty">ამ თვეში ჯერ ვაკანსია არ დამატებულა (ან ფილტრებს არ ემთხვევა).</div>`;
    const groups = new Map();
    for (const j of list) { if (!groups.has(j.published)) groups.set(j.published, []); groups.get(j.published).push(j); }
    const today = todayISO();
    const yest = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    let out = "";
    for (const [day, items] of groups) {
      const label = day === today ? "დღეს" : day === yest ? "გუშინ" : `${parseISO(day).getDate()} ${MONTHS_FULL[parseISO(day).getMonth()]}`;
      out += `<div class="day-head">${label} · ${items.length}</div>${tableHTML(items)}`;
    }
    return out;
  }

  function barRows(entries, total, { filterKey } = {}) {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return `<div class="bars">${entries.map(([label, n]) => `
      <div class="bar-row ${filterKey ? "clickable" : ""}" ${filterKey ? `data-filter="${filterKey}" data-value="${esc(label)}"` : ""} title="${esc(label)}: ${n}${total ? ` (${Math.round((n / total) * 100)}%)` : ""}">
        <span class="lbl">${esc(label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(n / max) * 100}%"></span></span>
        <span class="val">${total ? Math.round((n / total) * 100) + "%" : n}</span>
      </div>`).join("")}</div>`;
  }
  const countBy = (list, fn) => {
    const m = new Map();
    for (const j of list) for (const k of [].concat(fn(j)).filter(Boolean)) m.set(k, (m.get(k) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  function viewStats() {
    const act = S.jobs.filter((j) => j.active);
    const n = act.length || 1;
    const withSal = act.filter((j) => j.salary);
    const sals = withSal.map(salGEL).filter(Boolean);
    const week = new Date(); week.setDate(week.getDate() - 7);
    const weekISO = week.toISOString().slice(0, 10);
    const newWeek = act.filter((j) => (j.published || "") >= weekISO).length;
    const eng = act.filter((j) => (j.languages || []).includes("ინგლისური")).length;

    const levels = ["სტაჟირება", "Junior", "Middle", "Senior"];
    const salRows = levels.map((l) => {
      const v = withSal.filter((j) => j.level === l).map(salGEL);
      if (!v.length) return `<tr><td>${l}</td><td colspan="3" style="color:var(--muted)">მონაცემი არ არის</td><td>0</td></tr>`;
      return `<tr><td>${l}</td><td>${fmtNum(Math.min(...v))}</td><td><b>${fmtNum(median(v))}</b></td><td>${fmtNum(Math.max(...v))}</td><td>${v.length}</td></tr>`;
    }).join("");
    const dirSal = countBy(withSal, (j) => j.direction).map(([d]) => {
      const v = withSal.filter((j) => j.direction === d).map(salGEL);
      return `<tr><td>${esc(d)}</td><td>${fmtNum(Math.min(...v))}</td><td><b>${fmtNum(median(v))}</b></td><td>${fmtNum(Math.max(...v))}</td><td>${v.length}</td></tr>`;
    }).join("");

    const srcStatus = (S.meta?.sources || []).map((s) => `<div><span>${esc(s.site)}</span><span class="${s.ok ? "ok" : "err"}">${s.ok ? `✓ ${s.count}` : "✗ ვერ ჩაიტვირთა"}</span></div>`).join("");

    return `
      <div class="kpis">
        <div class="kpi"><b>აქტიური ვაკანსია</b><span>${act.length}</span><small>${S.meta?.sources?.filter((s) => s.ok).length || "—"} საიტიდან</small></div>
        <div class="kpi"><b>ბოლო 7 დღეში</b><span>${newWeek}</span><small>ახალი განცხადება</small></div>
        <div class="kpi"><b>ხელფასი მითითებულია</b><span>${Math.round((withSal.length / n) * 100)}%</span><small>${withSal.length} ვაკანსიაში</small></div>
        <div class="kpi"><b>მედიანური ხელფასი</b><span>${sals.length ? fmtNum(median(sals)) + " ₾" : "—"}</span><small>სადაც მითითებულია</small></div>
      </div>
      <div class="cards">
        <div class="card"><h3>ყველაზე მოთხოვნადი უნარები</h3><p class="sub">რამდენ % ვაკანსიაში ითხოვენ · დააჭირე და გაფილტრე</p>${barRows(countBy(act, (j) => j.skills).slice(0, 12), n, { filterKey: "skill" })}</div>
        <div class="card"><h3>მიმართულებები</h3><p class="sub">ვაკანსიების რაოდენობა · დააჭირე და გაფილტრე</p>${barRows(countBy(act, (j) => j.direction), 0, { filterKey: "dir" })}
          <h3 style="margin-top:18px">დონე</h3><p class="sub">ვაკანსიების რაოდენობა</p>${barRows(countBy(act, (j) => j.level), 0, { filterKey: "level" })}</div>
        <div class="card"><h3>ხელფასები დონის მიხედვით, ₾</h3><p class="sub">მხოლოდ ვაკანსიები, სადაც ხელფასი წერია ($/€ გადაყვანილია ლარში)</p>
          <table class="sal-table"><thead><tr><th>დონე</th><th>მინ.</th><th>მედიანა</th><th>მაქს.</th><th>რაოდ.</th></tr></thead><tbody>${salRows}</tbody></table>
          <h3 style="margin-top:18px">ხელფასები მიმართულების მიხედვით, ₾</h3>
          <table class="sal-table"><thead><tr><th>მიმართულება</th><th>მინ.</th><th>მედიანა</th><th>მაქს.</th><th>რაოდ.</th></tr></thead><tbody>${dirSal || '<tr><td colspan="5">მონაცემი არ არის</td></tr>'}</tbody></table></div>
        <div class="card"><h3>ყველაზე აქტიური დამსაქმებლები</h3><p class="sub">ვინ ეძებს ყველაზე მეტ ანალიტიკოსს</p>${barRows(countBy(act, (j) => j.company).slice(0, 10), 0, { filterKey: "company" })}</div>
        <div class="card"><h3>ენები</h3><p class="sub">რა % ვაკანსიაში ითხოვენ</p>${barRows(countBy(act, (j) => j.languages), n)}
          <p class="sub" style="margin-top:12px">ინგლისურს ითხოვს ${eng} ვაკანსია ${n}-დან.</p></div>
        <div class="card"><h3>საიტები</h3><p class="sub">ბოლო შემოწმება · ერთი ვაკანსია შეიძლება რამდენიმე საიტზე იდოს</p>${barRows(countBy(act, (j) => j.sources.map((s) => s.site)), 0, { filterKey: "site" })}
          <h3 style="margin-top:18px">წყაროების სტატუსი</h3><div class="src-status">${srcStatus || "—"}</div></div>
      </div>`;
  }

  function viewMine() {
    const saved = sorted(S.jobs.filter((j) => S.status[j.id] === "saved" && matches(j, { ...S.filters, showExpired: true })));
    const applied = sorted(S.jobs.filter((j) => S.status[j.id] === "applied" && matches(j, { ...S.filters, showExpired: true })));
    const hidden = S.jobs.filter((j) => S.status[j.id] === "hidden").length;
    $("#resultCount").textContent = `★ ${saved.length} შენახული · ✓ ${applied.length} გაგზავნილი`;
    return `
      <p class="note">ვაკანსიას „მოკლედ“ ფანჯრიდან შეინახავ ★, მონიშნავ როგორც გაგზავნილს ✓ ან დამალავ. ეს მონიშვნები მხოლოდ ამ მოწყობილობაზე ინახება.</p>
      <div class="day-head">★ შენახული · ${saved.length}</div>
      ${saved.length ? tableHTML(saved) : `<div class="empty">ჯერ არაფერი შეგინახავს.</div>`}
      <div class="day-head">✓ CV გაგზავნილია · ${applied.length}</div>
      ${applied.length ? tableHTML(applied) : `<div class="empty">ჯერ არცერთზე არ მონიშნულა „გავაგზავნე“.</div>`}
      ${hidden ? `<div class="day-head">დამალული · ${hidden}</div><button class="chip" data-action="unhide">დამალულების დაბრუნება</button>` : ""}`;
  }

  // ------------------------------------------------------------ sheets
  function openSheet(html) {
    const sh = $("#sheet");
    sh.innerHTML = `<div class="grabber"></div>${html}`;
    sh.scrollTop = 0;
    sh.classList.add("open");
    $("#sheetBack").classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    $("#sheet").classList.remove("open");
    $("#sheetBack").classList.remove("open");
    document.body.style.overflow = "";
    if (location.hash.startsWith("#job=")) history.replaceState(null, "", location.pathname + location.search);
  }

  function summaryHTML(j) {
    const s = j.summary || {};
    const d = daysLeft(j.deadline);
    const st = S.status[j.id];
    const list = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    const fact = (label, val) => `<div class="fact"><b>${label}</b><span>${val}</span></div>`;
    const deadlineTxt = j.deadline ? `${fmtDate(j.deadline)}${d != null ? (d < 0 ? " · გავიდა" : ` · ${d} დღე`) : ""}` : "არ არის მითითებული";
    return `
      <div class="sheet-head">
        ${logoHTML(j)}
        <div style="min-width:0">
          <h2>${esc(j.title)}</h2>
          <div class="co-name">${esc(j.company)}${j.location ? " · " + esc(j.location) : ""}</div>
        </div>
        <button class="close-x" data-action="close" aria-label="დახურვა">${ICON.x}</button>
      </div>
      <div class="facts">
        ${fact("💰 ხელფასი", j.salary ? esc(fmtSal(j.salary)) : "არ არის მითითებული")}
        ${fact("📈 დონე", esc(j.level))}
        ${fact("🗓 დაიდო", fmtDate(j.published))}
        ${fact("⏳ ბოლო ვადა", deadlineTxt)}
        ${fact("🧭 გამოცდილება", j.exp ? `${j.exp}+ წელი` : "არ წერია")}
        ${fact("📍 ფორმატი", j.remote === "remote" ? "დისტანციური" : j.remote === "hybrid" ? "ჰიბრიდული" : "ოფისი")}
        ${fact("🗣 ენები", j.languages?.length ? esc(j.languages.join(", ")) : "არ წერია")}
        ${fact("🏷 მიმართულება", esc(j.direction))}
      </div>
      ${j.skills?.length ? `<div class="sec"><h3>🛠 ხელსაწყოები და უნარები</h3><div class="skills">${j.skills.map((x) => `<span class="skill">${esc(x)}</span>`).join("")}</div></div>` : ""}
      ${s.duties?.length ? `<div class="sec"><h3>✅ რას გააკეთებ</h3>${list(s.duties)}</div>` : ""}
      ${s.reqs?.length ? `<div class="sec"><h3>🎯 რას ითხოვენ</h3>${list(s.reqs)}</div>` : ""}
      ${s.offers?.length ? `<div class="sec"><h3>🎁 რას გთავაზობენ</h3>${list(s.offers)}</div>` : ""}
      ${s.about ? `<div class="sec"><h3>ℹ️ მოკლედ კომპანიაზე / ვაკანსიაზე</h3><p>${esc(s.about)}</p></div>` : ""}
      ${!s.duties?.length && !s.reqs?.length && (j.textLen || 0) < 300 ? `<div class="sec"><p>ამ განცხადებას სრული აღწერა არ აქვს თავად საიტზე (ხშირად კომპანიის საკარიერო გვერდზე გადაჰყავს). გახსენი ორიგინალი ↓</p></div>` : ""}
      <div class="actions">
        <a class="btn primary" href="${esc(j.url)}" target="_blank" rel="noopener">${ICON.ext} ორიგინალი</a>
      </div>
      <div class="actions">
        <button class="btn saved" data-status="saved" aria-pressed="${st === "saved"}">${ICON.star} შენახვა</button>
        <button class="btn applied" data-status="applied" aria-pressed="${st === "applied"}">${ICON.check} გავაგზავნე</button>
        <button class="btn hidden" data-status="hidden" aria-pressed="${st === "hidden"}">${ICON.eyeOff} დამალვა</button>
      </div>
      ${j.sources.length > 1 ? `<div class="sec"><h3>სად დევს (${j.sources.length} საიტზე)</h3><div class="src-links">${j.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.site)} ↗</a>`).join("")}</div></div>` : `<div class="sec"><p class="src">წყარო: ${esc(j.sources[0]?.site || "")}</p></div>`}`;
  }

  let currentJob = null;
  function openJob(id) {
    const j = S.jobs.find((x) => x.id === id);
    if (!j) return;
    currentJob = j;
    openSheet(summaryHTML(j));
    history.replaceState(null, "", "#job=" + id);
  }

  function filtersHTML() {
    const f = S.filters;
    const act = S.jobs.filter((j) => j.active);
    const uniq = (fn) => countBy(act, fn).map((e) => e[0]);
    const chipset = (key, values) => `<div class="f-chips">${values.map((v) => `<button class="chip" data-fkey="${key}" data-fval="${esc(v)}" aria-pressed="${f[key].includes(v)}">${esc(v)}</button>`).join("")}</div>`;
    const sw = (key, label) => `<label class="f-row"><span>${label}</span><input type="checkbox" class="switch" data-fbool="${key}" ${f[key] ? "checked" : ""}></label>`;
    return `
      <div class="sheet-head"><h2>ფილტრები</h2><button class="close-x" data-action="close" aria-label="დახურვა">${ICON.x}</button></div>
      <div class="f-group"><b>საიტი</b>${chipset("sites", uniq((j) => j.sources.map((s) => s.site)))}</div>
      <div class="f-group"><b>მიმართულება</b>${chipset("dirs", uniq((j) => j.direction))}</div>
      <div class="f-group"><b>დონე</b>${chipset("levels", ["სტაჟირება", "Junior", "Middle", "Senior"])}</div>
      <div class="f-group"><b>მინიმალური ხელფასი (₾)</b><input class="inp" type="number" inputmode="numeric" placeholder="მაგ. 2000" id="minSalary" value="${esc(f.minSalary)}"></div>
      <div class="f-group">
        ${sw("salaryOnly", "მხოლოდ ხელფასით")}
        ${sw("soon", "ვადა 7 დღეში იწურება")}
        ${sw("remote", "დისტანციური / ჰიბრიდული")}
        ${sw("english", "ინგლისური საჭიროა")}
        ${sw("showExpired", "ვადაგასულებიც მაჩვენე")}
        ${sw("showHidden", "დამალულებიც მაჩვენე")}
      </div>
      <div class="actions">
        <button class="btn" data-action="reset">გასუფთავება</button>
        <button class="btn primary" data-action="close">ნახე ${S.jobs.filter((j) => matches(j)).length} ვაკანსია</button>
      </div>`;
  }

  function settingsHTML() {
    const repo = repoInfo();
    const tok = store.get("ghToken", "");
    const theme = store.get("theme", "auto");
    const topic = store.get("ntfyTopic", "");
    const srcStatus = (S.meta?.sources || []).map((s) => `<div><span>${esc(s.site)}</span><span class="${s.ok ? "ok" : "err"}">${s.ok ? `✓ ${s.count}` : "✗ ვერ ჩაიტვირთა"}</span></div>`).join("");
    return `
      <div class="sheet-head"><h2>პარამეტრები</h2><button class="close-x" data-action="close" aria-label="დახურვა">${ICON.x}</button></div>
      <div class="sec"><h3>📱 აიფონზე აპად დამატება</h3>
        <ol class="steps"><li>გახსენი ეს გვერდი <b>Safari</b>-ში</li><li>დააჭირე „გაზიარებას“ (□↑)</li><li>აირჩიე <b>„Add to Home Screen“ / „მთავარ ეკრანზე დამატება“</b></li></ol></div>
      <div class="sec"><h3>🔔 შეტყობინებები (ntfy)</h3>
        <ol class="steps">
          <li>App Store-დან დააყენე უფასო აპი <b>ntfy</b></li>
          <li>აპში დააჭირე <b>+</b> და ჩაწერე შენი თემის სახელი (topic), რომელიც GitHub-ში <code>NTFY_TOPIC</code> საიდუმლოდ შეინახე</li>
          <li>ყოველ დილით, თუ ახალი ვაკანსია დაემატა, შეტყობინება მოგივა</li>
        </ol>
        <div class="f-group"><b>შენი topic (შეხსენებისთვის, ინახება მხოლოდ აქ)</b><input class="inp" id="ntfyTopic" value="${esc(topic)}" placeholder="მაგ. luka-analyst-jobs-8f3k2">
        ${topic ? `<div class="actions"><a class="btn" href="https://ntfy.sh/${encodeURIComponent(topic)}" target="_blank" rel="noopener">ტესტისთვის გახსენი ntfy.sh-ზე ↗</a></div>` : ""}</div>
      </div>
      <div class="sec"><h3>🔄 განახლების ღილაკი</h3>
        <p>ღილაკი ყოველთვის ტვირთავს უახლეს შენახულ მონაცემს. რომ ღილაკმა საიტების <b>ახლავე ხელახლა შემოწმებაც</b> დაიწყოს, ჩასვი GitHub-ის ტოკენი (fine-grained, მხოლოდ ამ რეპოზე, უფლება: <b>Actions → Read and write</b>). ტოკენი მხოლოდ ამ ტელეფონზე ინახება.</p>
        <div class="f-group"><b>რეპოზიტორია</b><input class="inp" id="ghRepo" value="${esc(repo ? repo.owner + "/" + repo.repo : "")}" placeholder="owner/analyst-jobs"></div>
        <div class="f-group"><b>GitHub ტოკენი</b><input class="inp" id="ghToken" type="password" value="${esc(tok)}" placeholder="github_pat_…" autocomplete="off"></div>
      </div>
      <div class="sec"><h3>🎨 თემა</h3>
        <div class="f-chips">${[["auto", "ავტომატური"], ["light", "ღია"], ["dark", "მუქი"]].map(([v, l]) => `<button class="chip" data-theme="${v}" aria-pressed="${theme === v}">${l}</button>`).join("")}</div></div>
      <div class="sec"><h3>🌐 წყაროები (ბოლო შემოწმება)</h3><div class="src-status">${srcStatus || "—"}</div>
        <p class="src" style="margin-top:8px">ss.ge ავტომატურ წაკითხვას ბლოკავს, worknet.gov.ge და hr.gov.ge უცხოეთიდან მიუწვდომელია — ამიტომ ისინი სიაში არ არის.</p></div>
      <div class="actions"><button class="btn primary" data-action="saveSettings">შენახვა</button></div>`;
  }

  // ------------------------------------------------------------ refresh
  function repoInfo() {
    const saved = store.get("ghRepo", "");
    if (saved && saved.includes("/")) { const [owner, repo] = saved.split("/"); return { owner, repo }; }
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (m) { const repo = location.pathname.split("/").filter(Boolean)[0] || `${m[1]}.github.io`; return { owner: m[1], repo }; }
    return null;
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }

  async function refresh() {
    const btn = $("#refreshBtn");
    if (btn.classList.contains("spin")) return;
    btn.classList.add("spin");
    const before = S.updated;
    try {
      const tok = store.get("ghToken", "");
      const repo = repoInfo();
      if (tok && repo) {
        const r = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/workflows/scrape.yml/dispatches`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" },
          body: JSON.stringify({ ref: "main" }),
        });
        if (r.status === 204) {
          toast("შემოწმება დაიწყო — 3-6 წუთში განახლდება. შეგიძლია აპი დახურო.", 5000);
          for (let i = 0; i < 30; i++) {
            await new Promise((res) => setTimeout(res, 20000));
            await loadData(true);
            if (S.updated !== before) { render(); toast("✓ განახლდა! " + (S.meta?.new ? `${S.meta.new} ახალი ვაკანსია` : "ახალი ვაკანსია არ არის")); return; }
          }
          toast("ჯერ არ დასრულებულა — ცოტა ხანში ისევ სცადე");
          return;
        }
        toast(`GitHub-მა უარი თქვა (${r.status}) — შეამოწმე ტოკენი პარამეტრებში`, 4500);
      }
      await loadData(true);
      render();
      toast(S.updated !== before ? "✓ ჩაიტვირთა უახლესი მონაცემი" : "✓ უკვე უახლესი მონაცემია");
    } catch (e) {
      toast("ვერ განახლდა — შეამოწმე ინტერნეტი");
    } finally {
      btn.classList.remove("spin");
    }
  }

  // ------------------------------------------------------------ events
  function saveFilters() { const { q, newOnly, ...rest } = S.filters; store.set("filters", rest); }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, a, tr, .bar-row");
    if (!t) return;
    if (t.dataset.sum) { openJob(t.dataset.sum); return; }
    if (t.tagName === "TR" && t.dataset.id && !e.target.closest("a")) { openJob(t.dataset.id); return; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; render(); window.scrollTo({ top: 0 }); return; }
    if (t.dataset.quick != null) {
      const c = QUICK[+t.dataset.quick];
      if (c.key) S.filters[c.key] = !S.filters[c.key];
      else S.filters.levels = S.filters.levels.includes(c.level) ? S.filters.levels.filter((x) => x !== c.level) : [...S.filters.levels, c.level];
      saveFilters(); render(); return;
    }
    if (t.dataset.fkey) {
      const k = t.dataset.fkey, v = t.dataset.fval;
      S.filters[k] = S.filters[k].includes(v) ? S.filters[k].filter((x) => x !== v) : [...S.filters[k], v];
      t.setAttribute("aria-pressed", S.filters[k].includes(v));
      saveFilters(); render(); refreshFilterCount(); return;
    }
    if (t.dataset.filter) {
      const v = t.dataset.value;
      S.filters = { ...DEFAULT_FILTERS };
      if (t.dataset.filter === "dir") S.filters.dirs = [v];
      if (t.dataset.filter === "level") S.filters.levels = [v];
      if (t.dataset.filter === "site") S.filters.sites = [v];
      if (t.dataset.filter === "skill" || t.dataset.filter === "company") S.filters.q = v;
      $("#q").value = S.filters.q;
      S.tab = "all"; saveFilters(); render(); window.scrollTo({ top: 0 }); return;
    }
    if (t.dataset.status && currentJob) {
      const s = t.dataset.status;
      if (S.status[currentJob.id] === s) delete S.status[currentJob.id]; else S.status[currentJob.id] = s;
      store.set("status", S.status);
      document.querySelectorAll("[data-status]").forEach((b) => b.setAttribute("aria-pressed", S.status[currentJob.id] === b.dataset.status));
      toast({ saved: "★ შენახულია „ჩემში“", applied: "✓ მონიშნულია როგორც გაგზავნილი", hidden: "დამალულია" }[S.status[currentJob.id]] || "მონიშვნა მოიხსნა");
      render(); return;
    }
    if (t.dataset.theme) { store.set("theme", t.dataset.theme); applyTheme(); document.querySelectorAll("[data-theme]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.theme === t.dataset.theme)); return; }
    const a = t.dataset.action;
    if (a === "close") closeSheet();
    if (a === "reset") { S.filters = { ...DEFAULT_FILTERS }; $("#q").value = ""; saveFilters(); render(); if ($("#sheet").classList.contains("open")) openSheet(filtersHTML()); }
    if (a === "unhide") { for (const k of Object.keys(S.status)) if (S.status[k] === "hidden") delete S.status[k]; store.set("status", S.status); render(); }
    if (a === "saveSettings") {
      store.set("ghToken", $("#ghToken").value.trim());
      store.set("ghRepo", $("#ghRepo").value.trim());
      store.set("ntfyTopic", $("#ntfyTopic").value.trim());
      closeSheet(); toast("✓ შენახულია");
    }
  });

  function refreshFilterCount() {
    const btn = document.querySelector('#sheet [data-action="close"].primary');
    if (btn) btn.textContent = `ნახე ${S.jobs.filter((j) => matches(j)).length} ვაკანსია`;
  }

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.fbool) { S.filters[el.dataset.fbool] = el.checked; saveFilters(); render(); refreshFilterCount(); }
    if (el.id === "minSalary") { S.filters.minSalary = el.value; saveFilters(); render(); refreshFilterCount(); }
    if (el.id === "sort") { S.sort = el.value; store.set("sort", S.sort); render(); }
  });
  let qTimer;
  $("#q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filters.q = e.target.value.trim(); render(); }, 120); });
  $("#filterBtn").addEventListener("click", () => openSheet(filtersHTML()));
  $("#settingsBtn").addEventListener("click", () => openSheet(settingsHTML()));
  $("#refreshBtn").addEventListener("click", refresh);
  $("#sheetBack").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  // swipe down to close the sheet
  (() => {
    let y0 = null;
    const sh = $("#sheet");
    sh.addEventListener("touchstart", (e) => { y0 = sh.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    sh.addEventListener("touchend", (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) closeSheet(); y0 = null; }, { passive: true });
  })();

  // ------------------------------------------------------------ boot
  async function boot() {
    try {
      await loadData();
    } catch (e) {
      $("#view").innerHTML = `<div class="empty">მონაცემები ვერ ჩაიტვირთა. სცადე განახლება ↻</div>`;
      return;
    }
    const h = location.hash;
    if (h === "#new") { S.filters.newOnly = true; S.tab = "all"; }
    if (h === "#month") S.tab = "month";
    render();
    if (h.startsWith("#job=")) openJob(h.slice(5));
    // აპის თავიდან გახსნისას (iOS ფონიდან) მონაცემების ავტომატური შემოწმება
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        const before = S.updated;
        try { await loadData(true); if (S.updated !== before) { render(); toast("ახალი მონაცემი ჩაიტვირთა"); } } catch { /* offline */ }
      }
    });
  }
  boot();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
