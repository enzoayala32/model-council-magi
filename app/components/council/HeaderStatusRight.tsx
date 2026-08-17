/**
 * HeaderStatusRight — top-right framed title with status lines below.
 * `title` is the big underlined word (e.g. "DELIBERATION"). `lines`
 * are short status rows underneath (e.g. current phase, current
 * activity) — both driven by real council state from the caller.
 */
export function HeaderStatusRight({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="magiHeaderRight">
      <span className="magiHeaderRightTitle">{title}</span>
      {lines.map((line, index) => (
        <span className="magiHeaderRightLine" key={index}>
          {line}
        </span>
      ))}
    </div>
  );
}
