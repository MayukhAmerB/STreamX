import { useEffect, useRef, useState } from "react";
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

export default function NotificationBell() {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const canLoad = Boolean(isAuthenticated && user && !user.terms_acceptance_required);

  const loadNotifications = async () => {
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
  };

  useEffect(() => {
    if (!canLoad) {
      setItems([]);
      setUnreadCount(0);
      return undefined;
    }
    loadNotifications();
    const intervalId = window.setInterval(loadNotifications, 60000);
    return () => window.clearInterval(intervalId);
  }, [canLoad]);

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

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/25 bg-white/10 text-white transition hover:bg-white/15"
        onClick={() => {
          setOpen((previous) => !previous);
          if (!open) {
            loadNotifications();
          }
        }}
        aria-label="Open notifications"
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
