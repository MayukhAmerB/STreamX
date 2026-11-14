// Client mirror of apps.core.textnorm.target_key, used only for instant
// "You already have a report for …" feedback. The server stays the authority
// (it answers 409 duplicate_target / similar_target), so this mirror must
// never merge targets the server keeps apart: different domains or TLDs,
// different profiles on one platform, handles, e-mails and IP addresses each
// keep their own key. See backend/tests/test_textnorm_target_keys.py.

const LEGAL_SUFFIXES = new Set([
  "ltd", "limited", "pvt", "private", "pte", "plc", "llc", "llp", "lllp", "pllc", "lp", "inc", "incorporated",
  "corp", "corporation", "co", "company", "gmbh", "ag", "kg", "sa", "sas", "sarl", "srl", "spa", "bv", "nv", "oy",
  "oyj", "ab", "pty", "kk", "opc", "bhd", "sdn", "ltda", "jsc", "pjsc", "ooo", "group", "holdings", "international",
  "intl",
]);

const HOST_ALIASES = {
  "fb.com": "facebook.com", "fb.me": "facebook.com", "twitter.com": "x.com", "telegram.me": "t.me",
  "telegram.dog": "t.me", "youtu.be": "youtube.com", "instagr.am": "instagram.com", "discordapp.com": "discord.com",
};

const IDENTITY_HOSTS = new Set([
  "facebook.com", "instagram.com", "x.com", "threads.net", "threads.com", "linkedin.com", "github.com", "gitlab.com",
  "bitbucket.org", "codeberg.org", "youtube.com", "tiktok.com", "reddit.com", "medium.com", "t.me", "pinterest.com",
  "snapchat.com", "vk.com", "ok.ru", "quora.com", "stackoverflow.com", "soundcloud.com", "twitch.tv", "discord.gg",
  "discord.com", "wa.me", "keybase.io", "about.me", "behance.net", "dribbble.com", "huggingface.co", "hackerone.com",
  "bugcrowd.com", "linktr.ee", "patreon.com", "kaggle.com", "flickr.com", "vimeo.com", "mastodon.social", "bsky.app",
  "tryhackme.com", "app.hackthebox.com", "sites.google.com", "play.google.com", "apps.apple.com", "crunchbase.com",
  "angel.co", "wellfound.com", "glassdoor.com", "glassdoor.co.in", "zaubacorp.com", "opencorporates.com",
]);

const SUBDOMAIN_IDENTITY_HOSTS = [
  "tumblr.com", "medium.com", "substack.com", "blogspot.com", "wordpress.com", "github.io", "gitlab.io",
  "netlify.app", "vercel.app", "pages.dev", "herokuapp.com", "wixsite.com", "carrd.co", "notion.site",
];

const CASE_SENSITIVE_PATH_HOSTS = new Set(["youtube.com", "discord.gg", "discord.com", "apps.apple.com"]);
const REPOSITORY_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "huggingface.co"]);
const LOCALE_PREFIXED_HOSTS = new Set(["apps.apple.com"]);
const STRUCTURAL_SEGMENTS = new Set(["watch", "shorts", "live", "embed", "playlist", "details"]);
const PATH_NAMESPACES = {
  in: 2, company: 2, school: 2, showcase: 2, pub: 2, groups: 2, group: 2, pages: 3, people: 3, channel: 2, c: 2,
  user: 2, users: 2, u: 2, r: 2, orgs: 2, org: 2, organization: 2, organizations: 2, view: 2, invite: 2,
  profile: 2, app: 3, store: 3, datasets: 3, spaces: 3, shorts: 2, live: 2, embed: 2, playlist: 1, p: 2, reel: 2,
  tv: 2,
};
const IDENTITY_QUERY_PARAMETERS = new Set(["id", "v", "list", "fbid", "story_fbid"]);
const GENERIC_SITE_PAGES = new Set([
  "about", "about-us", "aboutus", "about_us", "company", "contact", "contact-us", "contactus", "contact_us", "home",
  "team", "our-team", "leadership", "management", "people", "careers", "career", "jobs", "join-us", "products",
  "product", "services", "service", "solutions", "blog", "news", "press", "media", "newsroom", "investors",
  "investor-relations", "privacy", "privacy-policy", "terms", "legal", "imprint", "impressum", "faq", "support",
  "help", "login", "signin", "sign-in", "signup", "register", "shop", "store", "pricing", "portfolio", "projects",
  "gallery", "events", "resources", "partners", "clients", "customers", "locations", "wp-content", "wp-admin",
  "static", "assets", "public", "page", "pages", "category", "tag", "search",
]);
const WEB_SCHEMES = new Set(["http", "https", "ftp", "ftps", "sftp", "ws", "wss", "hxxp", "hxxps"]);

// Control, zero-width and bidi characters (as apps.core.textnorm._CONTROL).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/gu;
const EDGE = "\"'`‘’“”«»<>()[]{} ";
const LOCALE_SEGMENT = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/;
const PAGE_FILE = /^(?:index|default|home|main)(?:\.[a-z0-9]{2,5})?$|^[^/]*\.(?:html?|php|aspx?|jsp|cfm)$/;
const HOST = /^(?:[\p{L}\p{N}_-]+\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$/u;
const MIRROR_LABEL = /^(?:www\d*|m|mobile|mbasic|touch|web|old|new|[a-z]{2}(?:-[a-z]{2})?)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const fold = (text) => text.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC");
const hasAlnum = (text) => /[\p{L}\p{N}]/u.test(text);

function trimChars(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Canonical IPv4/IPv6 text (as Python's ipaddress prints it), or null. */
function ipKey(text) {
  let value = text.replace(/^\[|\]$/g, "");
  let prefix = "";
  const slash = value.indexOf("/");
  if (slash > -1) {
    prefix = value.slice(slash + 1);
    value = value.slice(0, slash);
    if (!/^\d{1,3}$/.test(prefix)) return null;
  }
  if (IPV4.test(value)) {
    if (!prefix) return value;
    const bits = Number(prefix);
    if (bits > 32) return null;
    const number = value.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
    const network = Math.floor(number / 2 ** (32 - bits)) * 2 ** (32 - bits);
    const octets = [24, 16, 8, 0].map((shift) => Math.floor(network / 2 ** shift) % 256);
    return `${octets.join(".")}/${bits}`;
  }
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return null;
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const toGroups = (part) => (part ? part.split(":") : []);
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const numbers = groups.map((group) => parseInt(group, 16).toString(16));
  // Longest run (2+) of zero groups becomes "::", as RFC 5952 / Python print it.
  let best = [-1, 0];
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && numbers[start + length] === "0") length += 1;
    if (length > best[1]) best = [start, length];
  }
  let canonical = numbers.join(":");
  if (best[1] > 1) {
    canonical = `${numbers.slice(0, best[0]).join(":")}::${numbers.slice(best[0] + best[1]).join(":")}`;
  }
  return prefix ? `${canonical}/${prefix}` : canonical;
}

/** RFC 3492 Punycode decoding of one "xn--" label (null when malformed). */
function decodePunycode(label) {
  const input = label.slice(4);
  const base = 36;
  const delimiter = input.lastIndexOf("-");
  const output = delimiter > 0 ? [...input.slice(0, delimiter)].map((ch) => ch.codePointAt(0)) : [];
  let n = 128;
  let i = 0;
  let bias = 72;
  const adapt = (delta, points, first) => {
    let value = first ? Math.floor(delta / 700) : delta >> 1;
    value += Math.floor(value / points);
    let k = 0;
    while (value > ((base - 1) * 26) >> 1) {
      value = Math.floor(value / (base - 1));
      k += base;
    }
    return k + Math.floor((base * value) / (value + 38));
  };
  for (let index = delimiter > 0 ? delimiter + 1 : 0; index < input.length; ) {
    const oldI = i;
    let weight = 1;
    for (let k = base; ; k += base) {
      if (index >= input.length) return null;
      const code = input.charCodeAt(index++);
      const digit = code - 48 < 10 ? code - 22 : code - 97 < 26 ? code - 97 : base;
      if (digit >= base) return null;
      i += digit * weight;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      weight *= base - t;
    }
    bias = adapt(i - oldI, output.length + 1, oldI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    output.splice(i, 0, n);
    i += 1;
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
}

function hostKey(raw) {
  let host = raw
    .trim()
    .replace(/\.+$/, "")
    .toLowerCase()
    .split(".")
    .map((label) => (label.startsWith("xn--") ? decodePunycode(label) || label : label))
    .join(".");
  if (!host || !HOST.test(host)) return null;
  host = host.replace(/^www\d*\./, "");
  host = HOST_ALIASES[host] || host;
  if (!IDENTITY_HOSTS.has(host)) {
    const parts = host.split(".");
    for (let start = 1; start < parts.length - 1; start += 1) {
      const parent = parts.slice(start).join(".");
      if (IDENTITY_HOSTS.has(parent) || HOST_ALIASES[parent]) {
        if (parts.slice(0, start).every((label) => MIRROR_LABEL.test(label))) host = HOST_ALIASES[parent] || parent;
        break;
      }
    }
  }
  return host;
}

function identityPath(host, path, query) {
  const caseSensitive = CASE_SENSITIVE_PATH_HOSTS.has(host);
  let segments = path.split("/").map((segment) => decode(segment).trim()).filter(Boolean);
  if (LOCALE_PREFIXED_HOSTS.has(host)) {
    while (segments.length && LOCALE_SEGMENT.test(segments[0].toLowerCase())) segments.shift();
  }
  if (segments.length) {
    const first = segments[0].toLowerCase();
    const depth = PATH_NAMESPACES[first] || (REPOSITORY_HOSTS.has(host) ? 2 : 1);
    segments = segments.slice(0, depth);
  }
  const folded = segments.map((segment) => {
    const lower = segment.toLowerCase();
    const structural = lower in PATH_NAMESPACES || STRUCTURAL_SEGMENTS.has(lower) || segment.startsWith("@");
    return caseSensitive && !structural ? segment : lower;
  });
  const params = [];
  for (const [name, rawValue] of new URLSearchParams(query)) {
    const value = rawValue.trim();
    if (IDENTITY_QUERY_PARAMETERS.has(name.toLowerCase()) && value) {
      params.push([name.toLowerCase(), caseSensitive ? value : value.toLowerCase()]);
    }
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  let identity = folded.join("/");
  if (params.length) identity += `?${params.map(([name, value]) => `${name}=${value}`).join("&")}`;
  return identity;
}

function sitePathSegment(path) {
  for (const raw of path.split("/")) {
    const segment = decode(raw).trim().toLowerCase();
    if (!segment || LOCALE_SEGMENT.test(segment)) continue;
    if (GENERIC_SITE_PAGES.has(segment) || PAGE_FILE.test(segment)) return "";
    return segment;
  }
  return "";
}

function urlKey(text) {
  let value = text;
  const scheme = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(value);
  if (scheme) {
    if (!WEB_SCHEMES.has(scheme[1].toLowerCase()) || !scheme[2]) return null;
    value = value.slice(scheme[0].length);
  } else if (!/^[^\s/?#@]+$/.test(value.split(/[/?#]/, 1)[0])) {
    return null;
  }
  const authorityEnd = value.search(/[/?#]/);
  let authority = authorityEnd === -1 ? value : value.slice(0, authorityEnd);
  const rest = authorityEnd === -1 ? "" : value.slice(authorityEnd);
  authority = authority.slice(authority.lastIndexOf("@") + 1);
  let hostname = authority;
  if (authority.startsWith("[")) hostname = authority.slice(1, authority.indexOf("]") > 0 ? authority.indexOf("]") : undefined);
  else hostname = authority.replace(/:\d*$/, "");
  const withoutFragment = rest.split("#", 1)[0];
  const queryAt = withoutFragment.indexOf("?");
  let path = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt);
  let query = queryAt === -1 ? "" : withoutFragment.slice(queryAt + 1);
  const ip = ipKey(hostname.toLowerCase());
  if (ip) return ip;
  const host = hostKey(hostname);
  if (!host) return null;
  if (hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\d*\./, "") === "youtu.be") {
    const video = path.split("/").find(Boolean) || "";
    [path, query] = video ? ["/watch", `v=${video}`] : ["", ""];
  }
  let identity;
  if (IDENTITY_HOSTS.has(host)) identity = identityPath(host, path, query);
  else if (SUBDOMAIN_IDENTITY_HOSTS.some((platform) => host.endsWith(`.${platform}`))) identity = "";
  else identity = sitePathSegment(path);
  return identity ? `${host}/${identity}` : host;
}

function emailKey(text) {
  const value = text.replace(/^mailto:/i, "");
  if (!/^[^\s@/]+@[^\s@/]+$/.test(value)) return null;
  const at = value.lastIndexOf("@");
  const host = hostKey(value.slice(at + 1));
  if (!at || !host) return null;
  return `${value.slice(0, at).toLowerCase()}@${host}`;
}

function nameKey(text) {
  let value = fold(text);
  const withoutMessrs = value.replace(/^m\s*\/\s*s\b\.?\s*/i, "");
  if (hasAlnum(withoutMessrs)) value = withoutMessrs;
  value = value.replace(/[&+]/g, " and ").replace(/(?<=[\p{L}\p{N}_])['’`ʼ](?=[\p{L}\p{N}_])/gu, "");
  value = value.replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").replace(/_/g, " ");
  const words = [];
  let run = [];
  const flush = () => {
    if (run.length) words.push(run.length > 1 ? run.join("") : run[0]);
    run = [];
  };
  for (const word of value.split(/\s+/).filter(Boolean)) {
    if ([...word].length === 1 && /\p{L}/u.test(word)) {
      run.push(word);
      continue;
    }
    flush();
    words.push(word);
  }
  flush();
  if (!words.length) return "";
  const stripped = [...words];
  while (stripped.length > 1 && stripped[0] === "the") stripped.shift();
  let removedSuffix = false;
  while (stripped.length > 1) {
    const last = stripped[stripped.length - 1];
    if (LEGAL_SUFFIXES.has(last)) {
      stripped.pop();
      removedSuffix = true;
    } else if (removedSuffix && last === "and") {
      stripped.pop();
    } else {
      break;
    }
  }
  const meaningless = stripped.every((word) => LEGAL_SUFFIXES.has(word) || word === "the" || word === "and");
  return (meaningless ? words : stripped).join(" ");
}

export function clientTargetKey(name = "") {
  // Whitespace first, so a tab or newline separates words before control
  // characters are dropped (as on the server).
  let value = String(name || "").normalize("NFKC").replace(/\s+/g, " ").replace(CONTROL, "").replace(/\s+/g, " ").trim();
  value = trimChars(trimChars(value, EDGE).replace(/[.,;:!]+$/, ""), EDGE);
  if (!hasAlnum(value)) return "";
  if (!value.includes(" ")) {
    const key = ipKey(value.toLowerCase()) || emailKey(value) || urlKey(value);
    if (key) return key;
    if (/^@[\p{L}\p{N}_.]*[\p{L}\p{N}_][\p{L}\p{N}_.]*$/u.test(value)) return `@${value.slice(1).toLowerCase().replace(/\.+$/, "")}`;
  }
  return nameKey(value).trim();
}
