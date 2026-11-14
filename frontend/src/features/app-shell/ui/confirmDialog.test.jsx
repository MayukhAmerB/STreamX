// ConfirmDialog logic (plan §2.5): names the object, requires a reason when
// asked, and passes the trimmed reason on. Carbon's Modal is replaced by a
// thin stand-in so the test runs without a DOM.
import { describe, expect, it, vi } from "vitest";

import { fire, renderTree, textOf } from "../../../test-utils/renderTree";

vi.mock("@carbon/react", () => ({
  Modal: ({ open, modalHeading, primaryButtonText, primaryButtonDisabled, onRequestSubmit, onRequestClose, children }) =>
    open ? (
      <div role="dialog" aria-label={modalHeading}>
        <h2>{modalHeading}</h2>
        {children}
        <button type="button" onClick={onRequestClose}>
          Cancel
        </button>
        <button type="button" disabled={primaryButtonDisabled} onClick={onRequestSubmit}>
          {primaryButtonText}
        </button>
      </div>
    ) : null,
  TextArea: ({ id, labelText, value, onChange, onBlur, invalid, invalidText }) => (
    <label htmlFor={id}>
      {labelText}
      <textarea id={id} value={value} onChange={onChange} onBlur={onBlur} />
      {invalid ? <span>{invalidText}</span> : null}
    </label>
  ),
}));

const { default: ConfirmDialog } = await import("./ConfirmDialog");

describe("ConfirmDialog", () => {
  it("names the object and requires a reason before confirming", async () => {
    const onConfirm = vi.fn();
    const tree = await renderTree(
      <ConfirmDialog open title="Delete this class?" objectName="E2E OBS broadcast" confirmLabel="Delete" danger reason="required" onConfirm={onConfirm} onCancel={() => {}} />
    );
    expect(tree.text()).toContain("‘E2E OBS broadcast’");
    expect(tree.text()).toContain("Reason (required)");
    const deleteButton = () => tree.all((node) => node.type === "button" && textOf(node) === "Delete")[0];
    expect(deleteButton().props.disabled).toBe(true);
    await fire(tree.find((node) => node.type === "textarea"), "onChange", { target: { value: "  Duplicate session " } });
    expect(deleteButton().props.disabled).toBe(false);
    await fire(deleteButton(), "onClick");
    expect(onConfirm).toHaveBeenCalledWith("Duplicate session");
    await tree.unmount();
  });

  it("does not repeat the name when the title already says it, and cancels", async () => {
    const onCancel = vi.fn();
    const tree = await renderTree(<ConfirmDialog open title="Stop ‘Batch IV’?" objectName="Batch IV" confirmLabel="Stop" onConfirm={() => {}} onCancel={onCancel} />);
    expect(tree.text().match(/Batch IV/g)).toHaveLength(1);
    expect(tree.find((node) => node.type === "textarea")).toBeNull();
    await fire(tree.getByLabel("button", "Cancel"), "onClick");
    expect(onCancel).toHaveBeenCalled();
    await tree.unmount();
  });
});
