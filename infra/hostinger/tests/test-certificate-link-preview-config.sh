#!/usr/bin/env bash
# Certificate link previews in the public gateway (infra/hostinger/nginx/alsyedinitiative.conf).
# Link-preview crawlers asking for /certificates/<reference> must reach Django's
# Open Graph share page; people and every other path must be unaffected; the
# config must stay structurally valid. (deploy-nginx-config.sh runs `nginx -t`
# with rollback on the server; this test needs no nginx binary.)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
CONFIG="$REPO_ROOT/infra/hostinger/nginx/alsyedinitiative.conf"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$CONFIG" ]] || fail "missing $CONFIG"

# --- the crawler map ----------------------------------------------------------------------------
crawler_map="$(sed -n '/^map \$http_user_agent \$asi_link_preview_crawler {/,/^}/p' "$CONFIG")"
[[ -n "$crawler_map" ]] || fail "the link-preview crawler map is missing"
grep -Fq 'default 0;' <<<"$crawler_map" || fail "the crawler map must default to 0"
for bot in facebookexternalhit LinkedInBot Twitterbot WhatsApp Slackbot TelegramBot Discordbot Googlebot; do
  grep -Fq "$bot" <<<"$crawler_map" || fail "crawler map does not list $bot"
done
ua_regex="$(grep -o '"~\*[^"]*"' <<<"$crawler_map" | head -n1 | sed -e 's/^"~\*//' -e 's/"$//')"
[[ -n "$ua_regex" ]] || fail "crawler map has no case-insensitive regex"

matches_ua() { grep -Eiq -- "$ua_regex" <<<"$1"; }
for ua in \
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)" \
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" \
  "WhatsApp/2.23.20.0 A" \
  "Twitterbot/1.0" \
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" \
  "TelegramBot (like TwitterBot)" \
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" \
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"; do
  matches_ua "$ua" || fail "crawler not recognised: $ua"
done
for ua in \
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" \
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" \
  "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0" \
  "curl/8.5.0"; do
  if matches_ua "$ua"; then fail "a person's browser was treated as a crawler: $ua"; fi
done

preview_map="$(sed -n '/^map "\$asi_link_preview_crawler:\$arg_view" \$asi_certificate_preview {/,/^}/p' "$CONFIG")"
[[ -n "$preview_map" ]] || fail "the crawler + ?view map is missing"
grep -Fq 'default 0;' <<<"$preview_map" || fail "the preview map must default to 0"
grep -Fq '"1:"    1;' <<<"$preview_map" || fail "only crawlers without ?view=... may get the share page"

# --- the location lives only in the public website server -------------------------------------------
main_server="$(awk '/^server \{/{block=""; inside=1} inside{block=block $0 "\n"} /^\}/{if (inside && block ~ /server_name alsyedinitiative.com www.alsyedinitiative.com;/) printf "%s", block; inside=0}' "$CONFIG")"
[[ -n "$main_server" ]] || fail "main website server block not found"

location_line='    location ~ ^/certificates/[A-Za-z0-9_-]{1,64}/?$ {'
[[ "$(grep -Fxc -- "$location_line" "$CONFIG")" == "1" ]] || fail "expected exactly one certificate location in the config"
grep -Fxq -- "$location_line" <<<"$main_server" || fail "the certificate location must be in the alsyedinitiative.com server block"

cert_location="$(awk -v start="$location_line" '$0 == start {inside=1} inside {print} inside && /^    }$/ {exit}' <<<"$main_server")"
grep -Fq 'if ($asi_certificate_preview) {' <<<"$cert_location" || fail "the location must test \$asi_certificate_preview"
grep -Fq 'return 418;' <<<"$cert_location" || fail "the crawler branch must use the safe if/return form"
grep -Fq 'error_page 418 = @asi_certificate_preview;' <<<"$cert_location" || fail "missing error_page hand-off to the named location"
grep -Fq 'proxy_pass http://frontend_app;' <<<"$cert_location" || fail "people must still get the SPA"
if grep -Fq 'add_header' <<<"$cert_location"; then fail "add_header here would drop the server's security headers"; fi

named="$(awk '/^    location @asi_certificate_preview \{/{inside=1} inside{print} inside && /^    }$/{exit}' <<<"$main_server")"
[[ -n "$named" ]] || fail "the @asi_certificate_preview location is missing from the website server"
grep -Fq 'rewrite ^/certificates/([A-Za-z0-9_-]{1,64})/?$ /api/engagement/certificates/$1/share/ break;' <<<"$named" \
  || fail "crawlers must be rewritten to /api/engagement/certificates/<ref>/share/"
grep -Fq 'proxy_pass http://backend_app;' <<<"$named" || fail "the share page must come from the backend"
if grep -Fq 'add_header' <<<"$named"; then fail "add_header here would drop the server's security headers"; fi

# Nothing else changed in the website routing.
grep -Fq 'proxy_pass http://frontend_app;' <<<"$(awk '/^    location \/ \{/{inside=1} inside{print} inside && /^    }$/{exit}' <<<"$main_server")" \
  || fail "location / must still serve the SPA"
other_servers="$(awk '/^server \{/{block=""; inside=1} inside{block=block $0 "\n"} /^\}/{if (inside && block !~ /server_name alsyedinitiative.com www.alsyedinitiative.com;/) printf "%s", block; inside=0}' "$CONFIG")"
if grep -Fq 'asi_certificate_preview' <<<"$other_servers"; then fail "only the website server may route certificate previews"; fi

# --- the location regex matches certificate pages only ------------------------------------------------
path_regex='^/certificates/[A-Za-z0-9_-]{1,64}/?$'
for path in /certificates/ASI-2026-OSINT-000042-L /certificates/ASI-2026-OSINT-000042-L/ /certificates/Zx81kQ2mT0aBcDeFgHiJkL; do
  grep -Eq -- "$path_regex" <<<"$path" || fail "certificate path not matched: $path"
done
for path in / /certificates /certificates/ /certificates/a/b /certificates/../admin/ /courses/12 \
  /api/engagement/certificates/ASI-2026-OSINT-000042-L/ /monthly-ctf/certificates/abc /certificatesX/abc \
  "/certificates/$(printf 'a%.0s' {1..65})"; do
  if grep -Eq -- "$path_regex" <<<"$path"; then fail "path wrongly matched: $path"; fi
done

# --- structure: balanced braces, same server blocks -----------------------------------------------------
awk '
  {
    line = $0
    sub(/#.*/, "", line)
    gsub(/"[^"]*"/, "", line)
    gsub(/'"'"'[^'"'"']*'"'"'/, "", line)
    # Regex quantifiers like {1,64} are not blocks.
    gsub(/\{[0-9]+(,[0-9]*)?\}/, "", line)
    for (i = 1; i <= length(line); i++) {
      c = substr(line, i, 1)
      if (c == "{") depth++
      if (c == "}") { depth--; if (depth < 0) { print "unbalanced } at line " NR; exit 1 } }
    }
  }
  END { if (depth != 0) { print "unbalanced braces: depth " depth; exit 1 } }
' "$CONFIG" || fail "nginx config braces are unbalanced"
[[ "$(grep -c '^server {' "$CONFIG")" == "4" ]] || fail "expected the 4 server blocks (website, api, livekit, stream)"
[[ "$(grep -c '^map ' "$CONFIG")" -ge 4 ]] || fail "maps went missing"

echo "Certificate link-preview gateway configuration tests passed."
