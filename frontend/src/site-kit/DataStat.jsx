import { cx } from "./utils";

/**
 * Key figures as a description list: each item is a <div> holding <dt>
 * (label) then <dd> (value); CSS shows the value first. 4-up at lg, 2-up at
 * md, stacked on phones.
 *
 * items: [{ label, value, note? }]
 */
export default function DataStat({ items = [], className, ...rest }) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item && item.label);
  if (rows.length === 0) return null;
  return (
    <dl className={cx("sk-datastat", className)} {...rest}>
      {rows.map((item) => (
        <div key={item.label} className="sk-datastat__item">
          <dt className="sk-datastat__label">{item.label}</dt>
          <dd className="sk-datastat__value">{item.value}</dd>
          {item.note ? <dd className="sk-datastat__note">{item.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
