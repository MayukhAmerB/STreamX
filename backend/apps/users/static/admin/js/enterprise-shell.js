"use strict";
// Al Syed Admin shell (UI plan §4.5, §4.8). Every page works without this
// file; it only enhances:
//   * side navigation: icon rail on desktop, drawer on phones;
//   * the Ctrl/Cmd+K command palette (records from the admin search view,
//     which uses the same service as GET /api/admin/search/, plus tasks and
//     every section the viewer can open);
//   * "/" focuses the list search; Esc closes overlays;
//   * "Filters (n)" disclosure on narrow screens; course form tabs;
//   * the Overview's "Browse every section" filter and first-view count-ups.
// Django's own nav_sidebar.js also loads; it binds to the hidden #nav-filter.
(function () {
  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const narrow = window.matchMedia("(max-width: 1056px)");
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

  function storageGet(store, key) {
    try {
      return window[store].getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(store, key, value) {
    try {
      window[store].setItem(key, value);
    } catch (e) {
      // Storage can be unavailable (private mode); nothing depends on it.
    }
  }

  function isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  if (isMac) {
    document.querySelectorAll("[data-palette-kbd]").forEach(function (kbd) {
      kbd.textContent = "⌘ K";
    });
  }

  // ------------------------------------------------------------ navigation
  const nav = document.getElementById("nav-sidebar");
  if (nav) {
    const RAIL_KEY = "enterprise.navRail";
    const collapse = document.getElementById("enterprise-nav-collapse");
    const openButton = document.getElementById("enterprise-nav-open");
    const backdrop = document.getElementById("enterprise-nav-backdrop");

    const syncCollapse = function () {
      const rail = root.classList.contains("enterprise-nav-rail");
      if (!collapse) return;
      collapse.setAttribute("aria-pressed", rail ? "true" : "false");
      collapse.setAttribute("aria-label", rail ? "Expand navigation" : "Collapse navigation");
      const label = collapse.querySelector(".enterprise-sidenav-label");
      if (label) label.textContent = rail ? "Expand" : "Collapse";
    };

    if (collapse) {
      collapse.addEventListener("click", function () {
        const rail = root.classList.toggle("enterprise-nav-rail");
        storageSet("localStorage", RAIL_KEY, rail ? "1" : "0");
        syncCollapse();
      });
      syncCollapse();
    }

    // In the rail, opening a group expands the rail so its pages are readable.
    nav.querySelectorAll("details > summary").forEach(function (summary) {
      summary.addEventListener("click", function () {
        if (root.classList.contains("enterprise-nav-rail") && !narrow.matches) {
          root.classList.remove("enterprise-nav-rail");
          storageSet("localStorage", RAIL_KEY, "0");
          syncCollapse();
        }
      });
    });

    // Keep the current page visible inside the scroll region.
    const current = nav.querySelector("[aria-current='page']");
    const scroller = nav.querySelector("[data-nav-scroll]");
    if (current && scroller && typeof current.scrollIntoView === "function") {
      const top = current.offsetTop - scroller.offsetTop;
      if (top > scroller.clientHeight - 48) scroller.scrollTop = top - scroller.clientHeight / 2;
    }

    const setDrawer = function (open) {
      root.classList.toggle("enterprise-nav-open", open);
      if (openButton) openButton.setAttribute("aria-expanded", open ? "true" : "false");
      if (backdrop) backdrop.hidden = !open;
      if (open) {
        const target = nav.querySelector("[aria-current='page'], a, button");
        if (target) target.focus({ preventScroll: true });
      } else if (openButton && nav.contains(document.activeElement)) {
        openButton.focus();
      }
    };

    if (openButton) {
      openButton.addEventListener("click", function () {
        setDrawer(!root.classList.contains("enterprise-nav-open"));
      });
    }
    if (backdrop) backdrop.addEventListener("click", function () { setDrawer(false); });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && root.classList.contains("enterprise-nav-open")) setDrawer(false);
    });
    narrow.addEventListener("change", function () { setDrawer(false); });
  }

  // --------------------------------------------------------- list helpers
  // "Filters (n)": open as a side panel on wide screens, closed above the
  // list on narrow ones (open when there is no JS).
  document.querySelectorAll("[data-filters]").forEach(function (details) {
    const sync = function () {
      if (!narrow.matches) details.open = true;
    };
    if (narrow.matches) details.open = false;
    narrow.addEventListener("change", function () {
      details.open = !narrow.matches;
    });
    details.addEventListener("toggle", sync);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target) || document.querySelector("dialog[open]")) return;
    const search = document.getElementById("searchbar");
    if (search) {
      event.preventDefault();
      search.focus();
      search.select();
    }
  });

  // ------------------------------------------------------ course form tabs
  const tabNav = document.querySelector("[data-form-tabs]");
  if (tabNav) {
    const form = tabNav.closest("form");
    const tabs = Array.prototype.slice.call(tabNav.querySelectorAll("[data-tab]"));
    const inlineTab = tabNav.getAttribute("data-inline-tab") || "";
    const sections = [];
    form.querySelectorAll("fieldset.module").forEach(function (fieldset) {
      const match = Array.prototype.find.call(fieldset.classList, function (name) { return name.indexOf("tab-") === 0; });
      if (match && !fieldset.closest(".inline-group")) sections.push({ el: fieldset, tab: match.slice(4) });
    });
    if (inlineTab) {
      form.querySelectorAll(".inline-group").forEach(function (group) {
        sections.push({ el: group, tab: inlineTab });
      });
    }
    const keys = tabs.map(function (tab) { return tab.getAttribute("data-tab"); });

    // Phones: the tab strip scrolls sideways. A fade marks more tabs to the
    // right, and the current tab is always brought into view (strip only,
    // never the page).
    const markOverflow = function () {
      const more = tabNav.scrollLeft + tabNav.clientWidth < tabNav.scrollWidth - 1;
      tabNav.classList.toggle("has-more-end", more);
    };
    const revealTab = function (tab) {
      // The strip is position: sticky, so it is each tab's offsetParent.
      const left = tab.offsetParent === tabNav ? tab.offsetLeft : tab.offsetLeft - tabNav.offsetLeft;
      const right = left + tab.offsetWidth;
      if (left < tabNav.scrollLeft) tabNav.scrollLeft = Math.max(0, left - 16);
      else if (right > tabNav.scrollLeft + tabNav.clientWidth) tabNav.scrollLeft = right - tabNav.clientWidth + 32;
      markOverflow();
    };
    tabNav.addEventListener("scroll", markOverflow, { passive: true });
    window.addEventListener("resize", markOverflow);

    const show = function (key, focus) {
      if (keys.indexOf(key) === -1) key = keys[0];
      tabs.forEach(function (tab) {
        const active = tab.getAttribute("data-tab") === key;
        if (active) {
          tab.setAttribute("aria-current", "true");
          revealTab(tab);
        } else tab.removeAttribute("aria-current");
      });
      sections.forEach(function (section) {
        if (section.tab === key) section.el.removeAttribute("data-tab-hidden");
        else section.el.setAttribute("data-tab-hidden", "");
      });
      storageSet("sessionStorage", "enterprise.formTab." + location.pathname, key);
      if (focus) {
        const first = sections.find(function (section) { return section.tab === key; });
        if (first) first.el.scrollIntoView({ block: "nearest" });
      }
    };

    // A tab holding a validation error gets a dot and opens first.
    let errorTab = "";
    sections.forEach(function (section) {
      if (section.el.querySelector(".errorlist, .errors")) {
        const tab = tabs[keys.indexOf(section.tab)];
        if (tab) tab.classList.add("enterprise-form-tab-error");
        if (!errorTab) errorTab = section.tab;
      }
    });

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function (event) {
        event.preventDefault();
        show(tab.getAttribute("data-tab"), false);
        if (history.replaceState) history.replaceState(null, "", "#tab-" + tab.getAttribute("data-tab"));
      });
    });
    root.classList.add("enterprise-tabs-ready");
    window.addEventListener("hashchange", function () {
      const key = (location.hash || "").replace("#tab-", "");
      if (keys.indexOf(key) !== -1) show(key, true);
    });
    const fromHash = (location.hash || "").replace("#tab-", "");
    show(errorTab || (keys.indexOf(fromHash) !== -1 ? fromHash : storageGet("sessionStorage", "enterprise.formTab." + location.pathname) || keys[0]), false);
  }

  // -------------------------------------------------------- overview page
  const browse = document.querySelector("[data-browse]");
  if (browse) {
    const input = browse.querySelector("[data-browse-filter]");
    const empty = browse.querySelector("[data-browse-empty]");
    if (input) {
      input.addEventListener("input", function () {
        const query = input.value.trim().toLowerCase();
        let any = false;
        browse.querySelectorAll("[data-browse-area]").forEach(function (area) {
          let visible = 0;
          area.querySelectorAll("[data-browse-item]").forEach(function (item) {
            const match = query === "" || item.textContent.toLowerCase().indexOf(query) !== -1;
            item.hidden = !match;
            if (match) visible += 1;
          });
          area.hidden = visible === 0;
          any = any || visible > 0;
        });
        if (empty) empty.hidden = any;
      });
    }
  }

  // First view per session: tiles enter once and counts run up (700 ms).
  const attention = document.querySelector("[data-attention]");
  if (attention && !storageGet("sessionStorage", "enterprise.homeSeen")) {
    storageSet("sessionStorage", "enterprise.homeSeen", "1");
    root.classList.add("enterprise-first-view");
    if (!reduceMotion.matches && typeof window.requestAnimationFrame === "function") {
      attention.querySelectorAll("[data-count-up]").forEach(function (el) {
        const target = parseInt(el.getAttribute("data-count-up"), 10);
        if (!(target > 1)) return;
        const sr = document.createElement("span");
        sr.className = "enterprise-visually-hidden";
        sr.textContent = String(target);
        el.setAttribute("aria-hidden", "true");
        el.parentNode.insertBefore(sr, el.nextSibling);
        el.style.display = "inline-block";
        el.style.minInlineSize = String(target).length + "ch";
        const start = performance.now();
        const step = function (now) {
          if (document.hidden) {
            el.textContent = String(target);
            return;
          }
          const t = Math.min(1, (now - start) / 700);
          el.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
          if (t < 1) window.requestAnimationFrame(step);
        };
        el.textContent = "0";
        window.requestAnimationFrame(step);
      });
    }
  }

  // ------------------------------------------------------- command palette
  const dialog = document.getElementById("enterprise-palette");
  const dataNode = document.getElementById("enterprise-palette-data");
  if (!dialog || !dataNode || typeof dialog.showModal !== "function") return;

  let staticData = { actions: [], destinations: [] };
  try {
    staticData = JSON.parse(dataNode.textContent) || staticData;
  } catch (e) {
    // Keep the empty defaults.
  }
  const searchUrl = dialog.getAttribute("data-search-url") || "";
  const input = document.getElementById("enterprise-palette-input");
  const list = document.getElementById("enterprise-palette-list");
  const status = document.getElementById("enterprise-palette-status");
  const RECENT_KEY = "enterprise.palette.recent";
  const MIN_CHARS = 2;
  let options = [];
  let active = -1;
  let trigger = null;
  let timer = 0;
  let requestId = 0;
  let records = [];

  function readRecent() {
    try {
      const parsed = JSON.parse(storageGet("localStorage", RECENT_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter(function (item) { return item && item.href && item.label; }).slice(0, 5) : [];
    } catch (e) {
      return [];
    }
  }

  function remember(item) {
    const recent = readRecent().filter(function (entry) { return entry.href !== item.href; });
    recent.unshift({ label: item.label, href: item.href, hint: item.hint || "" });
    storageSet("localStorage", RECENT_KEY, JSON.stringify(recent.slice(0, 5)));
  }

  function matches(label, query) {
    return label.toLowerCase().indexOf(query) !== -1;
  }

  function highlight(node, text, query) {
    const index = query ? text.toLowerCase().indexOf(query) : -1;
    if (index === -1) {
      node.textContent = text;
      return;
    }
    node.appendChild(document.createTextNode(text.slice(0, index)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + query.length);
    node.appendChild(mark);
    node.appendChild(document.createTextNode(text.slice(index + query.length)));
  }

  function render(query) {
    const q = query.trim().toLowerCase();
    const groups = [];
    if (!q) {
      const recent = readRecent();
      if (recent.length) groups.push({ label: "Recent", items: recent });
      groups.push({ label: "Tasks", items: staticData.actions || [] });
    } else {
      const tasks = (staticData.actions || []).filter(function (item) { return matches(item.label, q); });
      if (tasks.length) groups.push({ label: "Tasks", items: tasks });
      records.forEach(function (group) {
        if (group.items && group.items.length) {
          groups.push({
            label: group.label,
            items: group.items.map(function (item) {
              return { label: item.title, sub: item.subtitle || "", href: item.href, hint: group.label };
            }),
          });
        }
      });
      const sections = (staticData.destinations || []).filter(function (item) {
        return matches(item.label, q) || matches(item.hint || "", q);
      }).slice(0, 8);
      if (sections.length) groups.push({ label: "Sections", items: sections });
    }

    list.textContent = "";
    options = [];
    groups.forEach(function (group, groupIndex) {
      const wrap = document.createElement("div");
      wrap.setAttribute("role", "group");
      const labelId = "enterprise-palette-group-" + groupIndex;
      wrap.setAttribute("aria-labelledby", labelId);
      const heading = document.createElement("p");
      heading.className = "enterprise-palette-group-label";
      heading.id = labelId;
      heading.textContent = group.label;
      wrap.appendChild(heading);
      group.items.forEach(function (item) {
        const option = document.createElement("div");
        option.className = "enterprise-palette-option";
        option.setAttribute("role", "option");
        option.id = "enterprise-palette-option-" + options.length;
        option.setAttribute("aria-selected", "false");
        const text = document.createElement("span");
        text.className = "enterprise-palette-option-text";
        const title = document.createElement("span");
        title.className = "enterprise-palette-option-title";
        highlight(title, String(item.label || ""), q);
        text.appendChild(title);
        if (item.sub) {
          const sub = document.createElement("span");
          sub.className = "enterprise-palette-option-sub";
          sub.textContent = item.sub;
          text.appendChild(sub);
        }
        option.appendChild(text);
        if (item.hint && group.label !== item.hint) {
          const hint = document.createElement("span");
          hint.className = "enterprise-palette-option-hint";
          hint.textContent = item.hint;
          option.appendChild(hint);
        }
        const index = options.length;
        option.addEventListener("mousemove", function () { setActive(index); });
        option.addEventListener("click", function () { choose(index); });
        wrap.appendChild(option);
        options.push({ el: option, item: item });
      });
      list.appendChild(wrap);
    });
    input.setAttribute("aria-expanded", options.length ? "true" : "false");
    setActive(options.length ? 0 : -1);
    if (q && !options.length) {
      status.textContent = q.length < MIN_CHARS ? "Keep typing to search records." : "Nothing matches “" + query.trim() + "”.";
    } else if (q) {
      status.textContent = options.length + (options.length === 1 ? " result" : " results");
    } else {
      status.textContent = "";
    }
  }

  function setActive(index) {
    if (active >= 0 && options[active]) options[active].el.setAttribute("aria-selected", "false");
    active = index;
    if (active >= 0 && options[active]) {
      options[active].el.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", options[active].el.id);
      options[active].el.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function choose(index) {
    const option = options[index];
    if (!option || !option.item.href) return;
    remember(option.item);
    window.location.assign(option.item.href);
  }

  function fetchRecords(query) {
    const q = query.trim();
    const id = ++requestId;
    if (q.length < MIN_CHARS || !searchUrl || typeof fetch !== "function") {
      records = [];
      render(query);
      return;
    }
    status.textContent = "Searching…";
    fetch(searchUrl + "?format=json&q=" + encodeURIComponent(q), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (payload) {
        if (id !== requestId) return;
        const data = payload && payload.data ? payload.data : payload;
        records = data && Array.isArray(data.groups) ? data.groups : [];
        render(input.value);
      })
      .catch(function () {
        if (id !== requestId) return;
        records = [];
        render(input.value);
        status.textContent = "Records could not be searched. Tasks and sections still work.";
      });
  }

  function open(fromTrigger) {
    if (dialog.open) return;
    trigger = fromTrigger || document.activeElement;
    input.value = "";
    records = [];
    render("");
    dialog.showModal();
    input.focus();
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
  }

  dialog.addEventListener("close", function () {
    window.clearTimeout(timer);
    requestId += 1;
    if (trigger && typeof trigger.focus === "function") trigger.focus();
    trigger = null;
  });

  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) close();
  });

  input.addEventListener("input", function () {
    window.clearTimeout(timer);
    const value = input.value;
    records = [];
    render(value);
    timer = window.setTimeout(function () { fetchRecords(value); }, 150);
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (options.length) setActive((active + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length) setActive((active - 1 + options.length) % options.length);
    } else if (event.key === "Home" && options.length && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && options.length && event.ctrlKey) {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  });

  document.querySelectorAll("[data-palette-open]").forEach(function (button) {
    button.setAttribute("role", "button");
    button.setAttribute("aria-controls", "enterprise-palette");
    button.addEventListener("click", function (event) {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      open(button);
    });
  });

  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      if (dialog.open) close();
      else open(document.activeElement);
    }
  });
})();
