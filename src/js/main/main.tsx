import { useEffect, useState } from "react";
import { bootstrapKlingEnv, syncProject } from "../core/api";
import "./main.scss";
import { PanelHeader } from "./components/PanelHeader";
import { SettingsPanel } from "./components/SettingsPanel";
import { RecordsFeed } from "./components/RecordsFeed";
import { PromptBar } from "./components/PromptBar";
import { useGenStore } from "./store";
import { subscribeTheme } from "./theme";
import type { GenerationRecord } from "../../shared/types";

export const App = () => {
  const gen = useGenStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    // 主题跟随 Premiere（深/浅色切换时自动重算 CSS 变量）
    subscribeTheme(() => undefined);

    // 面板挂载时同步活动工程 + 载入该工程的生成记录
    void syncProject();
    // 面板挂载时自动跑一次可灵环境自检 —— 不该让用户手动点「重新检测」
    void bootstrapKlingEnv();

    // CEP 没有「工程切换」事件，靠低频轮询发现工程/序列变化
    const timer = setInterval(() => {
      void syncProject();
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // 「↻ 填入生成器」：把记录回填到输入区（不自动提交）
  const fillFromRecord = (rec: GenerationRecord) => {
    gen.fillFromRecord(rec);
    setSettingsOpen(false);
  };

  // 「用作参考」：把已生成的素材加回参考素材区
  // 图片一次生成多张时全部加入（图生图可吃多张参考图）
  const useAsReference = (rec: GenerationRecord) => {
    const isImage = rec.kind === "image";
    const files = rec.workFiles?.length
      ? rec.workFiles
      : rec.workFile
        ? [rec.workFile]
        : [];
    for (const file of files) {
      gen.addRef({
        type: isImage ? "reference_image" : "reference_video",
        localPath: file,
        thumb: "",
        fileName:
          file.split(/[\\/]/).pop() || (isImage ? "参考图" : "参考视频"),
        sizeBytes: 0,
      });
    }
  };

  return (
    <div className="app-root">
      <PanelHeader
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
      />

      {settingsOpen && <SettingsPanel />}

      <RecordsFeed onFill={fillFromRecord} onUseAsReference={useAsReference} />

      <PromptBar gen={gen} />
    </div>
  );
};
