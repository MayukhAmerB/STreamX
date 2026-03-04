import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import Button from "./Button";
import BrandLogo from "./BrandLogo";

const navClass = ({ isActive }) =>
  `text-sm ${
    isActive
      ? "text-white"
      : "text-white/80 hover:text-white"
  } transition font-medium`;

export default function Navbar() {
  const { user, isAuthenticated, isInstructor, isAdmin, registrationEnabled, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isHome = location.pathname === "/";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!menuRef.current || menuRef.current.contains(event.target)) {
        return;
      }
      setMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, []);

  const onLogout = async () => {
    setMenuOpen(false);
    await logout();
    navigate("/login");
  };

  return (
    <header className="sticky top-0 z-20 px-3 pt-3">
      <div
        className={`mx-auto flex max-w-7xl items-center justify-between gap-4 rounded-2xl px-4 py-4 text-neutral-950 backdrop-blur ${
          isHome
            ? "border border-[#c5d0ba]/15 bg-gradient-to-r from-[#090c0a]/96 via-[#101410]/94 to-[#171d17]/92 shadow-[0_12px_40px_rgba(8,10,8,0.35)]"
            : "border border-[#c5d0ba]/12 bg-gradient-to-r from-[#0b0e0b]/94 via-[#121712]/92 to-[#1a211a]/88 shadow-[0_10px_30px_rgba(8,10,8,0.28)]"
        }`}
      >
        <BrandLogo />
        <nav className="hidden items-center gap-5 md:flex">
          <NavLink to="/courses" className={navClass}>
            Courses
          </NavLink>
          <NavLink to="/live-classes" className={navClass}>
            Live Classes
          </NavLink>
          {isAuthenticated ? (
            <NavLink to="/join-live" className={navClass}>
              Join Live
            </NavLink>
          ) : null}
          <NavLink to="/about" className={navClass}>
            About Us
          </NavLink>
          <NavLink to="/contact" className={navClass}>
            Contact
          </NavLink>
        </nav>
        <div className="flex items-center gap-2">
          {isAuthenticated ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
                onClick={() => setMenuOpen((prev) => !prev)}
              >
                <span className="max-w-[210px] truncate">{user?.full_name || user?.email}</span>
                <span className={`text-xs transition ${menuOpen ? "rotate-180" : ""}`}>v</span>
              </button>
              {menuOpen ? (
                <div className="absolute right-0 mt-2 w-52 overflow-hidden rounded-xl border border-[#2e3a2f] bg-[#111712] shadow-[0_16px_35px_rgba(0,0,0,0.36)]">
                  <Link
                    to="/my-courses"
                    className="block px-4 py-2.5 text-sm text-[#dbe4d1] transition hover:bg-[#1b241c]"
                  >
                    My Courses
                  </Link>
                  <Link
                    to="/profile"
                    className="block px-4 py-2.5 text-sm text-[#dbe4d1] transition hover:bg-[#1b241c]"
                  >
                    Profile
                  </Link>
                  <Link
                    to="/join-live"
                    className="block px-4 py-2.5 text-sm text-[#dbe4d1] transition hover:bg-[#1b241c]"
                  >
                    Join Live
                  </Link>
                  {isInstructor ? (
                    <Link
                      to="/instructor/dashboard"
                      className="block px-4 py-2.5 text-sm text-[#dbe4d1] transition hover:bg-[#1b241c]"
                    >
                      Instructor
                    </Link>
                  ) : null}
                  {isAdmin ? (
                    <Link
                      to="/control-center"
                      className="block px-4 py-2.5 text-sm text-[#dbe4d1] transition hover:bg-[#1b241c]"
                    >
                      Admin Control Center
                    </Link>
                  ) : null}
                  {isAdmin ? (
                    <Link
                      to="/meeting"
                      className="block px-4 py-2.5 text-sm text-[#dbe4d1] transition hover:bg-[#1b241c]"
                    >
                      Meeting Control
                    </Link>
                  ) : null}
                  {isAdmin ? (
                    <Link
                      to="/broadcasting"
                      className="block px-4 py-2.5 text-sm text-[#dbe4d1] transition hover:bg-[#1b241c]"
                    >
                      Broadcast Control
                    </Link>
                  ) : null}
                  {isAdmin ? (
                    <a
                      href="/admin/"
                      target="_blank"
                      rel="noreferrer"
                      className="block px-4 py-2.5 text-sm text-[#dbe4d1] transition hover:bg-[#1b241c]"
                    >
                      Django Admin
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="block w-full border-t border-[#273227] px-4 py-2.5 text-left text-sm text-red-300 transition hover:bg-[#1b241c]"
                    onClick={onLogout}
                  >
                    Logout
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <Link to="/login">
                <Button variant="indigoSoft" className="border-white/25 bg-white/10 text-white hover:bg-white/15">
                  Login
                </Button>
              </Link>
              {registrationEnabled ? (
                <Link to="/register" className="hidden sm:block">
                  <Button
                    variant="indigo"
                    className="border border-[#d5ddca] bg-[#eef1e6] text-[#0f1410] shadow-none hover:bg-white"
                  >
                    Register
                  </Button>
                </Link>
              ) : null}
            </>
          )}
        </div>
      </div>
    </header>
  );
}

