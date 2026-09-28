import type { SessionContext } from "@/session-manager/manager";
import type { CdpRunner } from "./shared";

/**
 * 普通 Agent 的页签/文档守卫由 page(guard=true) 签发。代理按一次工具调用冻结守卫，
 * 不影响 Pipeline 自己的文档回执协议。每次可能改变页面的 CDP 命令前重读根文档，
 * 关闭 Agent 进程检查与真正输入之间的主要竞态窗口；变化后绝不将输入送往新文档。
 * 清理命令不受阻，确保 focus emulation 与 CDP 对象仍可以释放。
 */
export function guardedCdp<T extends CdpRunner>(cdp: T, ctx: SessionContext | null): T {
  const guard = ctx?.browserGuard;
  if (!guard) return cdp;
  const heldInputs = new Set<string>();
  const check = async (tabId: number, method: string, params?: object) => {
    if (
      !/^(Input\.|DOM\.setFileInputFiles|Page\.navigate|Runtime\.(evaluate|callFunctionOn))/.test(
        method,
      )
    )
      return;
    if (tabId !== guard.tabId) throw new Error("浏览器守卫拒绝跨页签操作");
    const input = params as
      | { type?: string; button?: string; key?: string; code?: string }
      | undefined;
    const key =
      method === "Input.dispatchMouseEvent"
        ? `mouse:${input?.button}`
        : `key:${input?.code ?? input?.key}`;
    // 本工具已经按下的键/鼠标必须允许释放，即使按下触发了导航；不能遗留系统按键。
    // 无对应按下记录的释放仍正常校验，避免把任意新页面事件伪装成清理。
    if ((input?.type === "mouseReleased" || input?.type === "keyUp") && heldInputs.delete(key))
      return;
    const attachment = cdp.getAttachmentId?.(tabId);
    if (guard.attachmentId && attachment !== guard.attachmentId)
      throw new Error("浏览器连接已变化，请重新观察");
    const document = await cdp.send<{ root: { backendNodeId: number } }>(tabId, "DOM.getDocument", {
      depth: 0,
    });
    if (document.root.backendNodeId !== guard.documentEpoch)
      throw new Error("页面文档已变化，请重新观察");
    if (input?.type === "mousePressed" || input?.type === "keyDown" || input?.type === "rawKeyDown")
      heldInputs.add(key);
  };
  return new Proxy(cdp, {
    get(target, property) {
      if (property === "send")
        return async <R>(tabId: number, method: string, params?: object): Promise<R> => {
          await check(tabId, method, params);
          return target.send<R>(tabId, method, params);
        };
      if (property === "sendToTarget" && target.sendToTarget)
        return async <R>(
          destination: Parameters<NonNullable<CdpRunner["sendToTarget"]>>[0],
          method: string,
          params?: object,
        ): Promise<R> => {
          await check(destination.tabId, method, params);
          return target.sendToTarget!<R>(destination, method, params);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
