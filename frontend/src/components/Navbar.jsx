import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { resolveDjangoAdminUrl } from "../utils/backendUrl";
import Button from "./Button";
import BrandLogo from "./BrandLogo";
import NotificationBell from "./NotificationBell";

const navClass = ({ isActive }) =>
  `text-sm ${
    isActive
      ? "text-white underline decoration-white/50 underline-offset-8"
      : "text-white/80 hover:text-white"
  } transition font-medium`;

export default function Navbar() {
  const { user, isAuthenticated, isInstructor, isAdmin, logout } = useAuth();
  const canAccessControls = Boolean(isAdmin || isInstructor);
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const djangoAdminUrl = resolveDjangoAdminUrl();

  useEffect(() => {
    setMenuOpen(false);
    setMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!menuRef.current || menuRef.current.contains(event.target)) {
        return;
      }
      setMenuOpen(false);
      setMobileMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, []);

  const onLogout = async () => {
    setMenuOpen(false);
    setMobileMenuOpen(false);
    await logout();
    navigate("/login");
  };

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-black/95 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl sm:px-3" ref={menuRef}>
      <div className="relative mx-auto flex max-w-7xl items-center justify-between gap-2 px-1 py-2.5 text-neutral-950 sm:gap-4 sm:px-2 sm:py-4">
        <BrandLogo className="min-w-0 flex-1 lg:flex-none" />
        <nav className="hidden items-center gap-5 lg:flex">
          <NavLink
            to="/courses"
            className={navClass}
          >
            Courses
          </NavLink>
          {isAuthenticated ? (
            <NavLink to="/guides" className={navClass}>
              Guides
            </NavLink>
          ) : null}
          <NavLink to="/about" className={navClass}>
            About Us
          </NavLink>
          <NavLink to="/hall-of-fame" className={navClass}>
            Hall of Fame
          </NavLink>
          <NavLink to="/contact" className={navClass}>
            Contact
          </NavLink>
          <NavLink to="/faqs" className={navClass}>
            FAQs
          </NavLink>
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          {isAuthenticated ? <NotificationBell /> : null}
          {isAuthenticated ? (
            <div className="relative hidden sm:block">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
                onClick={() => setMenuOpen((prev) => !prev)}
              >
                <span className="max-w-[210px] truncate">{user?.full_name || user?.email}</span>
                <span className={`text-xs transition ${menuOpen ? "rotate-180" : ""}`}>v</span>
              </button>
              {menuOpen ? (
                <div className="absolute right-0 mt-2 w-52 overflow-hidden rounded-xl border border-black panel-gradient shadow-[0_16px_35px_rgba(0,0,0,0.36)]">
                  <Link
                    to="/courses?view=owned"
                    className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                  >
                      Your Courses
                  </Link>
                  <Link
                    to="/guides"
                    className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                  >
                    Guides
                  </Link>
                  <Link
                    to="/profile"
                    className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                  >
                    Profile
                  </Link>
                  <Link
                    to="/id-card"
                    className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                  >
                    ID Card
                  </Link>
                  {isInstructor ? (
                    <Link
                      to="/instructor/dashboard"
                      className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                    >
                      Instructor
                    </Link>
                  ) : null}
                  {canAccessControls ? (
                    <Link
                      to="/control-center"
                      className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                    >
                      Admin Control Center
                    </Link>
                  ) : null}
                  {canAccessControls ? (
                    <Link
                      to="/meeting"
                      className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                    >
                      Meeting Control
                    </Link>
                  ) : null}
                  {canAccessControls ? (
                    <Link
                      to="/broadcasting"
                      className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                    >
                      Broadcast Control
                    </Link>
                  ) : null}
                  {isAdmin ? (
                    <Link
                      to="/lecture-questions"
                      className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                    >
                      Lecture Questions
                    </Link>
                  ) : null}
                  {isAdmin ? (
                    <a
                      href={djangoAdminUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block px-4 py-2.5 text-sm text-[#DFDFDF] transition hover:bg-[#202020]"
                    >
                      Django Admin
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="block w-full border-t border-black px-4 py-2.5 text-left text-sm text-red-300 transition hover:bg-[#202020]"
                    onClick={onLogout}
                  >
                    Logout
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="hidden items-center gap-2 sm:flex">
              <Link to="/login">
                <Button variant="indigoSoft" className="border-white/25 bg-white/10 text-white hover:bg-white/15">
                  Login
                </Button>
              </Link>
            </div>
          )}
          <button
            type="button"
            className="inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-xl border border-white/20 bg-white/10 text-white transition hover:bg-white/15 lg:hidden"
            onClick={() => {
              setMenuOpen(false);
              setMobileMenuOpen((prev) => !prev);
            }}
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
          >
            <span className="relative inline-flex h-4 w-4 flex-col items-center justify-center">
              <span
                className={`absolute h-[1.5px] w-4 rounded-full bg-current transition ${
                  mobileMenuOpen ? "translate-y-0 rotate-45" : "-translate-y-[5px]"
                }`}
              />
              <span
                className={`absolute h-[1.5px] w-4 rounded-full bg-current transition ${
                  mobileMenuOpen ? "opacity-0" : "opacity-100"
                }`}
              />
              <span
                className={`absolute h-[1.5px] w-4 rounded-full bg-current transition ${
                  mobileMenuOpen ? "translate-y-0 -rotate-45" : "translate-y-[5px]"
                }`}
              />
            </span>
          </button>
        </div>
      </div>
      {mobileMenuOpen ? (
        <div className="mx-auto mt-1 max-h-[calc(100dvh-4.75rem-env(safe-area-inset-top))] max-w-7xl overflow-y-auto overscroll-contain rounded-2xl border border-black panel-gradient p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-[0_18px_34px_rgba(0,0,0,0.34)] backdrop-blur lg:hidden">
          <nav className="grid gap-1">
            <NavLink
              to="/courses"
              className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[#DFDFDF] transition hover:bg-[#1E1E1E]"
            >
              Courses
            </NavLink>
            {isAuthenticated ? (
              <NavLink to="/guides" className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                Guides
              </NavLink>
            ) : null}
            <NavLink to="/about" className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
              About Us
            </NavLink>
            <NavLink to="/hall-of-fame" className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
              Hall of Fame
            </NavLink>
            <NavLink to="/contact" className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
              Contact
            </NavLink>
            <NavLink to="/faqs" className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
              FAQs
            </NavLink>
          </nav>

          <div className="mt-3 border-t border-black pt-3">
            {isAuthenticated ? (
              <div className="space-y-2">
                <div className="rounded-xl border border-black panel-gradient px-3 py-2 text-xs text-[#DBDBDB]">
                  <div className="truncate font-semibold text-white">{user?.full_name || user?.email}</div>
                  <div className="mt-0.5 truncate text-[#A4A4A4]">{user?.email}</div>
                </div>
                <div className="grid gap-1">
                    <Link to="/courses?view=owned" className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                      Your Courses
                  </Link>
                  <Link to="/guides" className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                    Guides
                  </Link>
                  <Link to="/profile" className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                    Profile
                  </Link>
                  <Link to="/id-card" className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                    ID Card
                  </Link>
                  {isInstructor ? (
                    <Link to="/instructor/dashboard" className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                      Instructor
                    </Link>
                  ) : null}
                  {canAccessControls ? (
                    <Link to="/control-center" className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                      Admin Control Center
                    </Link>
                  ) : null}
                  {canAccessControls ? (
                    <Link to="/meeting" className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                      Meeting Control
                    </Link>
                  ) : null}
                  {canAccessControls ? (
                    <Link to="/broadcasting" className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]">
                      Broadcast Control
                    </Link>
                  ) : null}
                  {isAdmin ? (
                    <Link
                      to="/lecture-questions"
                      className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]"
                    >
                      Lecture Questions
                    </Link>
                  ) : null}
                  {isAdmin ? (
                    <a
                      href={djangoAdminUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg px-3 py-2 text-sm text-[#DFDFDF] transition hover:bg-[#1E1E1E]"
                    >
                      Django Admin
                    </a>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="danger"
                  className="mt-2 w-full"
                  onClick={onLogout}
                >
                  Logout
                </Button>
              </div>
            ) : (
              <div className="grid gap-2">
                <Link to="/login" className="block">
                  <Button className="w-full">Login</Button>
                </Link>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </header>
  );
}

