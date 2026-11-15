/* High-fidelity monochrome SVG recreations of the National Desk hero imagery. */

/* Simplified Ashoka Lion Capital emblem (state emblem of India). */
function AshokaEmblem({ x = 0, y = 0, scale = 1, color = "#1c1b18", opacity = 1 }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} fill={color} opacity={opacity}>
      {/* side lions */}
      <path d="M-13 -2c-3-4-2-9 1-11 2 4 3 5 6 6-1 2-1 4 0 6-2 0-5-1-7-1Z" />
      <path d="M13 -2c3-4 2-9-1-11-2 4-3 5-6 6 1 2 1 4 0 6 2 0 5-1 7-1Z" />
      {/* center lion head */}
      <path d="M0 -16c4 0 7 3 7 8 0 3-1 5-2 7h-10c-1-2-2-4-2-7 0-5 3-8 7-8Z" />
      <circle cx="-2.4" cy="-9" r="0.9" fill="#d8d6cf" />
      <circle cx="2.4" cy="-9" r="0.9" fill="#d8d6cf" />
      {/* abacus */}
      <rect x="-13" y="1" width="26" height="3" rx="1" />
      {/* chakra */}
      <circle cx="0" cy="9" r="5" fill="none" stroke={color} strokeWidth="1.4" />
      <g stroke={color} strokeWidth="0.7">
        <line x1="0" y1="4" x2="0" y2="14" /><line x1="-5" y1="9" x2="5" y2="9" />
        <line x1="-3.5" y1="5.5" x2="3.5" y2="12.5" /><line x1="3.5" y1="5.5" x2="-3.5" y2="12.5" />
      </g>
      {/* base */}
      <path d="M-9 4h18l-2 4h-14Z" />
    </g>
  );
}

export function FirPaperHero({ className = "" }) {
  return (
    <svg viewBox="0 0 800 540" className={className} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="fir-spot" cx="46%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#3a362f" />
          <stop offset="48%" stopColor="#201d18" />
          <stop offset="100%" stopColor="#070604" />
        </radialGradient>
        <linearGradient id="fir-paper" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#e7e4db" />
          <stop offset="55%" stopColor="#cfccc1" />
          <stop offset="100%" stopColor="#a9a598" />
        </linearGradient>
        <linearGradient id="fir-cap" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2b2b2b" />
          <stop offset="100%" stopColor="#0c0c0c" />
        </linearGradient>
        <linearGradient id="fir-plate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#30302f" />
          <stop offset="50%" stopColor="#141414" />
          <stop offset="100%" stopColor="#242423" />
        </linearGradient>
        <linearGradient id="fir-pen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#4a4a4a" />
          <stop offset="60%" stopColor="#111" />
          <stop offset="100%" stopColor="#333" />
        </linearGradient>
        <radialGradient id="fir-vign" cx="50%" cy="42%" r="75%">
          <stop offset="55%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.72" />
        </radialGradient>
      </defs>

      {/* Desk */}
      <rect width="800" height="540" fill="url(#fir-spot)" />
      {/* wood grain */}
      <g stroke="#000" strokeOpacity="0.16" strokeWidth="1">
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={i} x1="0" y1={60 + i * 55} x2="800" y2={70 + i * 55} />
        ))}
      </g>

      {/* blurred files/book behind left */}
      <g opacity="0.55">
        <rect x="40" y="150" width="150" height="40" rx="4" fill="#161616" />
        <rect x="55" y="120" width="150" height="40" rx="4" fill="#1d1d1d" />
      </g>

      {/* Police cap top-right */}
      <g transform="translate(628 120)">
        <ellipse cx="0" cy="36" rx="118" ry="30" fill="#000" opacity="0.5" />
        <path d="M-96 26c0-12 10-22 96-22s96 10 96 22c0 10-40 16-96 16s-96-6-96-16Z" fill="url(#fir-cap)" />
        <path d="M-108 30c30 16 186 16 216 0 8 6 6 16-8 20-40 12-172 12-200 0-14-4-16-14-8-20Z" fill="#070707" />
        <rect x="-92" y="18" width="184" height="12" rx="6" fill="#050505" />
        <path d="M-70 6c0-18 24-30 70-30s70 12 70 30c0 6-30 10-70 10s-70-4-70-10Z" fill="#232323" />
        <AshokaEmblem x={0} y={-4} scale={0.62} color="#9a8b4e" opacity={0.9} />
      </g>

      {/* POLICE nameplate */}
      <g transform="translate(150 360) rotate(-7)">
        <rect x="-110" y="-26" width="220" height="52" rx="8" fill="url(#fir-plate)" stroke="#000" strokeWidth="2" />
        <rect x="-110" y="-26" width="220" height="8" rx="4" fill="#4a4a4a" opacity="0.5" />
        <text x="0" y="10" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700" fontSize="34" letterSpacing="10" fill="#c9c9c9">POLICE</text>
      </g>

      {/* FIR paper */}
      <g transform="translate(430 300) rotate(-4)">
        <rect x="-150" y="-200" width="300" height="400" rx="4" fill="#000" opacity="0.45" transform="translate(10 14)" />
        <rect x="-150" y="-200" width="300" height="400" rx="4" fill="url(#fir-paper)" />
        {/* header */}
        <AshokaEmblem x={0} y={-168} scale={1.15} color="#20201c" />
        <text x="0" y="-130" textAnchor="middle" fontFamily="'Noto Sans', sans-serif" fontSize="9" letterSpacing="2" fill="#3a382f">सत्यमेव जयते</text>
        <text x="0" y="-92" textAnchor="middle" fontFamily="Georgia, serif" fontWeight="800" fontSize="52" letterSpacing="4" fill="#1b1a16">FIR</text>
        <text x="0" y="-68" textAnchor="middle" fontFamily="Georgia, serif" fontWeight="700" fontSize="15" letterSpacing="1.5" fill="#1b1a16">FIRST INFORMATION REPORT</text>
        <line x1="-120" y1="-56" x2="120" y2="-56" stroke="#1b1a16" strokeWidth="1" opacity="0.4" />
        {/* fields */}
        <g fontFamily="Georgia, serif" fontSize="12" fill="#2a271f">
          {[
            ["Police Station :", -26],
            ["District :", 4],
            ["Date & Time of Registration :", 34],
            ["FIR No. :", 64],
            ["Acts / Sections :", 94],
          ].map(([label, yy]) => (
            <g key={label} transform={`translate(-120 ${yy})`}>
              <text x="0" y="0">{label}</text>
              <line x1="4" y1="6" x2="240" y2="6" stroke="#1b1a16" strokeWidth="0.8" opacity="0.4" />
            </g>
          ))}
          <line x1="-116" y1="126" x2="124" y2="126" stroke="#1b1a16" strokeWidth="0.8" opacity="0.4" />
          <line x1="-116" y1="150" x2="124" y2="150" stroke="#1b1a16" strokeWidth="0.8" opacity="0.4" />
        </g>
      </g>

      {/* Pen */}
      <g transform="translate(560 430) rotate(28)">
        <rect x="-8" y="-6" width="190" height="12" rx="6" fill="url(#fir-pen)" />
        <path d="M-8 0 -34 0 -14 -7 -14 7Z" fill="#c9c9c9" />
        <path d="M-34 0 -44 0 -30 -3 -30 3Z" fill="#8a8a8a" />
        <rect x="150" y="-6" width="34" height="12" rx="6" fill="#2a2a2a" />
      </g>

      <rect width="800" height="540" fill="url(#fir-vign)" />
    </svg>
  );
}

export function LawBooksHero({ className = "" }) {
  return (
    <svg viewBox="0 0 560 440" className={className} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="law-spot" cx="62%" cy="26%" r="85%">
          <stop offset="0%" stopColor="#333" />
          <stop offset="52%" stopColor="#161616" />
          <stop offset="100%" stopColor="#060606" />
        </radialGradient>
        <linearGradient id="law-book" x1="0" y1="0" x2="1" y2="0.2">
          <stop offset="0%" stopColor="#272727" />
          <stop offset="55%" stopColor="#1b1b1b" />
          <stop offset="100%" stopColor="#101010" />
        </linearGradient>
        <linearGradient id="law-page" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b7b4a8" />
          <stop offset="100%" stopColor="#7c7a70" />
        </linearGradient>
        <linearGradient id="law-brass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8f8a6f" />
          <stop offset="100%" stopColor="#3b3a2c" />
        </linearGradient>
        <radialGradient id="law-vign" cx="50%" cy="45%" r="72%">
          <stop offset="58%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.7" />
        </radialGradient>
      </defs>

      <rect width="560" height="440" fill="url(#law-spot)" />

      {/* Scales of justice (behind) */}
      <g transform="translate(400 70)" stroke="url(#law-brass)" fill="url(#law-brass)">
        <rect x="-3" y="0" width="6" height="150" rx="2" />
        <rect x="-40" y="146" width="80" height="8" rx="3" />
        <rect x="-70" y="12" width="140" height="5" rx="2.5" />
        <g stroke="url(#law-brass)" strokeWidth="1.4" fill="none">
          <line x1="-68" y1="16" x2="-68" y2="46" /><line x1="-88" y1="46" x2="-48" y2="46" />
          <line x1="68" y1="16" x2="68" y2="46" /><line x1="48" y1="46" x2="88" y2="46" />
          <line x1="-88" y1="46" x2="-68" y2="64" /><line x1="-48" y1="46" x2="-68" y2="64" />
          <line x1="48" y1="46" x2="68" y2="64" /><line x1="88" y1="46" x2="68" y2="64" />
        </g>
        <path d="M-92 46a24 10 0 0 0 48 0Z" fill="url(#law-brass)" />
        <path d="M44 46a24 10 0 0 0 48 0Z" fill="url(#law-brass)" />
        <circle cx="0" cy="12" r="6" fill="url(#law-brass)" />
      </g>

      {/* Stacked books */}
      <g transform="translate(70 250)">
        {[
          { y: 0, w: 420, label: "CRIMINAL PROCEDURE CODE", dx: 0 },
          { y: 44, w: 400, label: "INDIAN PENAL CODE", dx: 14 },
          { y: 88, w: 380, label: "CONSTITUTION OF INDIA", dx: 26 },
        ].map((b, i) => (
          <g key={i} transform={`translate(${b.dx} ${b.y})`}>
            <rect x="-6" y="0" width={b.w} height="40" rx="3" fill="#000" opacity="0.4" transform="translate(6 8)" />
            <rect x="0" y="0" width={b.w} height="40" rx="3" fill="url(#law-book)" stroke="#000" strokeWidth="1" />
            <rect x="4" y="5" width={b.w - 8} height="5" rx="2" fill="url(#law-page)" opacity="0.5" />
            <rect x="4" y="30" width={b.w - 8} height="6" rx="2" fill="url(#law-page)" />
            <text x={b.w / 2} y="25" textAnchor="middle" fontFamily="Georgia, serif" fontWeight="700" fontSize="13" letterSpacing="2.5" fill="#b9b4a4">{b.label}</text>
          </g>
        ))}
      </g>

      {/* Gavel + sound block (front-right) */}
      <g transform="translate(405 338) rotate(-16)">
        <rect x="-70" y="22" width="150" height="20" rx="6" fill="#16130d" stroke="#000" />
        <rect x="-40" y="-10" width="70" height="26" rx="10" fill="#2a2620" stroke="#0a0a0a" strokeWidth="1.5" />
        <rect x="-44" y="-12" width="12" height="30" rx="4" fill="#3a352b" />
        <rect x="26" y="-12" width="12" height="30" rx="4" fill="#3a352b" />
        <rect x="-6" y="14" width="10" height="70" rx="5" fill="#241f18" transform="rotate(14)" />
      </g>

      <rect width="560" height="440" fill="url(#law-vign)" />
    </svg>
  );
}

export function SupremeCourtHero({ className = "" }) {
  return (
    <svg viewBox="0 0 560 360" className={className} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="sc-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#242424" />
          <stop offset="55%" stopColor="#141414" />
          <stop offset="100%" stopColor="#070707" />
        </linearGradient>
        <linearGradient id="sc-stone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4a4843" />
          <stop offset="100%" stopColor="#1b1a17" />
        </linearGradient>
        <linearGradient id="sc-dome" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#5a5852" />
          <stop offset="60%" stopColor="#2b2a26" />
          <stop offset="100%" stopColor="#121210" />
        </linearGradient>
        <radialGradient id="sc-vign" cx="55%" cy="40%" r="75%">
          <stop offset="55%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.7" />
        </radialGradient>
      </defs>

      <rect width="560" height="360" fill="url(#sc-sky)" />
      {/* haze */}
      <ellipse cx="300" cy="150" rx="260" ry="120" fill="#3a3a3a" opacity="0.18" />

      {/* Flanking wings */}
      <rect x="40" y="210" width="130" height="150" fill="url(#sc-stone)" />
      <rect x="390" y="210" width="130" height="150" fill="url(#sc-stone)" />
      <g fill="#0d0d0d">
        {Array.from({ length: 5 }).map((_, i) => <rect key={i} x={54 + i * 24} y="224" width="12" height="130" />)}
        {Array.from({ length: 5 }).map((_, i) => <rect key={i} x={404 + i * 24} y="224" width="12" height="130" />)}
      </g>

      {/* Central building */}
      <rect x="170" y="190" width="220" height="170" fill="url(#sc-stone)" />
      {/* pillared portico */}
      <rect x="186" y="236" width="188" height="124" fill="#0f0f0e" />
      <g fill="url(#sc-stone)">
        {Array.from({ length: 7 }).map((_, i) => <rect key={i} x={192 + i * 26} y="236" width="14" height="124" />)}
      </g>
      <rect x="180" y="224" width="200" height="16" fill="url(#sc-stone)" />
      {/* pediment */}
      <path d="M180 224 280 186 380 224Z" fill="url(#sc-stone)" />

      {/* Drum + dome */}
      <rect x="236" y="150" width="88" height="42" rx="3" fill="url(#sc-stone)" />
      <g fill="#111">
        {Array.from({ length: 5 }).map((_, i) => <rect key={i} x={244 + i * 16} y="156" width="7" height="30" />)}
      </g>
      <path d="M232 152c0-52 96-52 96 0Z" fill="url(#sc-dome)" />
      {/* dome ribs */}
      <g stroke="#0a0a0a" strokeWidth="1" opacity="0.5">
        <path d="M280 112v40" /><path d="M258 118c0 18 0 28 0 34" /><path d="M302 118c0 18 0 28 0 34" />
      </g>
      {/* finial */}
      <rect x="277" y="92" width="6" height="22" rx="2" fill="#2a2a28" />
      <circle cx="280" cy="90" r="5" fill="#3a3a36" />

      {/* Flag */}
      <line x1="280" y1="90" x2="280" y2="70" stroke="#2a2a28" strokeWidth="1.5" />
      <path d="M280 72h20v10h-20Z" fill="#555" opacity="0.7" />

      {/* steps */}
      <rect x="150" y="352" width="260" height="8" fill="#1b1a17" />
      <rect x="166" y="344" width="228" height="8" fill="#222019" />

      <rect width="560" height="360" fill="url(#sc-vign)" />
    </svg>
  );
}
