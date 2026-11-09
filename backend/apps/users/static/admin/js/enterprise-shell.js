"use strict";
// Admin shell: collapsible side navigation (icon rail on desktop, drawer on
// phones) and the sidebar filter. Django's own nav_sidebar.js also loads; it
// finds no toggle button or table rows here, so it stays inert.
(function () {
  const root = document.documentElement;
  const nav = document.getElementById("nav-sidebar");
  if (!nav) return;

  const RAIL_KEY = "enterprise.navRail";
  const collapse = document.getElementById("enterprise-nav-collapse");
  const openButton = document.getElementById("enterprise-nav-open");
  const backdrop = document.getElementById("enterprise-nav-backdrop");
  const phone = window.matchMedia("(max-width: 1055px)");

  function store(value) {
    try {
      localStorage.setItem(RAIL_KEY, value);
    } catch (e) {
      // Storage can be unavailable (private mode); the rail just won't persist.
    }
  }

  function syncCollapse() {
    const rail = root.classList.contains("enterprise-nav-rail");
    if (collapse) {
      collapse.setAttribute("aria-pressed", rail ? "true" : "false");
      collapse.setAttribute("aria-label", rail ? "Expand navigation" : "Collapse navigation");
    }
  }

  if (collapse) {
    collapse.addEventListener("click", function () {
      const rail = root.classList.toggle("enterprise-nav-rail");
      store(rail ? "1" : "0");
      syncCollapse();
    });
    syncCollapse();
  }

  // In the rail, opening an app's group expands the rail so its models are readable.
  nav.querySelectorAll("details > summary").forEach(function (summary) {
    summary.addEventListener("click", function () {
      if (root.classList.contains("enterprise-nav-rail") && !phone.matches) {
        root.classList.remove("enterprise-nav-rail");
        store("0");
        syncCollapse();
      }
    });
  });

  function setDrawer(open) {
    root.classList.toggle("enterprise-nav-open", open);
    if (openButton) openButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (backdrop) backdrop.hidden = !open;
    if (open) {
      const target = nav.querySelector(".is-current, input, a");
      if (target) target.focus({ preventScroll: true });
    } else if (openButton && nav.contains(document.activeElement)) {
      openButton.focus();
    }
  }

  if (openButton) {
    openButton.addEventListener("click", function () {
      setDrawer(!root.classList.contains("enterprise-nav-open"));
    });
  }
  if (backdrop) backdrop.addEventListener("click", function () { setDrawer(false); });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && root.classList.contains("enterprise-nav-open")) setDrawer(false);
  });
  phone.addEventListener("change", function () { setDrawer(false); });

  // Filter: show matching models, open their groups, hide groups with no match.
  const filter = document.getElementById("nav-filter");
  if (filter) {
    const apps = Array.prototype.slice.call(nav.querySelectorAll("[data-nav-app]"));
    const openState = new Map(apps.map(function (app) {
      const details = app.querySelector("details");
      return [app, details ? details.open : false];
    }));
    filter.addEventListener("input", function () {
      const query = filter.value.trim().toLowerCase();
      apps.forEach(function (app) {
        const details = app.querySelector("details");
        const appName = (app.querySelector(".enterprise-sidenav-label") || {}).textContent || "";
        const appMatches = query !== "" && appName.toLowerCase().indexOf(query) !== -1;
        let anyItem = false;
        app.querySelectorAll("[data-nav-item]").forEach(function (item) {
          const match = query === "" || appMatches || item.textContent.toLowerCase().indexOf(query) !== -1;
          item.hidden = !match;
          anyItem = anyItem || match;
        });
        app.hidden = query !== "" && !anyItem;
        if (details) details.open = query === "" ? openState.get(app) : anyItem;
      });
      nav.querySelectorAll(".enterprise-sidenav-heading").forEach(function (heading) {
        const list = heading.nextElementSibling;
        const visible = list && Array.prototype.some.call(list.children, function (li) { return !li.hidden; });
        heading.hidden = !visible;
      });
    });
  }
})();
