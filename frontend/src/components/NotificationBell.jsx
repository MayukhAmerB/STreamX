import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../api/notifications";
import { useAuth } from "../hooks/useAuth";
import { apiData } from "../utils/api";

function BellIcon({ className = "" }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  );
}

/** Carbon "Notification" (20 px) inline, so the website bundle needs no icon package. */
function CarbonBellIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} width="20" height="20" viewBox="0 0 32 32" fill="currentColor" focusable="false">
      <path d="M28.7071,19.293,26,16.5859V13a10.0136,10.0136,0,0,0-9-9.9492V1H15V3.0508A10.0136,10.0136,0,0,0,6,13v3.5859L3.2929,19.293A1,1,0,0,0,3,20v3a1,1,0,0,0,1,1h7v.7768a5.152,5.152,0,0,0,4.5,5.1987A5.0057,5.0057,0,0,0,21,25V24h7a1,1,0,0,0,1-1V20A1,1,0,0,0,28.7071,19.293ZM19,25a3,3,0,0,1-6,0V24h6Zm8-3H5V20.4141L7.707,17.707A1,1,0,0,0,8,17V13a8,8,0,0,1,16,0v4a1,1,0,0,0,.293.707L27,20.4141Z" />
    </svg>
  );
}

function formatNotificationTime(value) {
  if (!value) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

const DEFAULT_BUTTON_CLASS =
  "relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/25 bg-white/10 text-white transition hover:bg-white/15";

/**
 * Console variant (plan §3.1, M19): a 48 px header action with a Carbon
 * bell, a small count badge that scales in once when the count rises (no
 * shake), and a floating panel styled by the Console shell (_shell.scss).
 */
function ConsoleBellView({ rootRef, open, setOpen, items, unreadCount, loading, onOpen, onItem, onMarkAll }) {
  const previousCount = useRef(unreadCount);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (unreadCount > previousCount.current) setBump((value) => value + 1);
    previousCount.current = unreadCount;
  }, [unreadCount]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        rootRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, rootRef, setOpen]);

  const panelId = "cds-app-notifications";
  return (
    <div className="cds-app-bell" ref={rootRef}>
      <button
        type="button"
        className={`cds-app-icon-button${open ? " is-open" : ""}`}
        onClick={onOpen}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <CarbonBellIcon className="cds-app-bell__icon" />
        {unreadCount > 0 ? (
          <span key={bump} className="cds-app-bell__badge" aria-hidden="true">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>
      <div id={panelId} className="cds-app-popover cds-app-bell__panel" role="region" aria-label="Notifications" hidden={!open}>
        {open ? (
          <>
            <div className="cds-app-bell__head">
              <div>
                <h2 className="cds-app-bell__title">Notifications</h2>
                <p className="cds-app-bell__count">{unreadCount ? `${unreadCount} unread` : "All caught up"}</p>
              </div>
              <button type="button" className="cds-app-text-button" disabled={!unreadCount} onClick={onMarkAll}>
                Mark all read
              </button>
            </div>
            <div className="cds-app-bell__list">
              {loading && !items.length ? <p className="cds-app-bell__empty">Loading…</p> : null}
              {!loading && !items.length ? (
                <p className="cds-app-bell__empty">Nothing yet. Grades, report reminders and live classes appear here.</p>
              ) : null}
              {items.map((item) => {
                const notification = item.notification || {};
                const unread = !item.read_at;
                return (
                  <button key={item.id} type="button" className={`cds-app-bell__item${unread ? " is-unread" : ""}`} onClick={() => onItem(item)}>
                    <span className="cds-app-bell__dot" aria-hidden="true" />
                    <span className="cds-app-bell__text">
                      <span className="cds-app-bell__item-title">
                        {notification.title || "Notification"}
                        {unread ? <span className="cds--visually-hidden"> (unread)</span> : null}
                      </span>
                      <span className="cds-app-bell__item-body">{notification.body || "You have a platform update."}</span>
                      <span className="cds-app-bell__item-time">{formatNotificationTime(notification.created_at || item.created_at)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function NotificationBell({ buttonClassName = DEFAULT_BUTTON_CLASS, variant = "website" }) {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const canLoad = Boolean(isAuthenticated && user && !user.terms_acceptance_required);

  const loadNotifications = useCallback(async () => {
    if (!canLoad) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetchNotifications({ limit: 20 });
      const data = apiData(response, {});
      setItems(Array.isArray(data.results) ? data.results : []);
      setUnreadCount(Number(data.unread_count || 0));
    } catch {
      setItems([]);
      setUnreadCount(0);
    } finally {
      setLoading(false);
    }
  }, [canLoad]);

  useEffect(() => {
    if (!canLoad) {
      setItems([]);
      setUnreadCount(0);
      return undefined;
    }
    loadNotifications();
    // Poll once a minute while the tab is visible; catch up when it returns.
    const intervalId = window.setInterval(() => {
      if (!document.hidden) loadNotifications();
    }, 60000);
    let lastVisibleLoad = Date.now();
    const onVisible = () => {
      if (document.hidden || Date.now() - lastVisibleLoad < 30000) return;
      lastVisibleLoad = Date.now();
      loadNotifications();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [canLoad, loadNotifications]);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!rootRef.current || rootRef.current.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  if (!canLoad) {
    return null;
  }

  const handleNotificationClick = async (item) => {
    if (!item?.read_at) {
      try {
        await markNotificationRead(item.id);
        setItems((previous) =>
          previous.map((row) =>
            row.id === item.id ? { ...row, read_at: new Date().toISOString() } : row
          )
        );
        setUnreadCount((previous) => Math.max(0, previous - 1));
      } catch {
        // The click should still navigate even if the read receipt fails.
      }
    }
    const actionUrl = item?.notification?.action_url || "";
    setOpen(false);
    if (!actionUrl) {
      return;
    }
    if (actionUrl.startsWith("http://") || actionUrl.startsWith("https://")) {
      window.location.assign(actionUrl);
      return;
    }
    navigate(actionUrl);
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead();
      setItems((previous) =>
        previous.map((row) => ({ ...row, read_at: row.read_at || new Date().toISOString() }))
      );
      setUnreadCount(0);
    } catch {
      // Leave the list unchanged if the request fails.
    }
  };

  if (variant === "console") {
    return (
      <ConsoleBellView
        rootRef={rootRef}
        open={open}
        setOpen={setOpen}
        items={items}
        unreadCount={unreadCount}
        loading={loading}
        onOpen={() => {
          setOpen((previous) => !previous);
          if (!open) {
            loadNotifications();
          }
        }}
        onItem={handleNotificationClick}
        onMarkAll={handleMarkAllRead}
      />
    );
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => {
          setOpen((previous) => !previous);
          if (!open) {
            loadNotifications();
          }
        }}
        aria-label={unreadCount > 0 ? `Open notifications, ${unreadCount} unread` : "Open notifications"}
        aria-expanded={open}
      >
        <BellIcon className="h-5 w-5" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full border border-black bg-[#F1F1F1] px-1 text-[10px] font-bold leading-5 text-black">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 mt-2 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-white/15 bg-[#080808] text-white shadow-[0_24px_70px_rgba(0,0,0,0.58)]">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#AFAFAF]">
                Notifications
              </p>
              <p className="mt-1 text-sm text-[#DADADA]">
                {unreadCount ? `${unreadCount} unread` : "All caught up"}
              </p>
            </div>
            <button
              type="button"
              className="rounded-full border border-white/15 px-3 py-1 text-xs font-semibold text-[#E7E7E7] transition hover:bg-white/10 disabled:opacity-40"
              disabled={!unreadCount}
              onClick={handleMarkAllRead}
            >
              Mark read
            </button>
          </div>

          <div className="max-h-[420px] overflow-y-auto p-2">
            {loading && !items.length ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-4 text-sm text-[#BFBFBF]">
                Loading notifications...
              </div>
            ) : null}
            {!loading && !items.length ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-4 text-sm text-[#BFBFBF]">
                No notifications yet. Live class and course upload alerts will appear here.
              </div>
            ) : null}
            {items.map((item) => {
              const notification = item.notification || {};
              const unread = !item.read_at;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`block w-full rounded-xl border px-3 py-3 text-left transition ${
                    unread
                      ? "border-white/15 bg-white/[0.07] hover:bg-white/[0.1]"
                      : "border-white/10 bg-transparent hover:bg-white/[0.04]"
                  }`}
                  onClick={() => handleNotificationClick(item)}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1 h-2 w-2 rounded-full ${
                        unread ? "bg-white shadow-[0_0_12px_rgba(255,255,255,0.5)]" : "bg-white/20"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-white">
                        {notification.title || "Notification"}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-[#BBBBBB]">
                        {notification.body || "You have a platform update."}
                      </span>
                      <span className="mt-2 block text-[10px] uppercase tracking-[0.16em] text-[#888888]">
                        {formatNotificationTime(notification.created_at || item.created_at)}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
