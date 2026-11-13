import { siteBrand } from "../../config/siteBrand";
import { useYouTubeChannel } from "../../features/youtube/youTubeStore";
import { useAuth } from "../../hooks/useAuth";
import BestsellersBand from "./BestsellersBand";
import HeroBand from "./HeroBand";
import LiveClassesBand from "./LiveClassesBand";
import { AboutBand, CallToActionBand, CertificateBand, JourneyBand, StoryBand, WhyBand } from "./StoryBands";
import { useHashScroll } from "./useHashScroll";
import { selectFeaturedCoursePath, useLandingData } from "./useLandingData";
import WatchBand, { watchBandVisible } from "./WatchBand";
// Last, so the band overrides of shared component CSS (e.g. YouTube.css) win ties.
import "./landing.css";

/**
 * Band themes by content (plan §7.3 table): the tallest blocks (programs, live
 * classes, About with its stats) and the final CTA sit on light bands, so the
 * page reads about 50/50 and the CTA never merges into the dark footer. Fixed
 * per band rather than by position: without the Watch band (OwlCognito) the
 * map still never stacks two dark bands (bestsellers white → live g10 is the
 * one deliberate light → light step).
 */
const BAND_THEME_BY_CONTENT = Object.freeze({
  hero: "g100",
  bestsellers: "white",
  watch: "g100",
  live: "g10",
  certificate: "g100",
  about: "white",
  story: "g100",
  why: "g10",
  journey: "g100",
  cta: "white",
});

export function assignBandThemes(keys) {
  return Object.fromEntries(keys.map((key) => [key, BAND_THEME_BY_CONTENT[key] || "white"]));
}

/**
 * The public landing page (Syed Carbon, plan §7.3): products and live classes
 * first, then the brand story, on alternating black and white full-bleed
 * bands. Header and footer come from the layout.
 */
export default function LandingPageV2() {
  const { isAuthenticated } = useAuth();
  const { catalog, liveClasses, liveBroadcast } = useLandingData(isAuthenticated);
  const youtube = useYouTubeChannel();
  const showWatch = watchBandVisible(youtube);
  // /#about and /#contact deep links, once the data bands above them settled.
  useHashScroll(["about", "contact"], catalog.status !== "loading" && liveClasses.status !== "loading");

  const order = ["hero", "bestsellers", showWatch ? "watch" : null, "live", "certificate", "about", "story", "why", "journey", "cta"].filter(Boolean);
  const themes = assignBandThemes(order);

  return (
    <div className="lp" data-brand={siteBrand.id}>
      <HeroBand
        theme={themes.hero}
        isAuthenticated={isAuthenticated}
        liveBroadcast={liveBroadcast}
        courses={catalog.courses}
        tracks={catalog.tracks}
      />
      <BestsellersBand theme={themes.bestsellers} catalog={catalog} />
      {showWatch ? <WatchBand theme={themes.watch} youtube={youtube} /> : null}
      <LiveClassesBand theme={themes.live} liveClasses={liveClasses} liveBroadcast={liveBroadcast} />
      <CertificateBand theme={themes.certificate} />
      <AboutBand theme={themes.about} />
      <StoryBand theme={themes.story} />
      <WhyBand theme={themes.why} />
      <JourneyBand theme={themes.journey} />
      <CallToActionBand theme={themes.cta} joinPath={selectFeaturedCoursePath(catalog.courses)} />
    </div>
  );
}
