// The certificate, drawn in HTML from the same layout as the PDF. OWNER: WS-CERTIFICATES.
// certificateLayout.json is an exact copy of backend/apps/engagement/certificate_layout.json
// (a test compares them) and `print` comes from the API: every printed string and the
// font sizes after fitting, measured by the server with the same IBM Plex fonts. One
// layout unit is a thousandth of the certificate's width (CSS container units).
import LAYOUT from "./certificateLayout.json";

const colour = (name) => LAYOUT.colors[name] || name;
const unit = (value) => `calc(var(--cv-u) * ${Number(value)})`;
const FONT_CLASS = {
  serif: "cv-f-serif",
  "serif-italic": "cv-f-serif cv-f-italic",
  "serif-semibold": "cv-f-serif cv-f-semibold",
  sans: "cv-f-sans",
  "sans-semibold": "cv-f-sans cv-f-semibold",
};

function Text({ name, value, size }) {
  const spec = LAYOUT.text[name];
  if (!spec || !value) return null;
  const tracking = Number(spec.tracking || 0);
  return (
    <span
      className={`cv-art__text ${FONT_CLASS[spec.font] || ""}`}
      data-part={name}
      style={{
        left: unit(spec.x),
        top: unit(spec.y),
        fontSize: unit(size ?? spec.size),
        color: colour(spec.color),
        letterSpacing: tracking ? `${tracking}em` : undefined,
        // Letter spacing also follows the last letter; this keeps the line centred.
        paddingLeft: tracking ? `${tracking}em` : undefined,
        maxWidth: spec.maxWidth ? unit(spec.maxWidth + 40) : undefined,
      }}
    >
      {value}
    </span>
  );
}

function Rule({ spec }) {
  const width = spec.x2 - spec.x1;
  return (
    <>
      <span
        className="cv-art__rule"
        style={{ left: unit(spec.x1), top: unit(spec.y), width: unit(width), height: unit(spec.stroke), background: colour(spec.color) }}
      />
      {spec.diamond ? <Diamond cx={(spec.x1 + spec.x2) / 2} cy={spec.y} half={spec.diamond} color={spec.color} /> : null}
    </>
  );
}

function Diamond({ cx, cy, half, color }) {
  const side = half * Math.SQRT2;
  return <span className="cv-art__diamond" style={{ left: unit(cx), top: unit(cy), width: unit(side), height: unit(side), background: colour(color) }} />;
}

function Ring({ cx, cy, r, stroke, color }) {
  return (
    <span
      className="cv-art__ring"
      style={{ left: unit(cx), top: unit(cy), width: unit(2 * r), height: unit(2 * r), borderWidth: unit(stroke), borderColor: colour(color) }}
    />
  );
}

/** Monochrome QR code from the API (`{ modules, quiet, path, url }`), drawn exactly where the PDF has it. */
function QrCode({ qr }) {
  const spec = LAYOUT.qr;
  if (!spec || !qr?.path || !qr.modules) return null;
  const quiet = Number(qr.quiet ?? spec.quiet);
  const box = Number(qr.modules) + 2 * quiet;
  return (
    <svg
      className="cv-art__qr"
      data-part="qr"
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code linking to ${qr.url || "this certificate"}`}
      style={{ left: unit(spec.cx), top: unit(spec.cy), width: unit(spec.size), height: unit(spec.size), background: colour(spec.background) }}
    >
      <path d={qr.path} fill={colour(spec.color)} />
    </svg>
  );
}

/**
 * `print`: `{ texts, sizes, stamp }` from GET /api/engagement/certificates/<ref>/; `qr` its QR code.
 * The artwork is decorative structure plus real text, so it can be read, selected
 * and printed (A4 landscape) like the PDF.
 */
export default function CertificateArtwork({ print, qr, label }) {
  const texts = print?.texts || {};
  const sizes = print?.sizes || {};
  const { panel, frame, seal, stamp } = LAYOUT;
  return (
    <figure className="cv-art" aria-label={label} style={{ background: colour("paper") }}>
      <span className="cv-art__panel" style={{ left: unit(panel.x), width: unit(panel.width), background: colour(panel.color) }} />
      <span
        className="cv-art__frame"
        style={{ inset: unit(frame.inset), borderWidth: unit(frame.stroke), borderColor: colour(frame.color) }}
      />
      {Object.entries(LAYOUT.rules).map(([name, spec]) => (
        <Rule key={name} spec={spec} />
      ))}
      <Ring cx={seal.cx} cy={seal.cy} r={seal.r} stroke={seal.stroke} color={seal.color} />
      <Ring cx={seal.cx} cy={seal.cy} r={seal.innerR} stroke={seal.innerStroke} color={seal.innerColor} />
      <Diamond cx={seal.cx} cy={seal.cy} half={seal.diamond} color={seal.color} />
      <QrCode qr={qr} />
      {Object.keys(LAYOUT.text).map((name) => (
        <Text key={name} name={name} value={texts[name]} size={sizes[name]} />
      ))}
      {print?.stamp ? (
        <span
          className="cv-art__stamp cv-f-serif cv-f-semibold"
          data-part="stamp"
          style={{
            left: unit(stamp.x),
            top: unit(stamp.y),
            fontSize: unit(stamp.size),
            color: colour(stamp.color),
            borderWidth: unit(stamp.stroke),
            borderColor: colour(stamp.color),
            padding: `${unit(stamp.padY)} ${unit(stamp.padX)}`,
            transform: `translate(-50%, -50%) rotate(${stamp.angle}deg)`,
          }}
        >
          {print.stamp}
        </span>
      ) : null}
    </figure>
  );
}
