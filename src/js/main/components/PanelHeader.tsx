import { useState, useSyncExternalStore } from "react";
import {
  getProjectInfo,
  getSequenceInfoSnapshot,
  subscribeGeneration,
  syncProject,
} from "../../core/api";

/**
 * 面板顶栏
 *
 * 对应 RocX（UXP 版）的 `.panel-header`：工程名 + 刷新 + 设置齿轮。
 * 环境自检（CLI 安装 / 登录）收进齿轮打开的设置面板 —— 不占主界面空间。
 */
export const PanelHeader = ({
  settingsOpen,
  onToggleSettings,
}: {
  settingsOpen: boolean;
  onToggleSettings: () => void;
}) => {
  const project = useSyncExternalStore(subscribeGeneration, getProjectInfo);
  const seq = useSyncExternalStore(subscribeGeneration, getSequenceInfoSnapshot);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await syncProject();
    } finally {
      setRefreshing(false);
    }
  };

  const name =
    project.projectName ||
    (project.projectPath
      ? project.projectPath.split(/[\\/]/).pop() || ""
      : "") ||
    "无活动工程";

  return (
    <header className="panel-header">
      <div className="project-info">
        <span className={`project-name${project.projectPath ? "" : " muted"}`}>
          {name}
        </span>
        <button
          className={`icon-btn${refreshing ? " spinning" : ""}`}
          disabled={refreshing}
          onClick={refresh}
          title="重新读取工程信息与生成记录"
        >
          ⟳
        </button>
      </div>
      <div className="header-right">
        {seq.hasSequence && seq.sequenceName && (
          <span className="header-seq" title="当前活动序列">
            {seq.sequenceName}
          </span>
        )}
        <button
          className={`icon-btn${settingsOpen ? " active" : ""}`}
          onClick={onToggleSettings}
          title="设置（可灵环境自检 / CLI 安装 / 登录）"
        >
          ⚙
        </button>
      </div>
    </header>
  );
};
