// "Verify a certificate": type a reference number, get its page. OWNER: WS-CERTIFICATES.
// The check character is validated here first, so a typo is explained at once
// and never costs a (rate-limited) lookup.
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";

import { REFERENCE_EXAMPLE, REFERENCE_PROBLEMS, parseReference } from "./reference";

export default function VerifyCertificateForm({ initialValue = "", heading = "Verify a certificate", headingLevel = 2 }) {
  const navigate = useNavigate();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialValue);
  const [problem, setProblem] = useState("");
  const Heading = `h${headingLevel}`;

  const onSubmit = (event) => {
    event.preventDefault();
    const parsed = parseReference(value);
    if (!parsed.ok) {
      setProblem(REFERENCE_PROBLEMS[parsed.reason] || REFERENCE_PROBLEMS.format);
      return;
    }
    setProblem("");
    navigate(`/certificates/${parsed.reference}`);
  };

  return (
    <form className="cv-verify" onSubmit={onSubmit} noValidate aria-labelledby={`${inputId}-heading`}>
      <Heading id={`${inputId}-heading`} className="cv-verify__title">
        {heading}
      </Heading>
      <p className="cv-verify__hint" id={hintId}>
        Enter the reference number printed at the bottom of the certificate, for example <span className="cv-mono">{REFERENCE_EXAMPLE}</span>.
      </p>
      <div className="cv-verify__row">
        <label className="cv-verify__label" htmlFor={inputId}>
          Reference number
        </label>
        <input
          id={inputId}
          name="reference"
          className="cv-verify__input cv-mono"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          placeholder={REFERENCE_EXAMPLE}
          value={value}
          aria-invalid={problem ? "true" : undefined}
          aria-describedby={problem ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => {
            setValue(event.target.value);
            if (problem) setProblem("");
          }}
        />
        <button className="cv-button cv-button--primary" type="submit">
          Verify
        </button>
      </div>
      <p className="cv-verify__error" id={errorId} role="alert">
        {problem}
      </p>
    </form>
  );
}
