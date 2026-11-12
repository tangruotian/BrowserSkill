import type { RemixiconComponentType } from "@remixicon/react";
import {
  RiBugLine,
  RiHistoryLine,
  RiRecordCircleLine,
  RiScreenshot2Line,
  RiToolsLine,
  RiVideoLine,
} from "@remixicon/react";

export type PopupFeatureId =
  | "page-tools"
  | "record"
  | "video"
  | "long-screenshot"
  | "audit"
  | "debug";

export type PopupView = "main" | "features" | PopupFeatureId;

export type PopupFeature = {
  id: PopupFeatureId;
  icon: RemixiconComponentType;
  titleKey:
    | "pageTools.title"
    | "video.title"
    | "popup.record.sectionTitle"
    | "longScreenshot.title"
    | "audit.title"
    | "debug.title";
  descKey:
    | "pageTools.cardDesc"
    | "video.cardDesc"
    | "popup.record.cardDesc"
    | "longScreenshot.cardDesc"
    | "audit.cardDesc"
    | "debug.cardDesc";
};

export const POPUP_FEATURES: PopupFeature[] = [
  // bkw-ai-saas：页面能力放在首位，便于确认当前 SaaS 是否已向 Agent 声明工具。
  {
    id: "page-tools",
    icon: RiToolsLine,
    titleKey: "pageTools.title",
    descKey: "pageTools.cardDesc",
  },
  { id: "video", icon: RiVideoLine, titleKey: "video.title", descKey: "video.cardDesc" },
  { id: "debug", icon: RiBugLine, titleKey: "debug.title", descKey: "debug.cardDesc" },
  {
    id: "long-screenshot",
    icon: RiScreenshot2Line,
    titleKey: "longScreenshot.title",
    descKey: "longScreenshot.cardDesc",
  },
  {
    id: "record",
    icon: RiRecordCircleLine,
    titleKey: "popup.record.sectionTitle",
    descKey: "popup.record.cardDesc",
  },
  { id: "audit", icon: RiHistoryLine, titleKey: "audit.title", descKey: "audit.cardDesc" },
];
