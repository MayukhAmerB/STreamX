// Public student profile: /u/:handle (website layout). OWNER: WS-PROFILES.
// The API decides who may see what (published snapshot only; members-only
// profiles ask visitors to sign in; hidden or unpublished profiles are 404).
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { Button } from "../../kit/Button";
import { Frame, Notice } from "../../kit/Layout";
import { HandPeriod, Lead, Tagline } from "../../kit/Typography";
import ProfileView, { RadialLines } from "./ProfileView";
import { fetchPublicProfile, readError } from "./profilesApi";

function useRobotsMeta(content) {
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    let tag = document.querySelector('meta[name="robots"]');
    const created = !tag;
    const previous = tag?.getAttribute("content");
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "robots");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", content);
    return () => {
      if (created) tag.remove();
      else if (previous != null) tag.setAttribute("content", previous);
    };
  }, [content]);
}

/** A calm full-height message band (missing, members-only, coming soon). */
export function ProfileMessage({ tagline, title, children, actions }) {
  return (
    <section className="relative overflow-hidden">
      <RadialLines />
      <Frame className="relative flex min-h-[70svh] flex-col items-center justify-center pb-20 pt-28 text-center md:pt-32">
        {tagline ? <Tagline>{tagline}</Tagline> : null}
        <h1 className="mt-4 max-w-4xl text-5xl font-semibold leading-none text-white text-balance sm:text-7xl">
          {title}
          <HandPeriod />
        </h1>
        {children ? <Lead className="mt-6">{children}</Lead> : null}
        {actions ? <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{actions}</div> : null}
      </Frame>
    </section>
  );
}

export default function PublicProfilePage() {
  const { handle = "" } = useParams();
  const location = useLocation();
  const [state, setState] = useState({ status: "loading", data: null, error: null });

  useEffect(() => {
    let active = true;
    setState({ status: "loading", data: null, error: null });
    fetchPublicProfile(handle)
      .then((data) => {
        if (active) setState({ status: "ready", data, error: null });
      })
      .catch((error) => {
        if (!active) return;
        const info = readError(error);
        const status =
          info.code === "feature_disabled"
            ? "off"
            : info.code === "profile_members_only"
              ? "members"
              : info.status === 404
                ? "missing"
                : info.status === 429
                  ? "busy"
                  : "error";
        setState({ status, data: null, error: info });
      });
    return () => {
      active = false;
    };
  }, [handle]);

  useEffect(() => {
    if (state.status === "ready" && state.data) {
      document.title = `@${state.data.handle} · Student profile`;
    }
  }, [state]);

  const publicIndexable = state.status === "ready" && state.data?.visibility === "public" && !state.data?.preview;
  useRobotsMeta(publicIndexable ? "noarchive" : "noindex, nofollow");

  if (state.status === "loading") {
    return (
      <div aria-busy="true" aria-live="polite" className="min-h-[70svh]">
        <span className="sr-only">Loading profile…</span>
      </div>
    );
  }
  if (state.status === "off") {
    return (
      <ProfileMessage tagline="Soon, your work in one place" title="Student profiles are coming soon">
        {state.error?.message || "Student profiles are coming soon."}
      </ProfileMessage>
    );
  }
  if (state.status === "members") {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return (
      <ProfileMessage
        tagline="Members only"
        title={`@${handle} shares with members`}
        actions={
          <Button asChild variant="primary" size="lg" trailing="chevron">
            <Link to={`/login?next=${next}`}>Sign in to view</Link>
          </Button>
        }
      >
        This student chose to show their profile to signed-in members only.
      </ProfileMessage>
    );
  }
  if (state.status === "missing") {
    return (
      <ProfileMessage
        tagline="Nothing at this address"
        title="Profile not found"
        actions={
          <Button asChild variant="secondary" size="lg">
            <Link to="/">Back to home</Link>
          </Button>
        }
      >
        The handle may have changed, or the profile is not public.
      </ProfileMessage>
    );
  }
  if (state.status !== "ready") {
    return (
      <ProfileMessage tagline="Please try again" title="We couldn't load this profile">
        {state.status === "busy" ? "Too many requests. Wait a moment and reload." : state.error?.message}
      </ProfileMessage>
    );
  }

  const profile = state.data;
  return (
    <>
      {profile.preview || profile.status === "hidden" ? (
        <Frame className="pt-24">
          <Notice eyebrow={profile.status === "hidden" ? "Hidden by a moderator" : "Preview"} title={profile.status === "hidden" ? "Only you and moderators can see this page" : "Only you can see this draft"}>
            {profile.is_owner ? (
              <Link className="underline underline-offset-4" to="/profile/public">
                Open the profile editor
              </Link>
            ) : null}
          </Notice>
        </Frame>
      ) : null}
      <ProfileView profile={profile} />
    </>
  );
}
