import type { RequestFrame, ResponseFrame } from "@/transport/types";

/** Chrome 的检查状态不是安装回执；只有重新握手的实际版本能确认升级生效。 */
export interface UpdateCheckResult {
  status: "no_update" | "throttled" | "update_available";
  version?: string;
}

/** 可注入 Chrome API，以测试下载事件先于检查回调、断连及重复通知等边界。 */
export interface ExtensionUpdateRuntime {
  requestUpdateCheck(): Promise<UpdateCheckResult>;
  reload(): void;
  onUpdateAvailable: {
    addListener(listener: (details: { version: string }) => void): void;
    removeListener(listener: (details: { version: string }) => void): void;
  };
}

/**
 * 统一发布允许打断正在执行的任务：收到 Chrome 的可用更新事件就直接重载，
 * 不读取 SessionManager、不等待录制结束、不关闭浏览器或清理业务页签。
 * 普通后台周期检查下载新版也走同一事件，因此不会继续被心跳保活阻塞应用。
 */
export class ExtensionUpdater {
  private checking: Promise<UpdateCheckResult> | null = null;
  private reloadScheduled = false;
  private readonly onAvailable = () => this.reloadNow();

  constructor(private readonly runtime: ExtensionUpdateRuntime = chrome.runtime) {
    // 必须在后台初始化时同步注册，不能等到建立 daemon 连接后才监听 MV3 事件。
    runtime.onUpdateAvailable.addListener(this.onAvailable);
  }

  private reloadNow(): void {
    if (this.reloadScheduled) return;
    this.reloadScheduled = true;
    this.runtime.reload();
  }

  /**
   * 只在已认证/允许的现有 daemon 传输上调用，不暴露网页消息或任意代码执行入口。
   * 并发通知共享一次 Chrome 检查，避免主动制造 throttled；不做高频重试。
   * 事件可以抢先重载导致回执丢失，daemon 必须按新连接版本核验，不能盲目重发。
   */
  async handle(request: RequestFrame, send: (reply: ResponseFrame) => void): Promise<void> {
    try {
      if (!this.checking) {
        this.checking = this.runtime.requestUpdateCheck().finally(() => {
          this.checking = null;
        });
      }
      const result = await this.checking;
      try {
        send({ id: request.id, result });
      } finally {
        // 回调已确认下载可用时即应用；让回执先入传输队列，不等待任务空闲。
        // onUpdateAvailable 若先到达则已直接 reload，不会重复执行。
        if (result.status === "update_available") this.reloadNow();
      }
    } catch (error) {
      try {
        send({ id: request.id, error: { code: "protocol_error", message: String(error) } });
      } catch {
        // 已重载或连接断开时不再发送；发布端通过重连验证，超时按结果未知处理。
      }
    }
  }

  /** 仅用于测试或显式销毁后台依赖；正常更新由 Chrome 终止旧 worker。 */
  dispose(): void {
    this.runtime.onUpdateAvailable.removeListener(this.onAvailable);
  }
}
