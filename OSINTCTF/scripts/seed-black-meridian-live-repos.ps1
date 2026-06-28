param(
    [string]$Owner = "mikaelashborne",
    [string]$Branch = "black-meridian"
)

$ErrorActionPreference = "Stop"

function Write-Utf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $resolvedPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $directory = Split-Path -Parent $resolvedPath
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
    [System.IO.File]::WriteAllText($resolvedPath, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Add-Commit {
    param(
        [Parameter(Mandatory = $true)][string]$Message
    )
    git add .
    git commit -m $Message | Out-Null
}

function Clone-Repo {
    param(
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][string]$WorkRoot
    )
    $target = Join-Path $WorkRoot $Repo
    git clone --quiet "https://github.com/$Owner/$Repo.git" $target
    Push-Location $target
    git checkout -B $Branch origin/main | Out-Null
    Pop-Location
    return $target
}

$workRoot = Join-Path $env:TEMP ("black-meridian-live-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workRoot | Out-Null

try {
    $publicArchive = Clone-Repo -Repo "public-archive" -WorkRoot $workRoot
    Push-Location $publicArchive
    Write-Utf8File "README.md" @"
# public-archive

Public mirror material for the Black Meridian investigation.

Start from the real public profile used in the lab. The profile does not give
you the answer directly; it gives you the operator cluster that eventually
pivots here.
"@
    Write-Utf8File "mirror/field-posts.ndjson" @"
{"platform":"microblog","user":"kestrel_ops","posted_at":"2026-04-14T03:12:40Z","device_nonce":"c0a9-71","tz_hint":"UTC+0","text":"night build complete. north wind again. no screenshots."}
{"platform":"forum","user":"nyx-aurora-71","posted_at":"2026-04-14T03:12:44Z","device_nonce":"c0a9-71","tz_hint":"UTC+0","text":"night build complete. north wind again. no screenshots."}
{"platform":"paste-index","user":"mvelen","posted_at":"2026-04-14T03:12:45Z","device_nonce":"c0a9-71","tz_hint":"UTC+0","text":"night build complete. north wind again. no screenshots."}
{"platform":"git-mirror","user":"nyx-aurora-71","posted_at":"2026-04-19T22:08:03Z","device_nonce":"c0a9-71","tz_hint":"UTC+0","text":"forgot to rotate the old northstar records. will clean later."}
{"platform":"image-board","user":"aurora7","posted_at":"2026-04-19T22:08:11Z","device_nonce":"9bd1-02","tz_hint":"UTC+2","text":"northstar records are boring."}
{"platform":"package-registry","user":"nyx-aurora-71","posted_at":"2026-04-22T10:02:19Z","device_nonce":"c0a9-71","tz_hint":"UTC+0","text":"publishing the public ops helper again. salt should never live in history."}
{"platform":"qna","user":"nyx_aurora71","posted_at":"2026-04-22T10:02:20Z","device_nonce":"771e-aa","tz_hint":"UTC+5:30","text":"publishing the public ops helper again."}
{"platform":"archive-comment","user":"nyx-aurora-71","posted_at":"2026-04-30T01:33:08Z","device_nonce":"c0a9-71","tz_hint":"UTC+0","text":"if the payload fails, join mailbox|salt|shortkey with pipes."}
"@
    Write-Utf8File "mirror/profile-card.html" @"
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>northstar profile card</title>
  <meta name="description" content="night operator, cold routes, archive hygiene">
  <meta name="operator-contact" content="bWFyYS52ZWxlbkBwcm90b24ubWU=">
</head>
<body>
  <h1>Northstar Field Notes</h1>
  <p>Public card mirrored from a static profile. Most visible content is cover text.</p>
  <p>Current contact links were removed after the April cleanup.</p>
  <!-- The operator hid the real contact in a metadata value, not in the page body. -->
</body>
</html>
"@
    Write-Utf8File "archives/redirector-captures.txt" @"
capture: 2026-03-21T18:44:03Z
url: https://collector.northstar-telemetry.net/status
status: 302
location: /maintenance
x-cache-note: archived by third-party crawler
x-amz-bucket: ns-archive-kestrel-7741
x-amz-region: eu-north-1

capture: 2026-04-04T11:19:50Z
url: https://collector.northstar-telemetry.net/status
status: 200
x-cache-note: headers normalized after cleanup
x-amz-bucket: [removed]
x-amz-region: [removed]
"@
    Write-Utf8File "tools/rebuild_index.py" @"
#!/usr/bin/env python3
import json
from pathlib import Path

rows = [json.loads(line) for line in Path("mirror/field-posts.ndjson").read_text().splitlines() if line.strip()]
for row in rows:
    print(f"{row['posted_at']} {row['platform']} {row['user']} {row['device_nonce']}")
"@
    Add-Commit "Add Black Meridian public mirror artifacts"
    Pop-Location

    $crbv = Clone-Repo -Repo "CRBV" -WorkRoot $workRoot
    Push-Location $crbv
    Write-Utf8File "data/passive_dns.csv" @"
first_seen,last_seen,rrtype,name,value,source,notes
2026-03-02,2026-03-29,CNAME,login.black-meridian.example,edge.pages.example,passive-cache,vanity front only
2026-03-02,2026-03-29,A,edge.pages.example,104.21.12.44,passive-cache,shared proxy
2026-03-16,2026-04-08,CNAME,telemetry.black-meridian.example,collector.northstar-telemetry.net,passive-cache,pivot target
2026-03-16,2026-03-24,A,collector.northstar-telemetry.net,45.83.19.204,passive-cache,pre-proxy origin
2026-03-25,2026-04-08,A,collector.northstar-telemetry.net,172.67.19.91,passive-cache,proxy edge
2026-04-02,2026-04-28,TXT,_archive.northstar-telemetry.net,"mirror=enabled; bucket=redacted",passive-cache,post-cleanup
"@
    Write-Utf8File "src/dns_normalizer.py" @"
#!/usr/bin/env python3
import csv
from pathlib import Path

with Path("data/passive_dns.csv").open(newline="", encoding="utf-8") as handle:
    for row in csv.DictReader(handle):
        if "northstar" in row["name"] or "northstar" in row["value"]:
            print(row)
"@
    Add-Commit "Add passive DNS evidence for Black Meridian"
    Pop-Location

    $pgp = Clone-Repo -Repo "PGP" -WorkRoot $workRoot
    Push-Location $pgp
    Write-Utf8File "public_keys/key-transition.txt" @"
Black Meridian key transition note

Primary identity key:
  fingerprint: 21A8 B45D 728C 42AA 91F0  F61A 1B04 E6C2 AA99 8201
  capabilities: certify, sign
  short id: 0xaa998201

Retired signing subkey:
  fingerprint: 998B F741 BDA0 618C D920  F1C2 18E3 0B7A 71AA 0390
  capabilities: sign only
  short id: 0x71aa0390

Current transport subkey:
  fingerprint: 0A79 D8C1 8B31 1239 F77C  D17C 337A B221 4B9D 17AC
  capabilities: encrypt only
  short id: 0x4b9d17ac

Reminder: the vault derivation joins contact, removed salt, and transport short id with pipe characters.
"@
    Write-Utf8File "src/select_transport_key.js" @"
const fs = require("fs");

const material = fs.readFileSync("public_keys/key-transition.txt", "utf8");
const blocks = material.split(/\n\n+/);
const transport = blocks.find((block) => /encrypt only/i.test(block));
if (!transport) {
  throw new Error("transport key not found");
}
console.log(transport.match(/short id:\s*(0x[a-f0-9]+)/i)[1].toLowerCase());
"@
    Add-Commit "Add Black Meridian key transition material"
    Pop-Location

    $madson = Clone-Repo -Repo "Madsonrepo" -WorkRoot $workRoot
    Push-Location $madson
    Write-Utf8File "media/photo-metadata.json" @"
{
  "file": "IMG_20260426_221938_export.jpg",
  "camera": {
    "make": "Fujifilm",
    "model": "X100V",
    "serial_last4": "7741"
  },
  "exif": {
    "DateTimeOriginal": "2026:04:26 22:19:38",
    "OffsetTimeOriginal": "+00:00",
    "GPSLatitudeRef": "N",
    "GPSLatitude": "65 deg 41' 02.04\"",
    "GPSLongitudeRef": "W",
    "GPSLongitude": "18 deg 06' 37.80\""
  },
  "caption_fragment": "cold stop, no city tags"
}
"@
    Write-Utf8File "logs/flight-notices.csv" @"
observed_at,airport,lat,lon,flight,operator,asset,remarks
2026-04-26T22:12:00Z,AEY,65.6600,-18.0727,NS-044,NordSkies,TF-SIF,"short halt, maintenance van visible"
2026-04-26T22:41:00Z,KEF,63.9850,-22.6056,SK-901,Scandi Air,OY-KBT,"scheduled passenger service"
2026-04-27T04:09:00Z,RKV,64.1300,-21.9406,NS-047,NordSkies,TF-NOR,"unrelated medical transfer"
2026-04-27T05:33:00Z,AEY,65.6600,-18.0727,NS-044,NordSkies,TF-SIF,"same asset departed before sunrise"
"@
    Write-Utf8File "src/coordinate_converter.py" @"
#!/usr/bin/env python3
import re
import json
from pathlib import Path

def dms_to_decimal(value: str, ref: str) -> float:
    degrees, minutes, seconds = [float(part) for part in re.findall(r"\d+(?:\.\d+)?", value)]
    decimal = degrees + minutes / 60 + seconds / 3600
    if ref in {"S", "W"}:
        decimal *= -1
    return decimal

data = json.loads(Path("media/photo-metadata.json").read_text(encoding="utf-8"))
exif = data["exif"]
lat = dms_to_decimal(exif["GPSLatitude"], exif["GPSLatitudeRef"])
lon = dms_to_decimal(exif["GPSLongitude"], exif["GPSLongitudeRef"])
print(f"{lat:.4f},{lon:.4f}")
"@
    Add-Commit "Add northern stop metadata and movement ledger"
    Pop-Location

    $vault = Clone-Repo -Repo "secure-vault" -WorkRoot $workRoot
    Push-Location $vault
    Write-Utf8File "config/recovery.json" @"
{
  "mode": "student-safe",
  "digest": "sha256",
  "salt": "BM-SALT-7f29-azimuth",
  "separator": "|",
  "key_order": ["contact", "salt", "short_key_id"],
  "output_encoding": "utf8"
}
"@
    Write-Utf8File "src/recover.py" @"
#!/usr/bin/env python3
import base64
import hashlib
from pathlib import Path


def xor_stream(ciphertext: bytes, key: bytes) -> bytes:
    return bytes(byte ^ key[index % len(key)] for index, byte in enumerate(ciphertext))


def main() -> None:
    contact = input("contact mailbox: ").strip()
    salt = input("removed salt: ").strip()
    short_key_id = input("transport short key id: ").strip().lower()
    passphrase = f"{contact}|{salt}|{short_key_id}"

    payload_path = Path(__file__).resolve().parents[1] / "vault" / "payload.b64"
    ciphertext = base64.b64decode(payload_path.read_text(encoding="utf-8").strip())
    key = hashlib.sha256(passphrase.encode("utf-8")).digest()
    print(xor_stream(ciphertext, key).decode("utf-8"))


if __name__ == "__main__":
    main()
"@
    Write-Utf8File "vault/payload.b64" "TKGljuJ+ibvFi0Ljtlfth8geUM8LmVqcVWu9NsVnb8Fw`n"
    Add-Commit "Add Black Meridian vault recovery scaffold"
    $config = Get-Content -Raw "config/recovery.json" | ConvertFrom-Json
    $config.PSObject.Properties.Remove("salt")
    Write-Utf8File "config/recovery.json" ($config | ConvertTo-Json -Depth 8)
    Add-Commit "Remove local recovery salt from public config"
    Pop-Location

    foreach ($repo in @("public-archive", "CRBV", "PGP", "Madsonrepo", "secure-vault")) {
        Push-Location (Join-Path $workRoot $repo)
        git push --force-with-lease origin "${Branch}:${Branch}"
        Pop-Location
    }
}
finally {
    Set-Location -LiteralPath (Split-Path -Parent $workRoot)
    if (Test-Path -LiteralPath $workRoot) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force
    }
}
