import { useTranslation } from "@browser-skill/i18n/react";
import { Badge, Button } from "@browser-skill/ui";
import { RiLoader4Line, RiRefreshLine, RiShieldCheckLine } from "@remixicon/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type InspectResult, inspectActiveTab } from "@/page-tools/client";
import type { PageToolInfo, PageToolsReport } from "@/page-tools/detect";

const KINDS = ["query", "ui", "draft", "submit"] as const;
type Kind = (typeof KINDS)[number];
const isKind = (value: string | undefined): value is Kind => KINDS.includes(value as Kind);

/**
 * bkw-ai-saas：弹窗“页面能力”。打开面板或点击重新检测时只读检测一次当前标签页：
 * 是否接入本项目 SDK、浏览器 WebMCP，以及 Agent 实际会走的调用通道。不调用任何工具。
 */
export function PageToolsPanel() {
  const { t } = useTranslation("extension");
  const [result, setResult] = useState<InspectResult | null>(null);
  const [pending, setPending] = useState(true);
  const mounted = useRef(true);

  const detect = useCallback(async () => {
    setPending(true);
    try {
      const next = await inspectActiveTab();
      if (mounted.current) setResult(next);
    } catch {
      if (mounted.current) setResult({ ok: false, error: "failed" });
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void detect();
    return () => {
      mounted.current = false;
    };
  }, [detect]);

  const report = result?.ok ? result.report : null;
  return (
    <section className="space-y-3" data-slot="popup-page-tools">
      <p className="text-xs leading-relaxed text-muted-foreground">{t("pageTools.description")}</p>
      {pending && !result && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <RiLoader4Line className="size-4 animate-spin" aria-hidden />
          {t("pageTools.detecting")}
        </p>
      )}
      {result && !result.ok && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
          {t(`pageTools.errors.${result.error}`)}
        </p>
      )}
      {report && <ReportView report={report} />}
      <Button
        className="w-full"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void detect()}
        data-slot="page-tools-refresh"
      >
        <RiRefreshLine className={pending ? "size-4 animate-spin" : "size-4"} aria-hidden />
        {t(pending ? "pageTools.detecting" : "pageTools.refresh")}
      </Button>
      <p className="flex gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <RiShieldCheckLine className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {t("pageTools.scope")}
      </p>
    </section>
  );
}

function ReportView({ report }: { report: PageToolsReport }) {
  const { t } = useTranslation("extension");
  const { sdk, webmcp } = report;
  return (
    <>
      <div
        className="space-y-1 rounded-xl border border-border/80 bg-card/60 p-3"
        data-slot="page-tools-channel"
        data-channel={report.agentChannel}
      >
        <p className="text-[11px] text-muted-foreground">{t("pageTools.channel.label")}</p>
        <p className="text-sm font-medium">{t(`pageTools.channel.${report.agentChannel}`)}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(`pageTools.channelHint.${report.agentChannel}`)}
        </p>
        {!report.secure && (
          <p role="status" className="text-[11px] leading-relaxed text-destructive">
            {t("pageTools.insecure")}
          </p>
        )}
        <p className="break-all text-[11px] text-muted-foreground/80">{report.url}</p>
      </div>

      {sdk && (
        <div
          className="space-y-2 rounded-xl border border-border/80 bg-card/60 p-3"
          data-slot="page-tools-sdk"
        >
          <h2 className="text-sm font-medium">{t("pageTools.sdk.title")}</h2>
          {sdk.status === "incompatible" && (
            <p className="text-xs text-muted-foreground">
              {t("pageTools.sdk.incompatible", { version: sdk.version })}
            </p>
          )}
          {sdk.status === "error" && (
            <p role="alert" className="break-words text-xs text-destructive">
              {t("pageTools.sdk.error", { message: sdk.message })}
            </p>
          )}
          {sdk.status === "ok" && (
            <>
              <div>
                <p className="truncate text-xs font-medium">{sdk.app.name || sdk.app.id}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {[sdk.app.id, sdk.app.contractVersion].filter(Boolean).join(" · ")}
                </p>
              </div>
              {sdk.instructions ? (
                <details className="rounded-md border border-border/70 px-2 py-1.5">
                  <summary className="cursor-pointer text-xs font-medium">
                    {t("pageTools.sdk.instructions")}
                  </summary>
                  <p
                    className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/85"
                    data-slot="page-tools-instructions"
                  >
                    {sdk.instructions}
                  </p>
                </details>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {t("pageTools.sdk.noInstructions")}
                </p>
              )}
              <ToolList tools={sdk.tools} truncated={sdk.truncated} />
            </>
          )}
        </div>
      )}

      {webmcp && (
        <div
          className="space-y-2 rounded-xl border border-border/80 bg-card/60 p-3"
          data-slot="page-tools-webmcp"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{t("pageTools.webmcp.title")}</h2>
            <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
              {webmcp.api === "document" ? "document.modelContext" : "navigator"}
            </Badge>
          </div>
          {webmcp.error ? (
            <p role="alert" className="break-words text-xs text-destructive">
              {t("pageTools.webmcp.error", { message: webmcp.error })}
            </p>
          ) : webmcp.tools ? (
            <ToolList tools={webmcp.tools} truncated={webmcp.truncated} />
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("pageTools.webmcp.unlisted")}
            </p>
          )}
        </div>
      )}

      {!sdk && !webmcp && (
        <p className="text-xs leading-relaxed text-muted-foreground" data-slot="page-tools-none">
          {t("pageTools.none")}
        </p>
      )}
    </>
  );
}

function ToolList({ tools, truncated }: { tools: PageToolInfo[]; truncated: boolean }) {
  const { t } = useTranslation("extension");
  if (!tools.length)
    return <p className="text-xs text-muted-foreground">{t("pageTools.noTools")}</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium">{t("pageTools.tools", { count: tools.length })}</p>
      <ul className="space-y-1.5" data-slot="page-tools-list">
        {tools.map((tool, index) => (
          <li
            key={`${index}-${tool.name}`}
            className="rounded-md border border-border/70 px-2 py-1.5"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <code className="min-w-0 truncate font-mono text-[11px] text-foreground">
                {tool.name}
              </code>
              {tool.kind && (
                <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                  {isKind(tool.kind) ? t(`pageTools.kind.${tool.kind}`) : tool.kind}
                </Badge>
              )}
              {tool.available === false && (
                <Badge
                  variant="outline"
                  className="shrink-0 border-destructive/40 px-1 py-0 text-[10px] text-destructive"
                >
                  {t("pageTools.unavailable")}
                </Badge>
              )}
            </div>
            {tool.description && (
              <p
                className="mt-0.5 line-clamp-2 break-words text-[11px] leading-snug text-muted-foreground"
                title={tool.description}
              >
                {tool.description}
              </p>
            )}
            {tool.unavailableReason && (
              <p className="mt-0.5 break-words text-[11px] text-destructive">
                {tool.unavailableReason}
              </p>
            )}
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="text-[11px] text-muted-foreground">
          {t("pageTools.truncated", { count: tools.length })}
        </p>
      )}
    </div>
  );
}
