(function () {
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const NUMBERS = "0123456789";
  const SYMBOLS = "!@#$%^&*";

  function secureRandomInt(maxExclusive) {
    if (!window.crypto || !window.crypto.getRandomValues || maxExclusive <= 0) {
      return Math.floor(Math.random() * maxExclusive);
    }
    const array = new Uint32Array(1);
    const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
    let value = 0;
    do {
      window.crypto.getRandomValues(array);
      value = array[0];
    } while (value >= limit);
    return value % maxExclusive;
  }

  function pickRandom(chars) {
    return chars.charAt(secureRandomInt(chars.length));
  }

  function shuffle(values) {
    for (let i = values.length - 1; i > 0; i -= 1) {
      const j = secureRandomInt(i + 1);
      const temp = values[i];
      values[i] = values[j];
      values[j] = temp;
    }
    return values;
  }

  function generatePassword() {
    const chars = [];
    for (let i = 0; i < 8; i += 1) chars.push(pickRandom(LETTERS));
    for (let i = 0; i < 2; i += 1) chars.push(pickRandom(NUMBERS));
    for (let i = 0; i < 2; i += 1) chars.push(pickRandom(SYMBOLS));
    return shuffle(chars).join("");
  }

  function dispatchInputEvent(node) {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function makeGeneratorUI(passwordField, confirmField) {
    if (!passwordField || passwordField.dataset.generatorAttached === "1") {
      return;
    }
    passwordField.dataset.generatorAttached = "1";

    const wrapper = document.createElement("div");
    wrapper.className = "enterprise-password-generator";

    const generateButton = document.createElement("button");
    generateButton.type = "button";
    generateButton.className = "button enterprise-password-generator-btn";
    generateButton.textContent = "Generate 12-char Password";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "button enterprise-password-generator-copy";
    copyButton.textContent = "Copy";
    copyButton.disabled = true;

    const output = document.createElement("input");
    output.type = "text";
    output.className = "vTextField enterprise-password-generator-output";
    output.placeholder = "Generated password appears here";
    output.readOnly = true;

    const hint = document.createElement("p");
    hint.className = "help enterprise-password-generator-hint";
    hint.textContent = "Rule: 8 letters, 2 numbers, 2 symbols (12 total).";

    generateButton.addEventListener("click", function () {
      const generated = generatePassword();
      passwordField.value = generated;
      dispatchInputEvent(passwordField);
      if (confirmField) {
        confirmField.value = generated;
        dispatchInputEvent(confirmField);
      }
      output.value = generated;
      copyButton.disabled = false;
      hint.textContent = "Generated and applied to password fields.";
    });

    copyButton.addEventListener("click", function () {
      if (!output.value) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(output.value).then(function () {
          hint.textContent = "Password copied to clipboard.";
        });
        return;
      }
      output.focus();
      output.select();
      try {
        document.execCommand("copy");
        hint.textContent = "Password copied to clipboard.";
      } catch (e) {
        hint.textContent = "Copy failed. Please copy manually.";
      }
    });

    wrapper.appendChild(generateButton);
    wrapper.appendChild(copyButton);
    wrapper.appendChild(output);
    wrapper.appendChild(hint);
    passwordField.insertAdjacentElement("afterend", wrapper);
  }

  function initPasswordGenerator() {
    const passwordField = document.getElementById("id_password1");
    const confirmField = document.getElementById("id_password2");
    makeGeneratorUI(passwordField, confirmField);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPasswordGenerator);
  } else {
    initPasswordGenerator();
  }
})();
