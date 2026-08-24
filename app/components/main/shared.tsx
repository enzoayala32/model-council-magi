import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RunModel } from "../../lib/client-types";

export function ModelBadge({ model, small = false }: { model: RunModel; small?: boolean }) {
  return (
    <span
      className={`${small ? "modelBadge small" : "modelBadge"}${model.logoUrl ? "" : " noLogo"}`}
      style={{ "--badge-color": model.accent } as React.CSSProperties}
      aria-label={`${model.maker} logo`}
    >
      {model.logoUrl ? <img src={model.logoUrl} alt="" aria-hidden="true" /> : model.badge}
    </span>
  );
}

export function MarkdownLite({ content }: { content: string }) {
  return (
    <div className="markdownLite">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}


