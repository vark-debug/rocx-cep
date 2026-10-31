/**
 * 跨层共享类型（Panel ↔ Node ↔ Host）
 *
 * 分层约定见 docs/CEP-AI开发提示词.md 第 5 节：
 *   - Panel（src/js/main）只渲染与收集意图，不碰文件系统 / 网络
 *   - Node （src/js/core）负责 fs / child_process / https / provider
 *   - Host  （src/jsx）只做 Premiere DOM 操作，薄入口
 *
 * 本文件只放**类型**，不放实现，也不被 host 层（ES3）引用，
 * 以免把现代语法带入 ExtendScript。
 */

// ---------- 可灵 CLI ----------

/** 可灵 CLI 调用结果码（与 Node 层错误分类一一对应） */
export type KlingCliCode =
  | "ok"
  | "node_not_found"
  | "cli_not_installed"
  | "not_logged_in"
  | "bad_output"
  | "timeout"
  | "command_failed";

/** CLI 调用结果 */
export interface KlingCliExecResult {
  ok: boolean;
  code: KlingCliCode;
  /** 成功时的 envelope.body */
  data?: unknown;
  /** 失败时的人话错误 */
  error?: string;
  /** 原始 stdout，便于排障 */
  raw?: string;
}

/** CLI 优先级：后台预上传可被前台请求插队 */
export type KlingCliPriority = "foreground" | "background";

/** 可灵区域（决定安装哪个 npm 包） */
export type KlingRegion = "cn" | "global";

/** 单个视频模型的可选参数值域（来自 who_am_i 的 availableModels） */
export interface KlingModelDescriptor {
  modelId: string;
  displayName: string;
  description?: string;
  /** 时长（秒），已排序 */
  durations: number[];
  /** 画幅比例 */
  ratios: string[];
  /** 分辨率 */
  resolutions: string[];
  /** 是否支持参考图 */
  imageInput: boolean;
  /** 是否支持参考视频 */
  videoInput: boolean;
}

/**
 * 单个图片模型的可选参数值域（来自 who_am_i 的 availableModels）
 *
 * 与视频模型的参数域**完全不同**（实测 2026-10）：
 *   - 分辨率档位参数叫 `img_resolution`（"1k"/"2k"/"4k"，全小写），
 *     视频侧是 `resolution`（"720p"/"1080p"）
 *   - 多一个 `imageCount`（张数），没有 `duration`
 */
export interface KlingImageModelDescriptor {
  modelId: string;
  displayName: string;
  description?: string;
  /** 画幅比例（可能含 "auto"） */
  ratios: string[];
  /** img_resolution 值域（"1k" / "2k" / "4k"） */
  resolutions: string[];
  /** imageCount 值域（"1" ~ "9"） */
  counts: string[];
  /** 是否支持参考图（图生图） */
  imageInput: boolean;
  /**
   * 平台默认 img_resolution（"1k" / "2k" / "4k"）。
   *
   * 取默认模型声明的默认值 —— 各模型自己的默认值并不一致
   * （实测 o3 声明 2k、v3_0 声明 1k），按模型各自的默认值会让
   * 「平台默认值」随模型漂移。
   */
  defaultResolution?: string;
  /** 平台默认画幅（"auto" / "16:9" …） */
  defaultRatio?: string;
}

/** 可灵环境自检结果 */
export interface KlingEnvState {
  /** 环境是否可用（CLI 已装 + 已登录 + 模型清单拉到） */
  ready: boolean;
  /** 自检进行中（面板打开时自动跑一次，避免用户误以为没检测） */
  checking?: boolean;
  /** 未就绪原因 */
  reason?: "cli_not_installed" | "not_logged_in" | "error";
  /** 人话提示 */
  message?: string;
  /** 灵感值余额 */
  credits?: number;
  /** 会员类型（如 SVIP） */
  membershipType?: string;
  /** 会员类型描述（如「铂金会员」） */
  membershipDescription?: string;
  /** 可用模型数 */
  modelCount?: number;
  /** 服务端下发的充值链接（不硬编码） */
  rechargeUrl?: string;
  /** 上次自检时间（ISO） */
  checkedAt?: string;
}

/** 生成任务状态 */
export type KlingTaskStatus = "queued" | "running" | "succeeded" | "failed";

/** 参考素材类型 */
export type KlingReferenceType =
  | "reference_image"
  | "reference_video"
  | "reference_audio";

/** 一条参考素材 */
export interface KlingReferenceInput {
  type: KlingReferenceType;
  /** 本地绝对路径（抓帧产物 / 已下载素材） */
  localPath: string;
  /** 预上传拿到的可灵 CDN 直链（有值且未过期时优先于 localPath） */
  klingFileUrl?: string;
  /** 直链获取时刻（ISO） */
  klingUploadedAt?: string;
  /** 外部 URL（http/https 直传，不下载重传） */
  fileId?: string;
}

/** 视频生成请求 */
export interface KlingVideoRequest {
  /** 目标模型 id（来自 who_am_i 的清单） */
  model: string;
  prompt: string;
  /** 画幅比例，如 "16:9" */
  ratio: string;
  /** 时长（秒） */
  duration: number;
  /** 分辨率，如 "1080p" */
  resolution: string;
  /** 参考素材（图片 / 视频 / 音频） */
  references?: KlingReferenceInput[];
}

/**
 * 图片生成请求
 *
 * ⚠ 参数域与视频侧完全不同（实测 2026-10 的 who_am_i 声明）：
 *   - resolution 是 `img_resolution` 的值（"1k" / "2k" / "4k"，**全小写**）
 *   - 有 count（张数），没有 duration
 */
export interface KlingImageRequest {
  /** 目标模型 id（来自 who_am_i 的图片工具清单） */
  model: string;
  prompt: string;
  /** 画幅比例，如 "16:9"（部分模型支持 "auto"） */
  ratio: string;
  /** img_resolution 档位："1k" / "2k" / "4k" */
  resolution: string;
  /** 生成张数 */
  count: number;
  /** 参考图（仅图片参与，视频参考在图片模式下忽略） */
  references?: KlingReferenceInput[];
}

/** 生成提交结果 */
export interface KlingSubmitResult {
  taskId: string;
  /** 本次实扣灵感值 */
  creditsConsumed?: number;
  traceId: string;
}

/** 生成查询结果 */
export interface KlingQueryResult {
  status: KlingTaskStatus;
  /** 结果地址（视频/图片 URL） */
  url?: string;
  /**
   * 多个结果地址（图片按 imageCount 生成多张时用）。
   *
   * 实测 imageCount=3 → works[] 有 3 个条目。
   * 视频恒为 1 张，不填这个字段。
   */
  urls?: string[];
  /** 失败原因 */
  error?: string;
  creditsConsumed?: number;
}

// ---------- Host 层（Premiere） ----------

/** 活动工程 / 序列信息 */
export interface SequenceInfo {
  ok: boolean;
  error?: string;
  /** host 脚本版本标记（改 host 层后需重启 Premiere 才生效） */
  hostApi?: number;
  /** 工程文件绝对路径（未保存时为空） */
  projectPath?: string;
  /** 工程名 */
  projectName?: string;
  hasSequence: boolean;
  sequenceName?: string;
  sequenceId?: string;
  /** 入点（ticks 字符串） */
  inPointTicks?: string;
  /** 出点（ticks 字符串） */
  outPointTicks?: string;
  inPointSeconds?: number;
  outPointSeconds?: number;
  /** 序列画面尺寸 */
  width?: number;
  height?: number;
  /** 帧率（真实 fps；host 层已处理 ExtendScript 的 1/fps 陷阱） */
  fps?: number;
  videoTrackCount?: number;
  audioTrackCount?: number;
  /** 播放头位置 */
  playerPositionSeconds?: number;
}

/** 导入工程的结果项 */
export interface ImportedItem {
  name: string;
  nodeId: string;
  /** 媒体文件绝对路径 */
  mediaPath?: string;
}

/** importFiles 返回 */
export interface ImportFilesResult {
  ok: boolean;
  error?: string;
  items: ImportedItem[];
}

/** 抓帧参数 */
export interface ExportFrameArgs {
  /** 目标帧号（相对序列起点）；给了就用它，其余字段忽略 */
  frameNumber?: number;
  /** 目标时间点（ticks 字符串，254016000000 ticks = 1 秒）；留空取当前播放头 */
  ticks?: string;
  /** 目标时间点（秒）；与 ticks 二选一 */
  seconds?: number;
  /** 输出路径绝对路径（**不要带扩展名**，Premiere 会自己补 .png） */
  outputPath: string;
}

/** 抓帧结果 */
export interface ExportFrameResult {
  ok: boolean;
  error?: string;
  /** 实际写出的文件路径（host 回传的 fsName） */
  path?: string;
  /** 实际导出的帧号（相对序列起点） */
  frameNumber?: number;
  /** 序列画幅宽（面板用于「首次抓帧自动填画幅比」） */
  width?: number;
  /** 序列画幅高 */
  height?: number;
  /** 实际送进 exportFramePNG 的参数（按序列当前显示格式格式化：画框模式=帧号，时间码模式=时码） */
  frameArg?: string;
  /** 参照用的时码（不送出，仅显示） */
  timecode?: string;
  /** 诊断：QE 侧序列名 */
  qeSeqName?: string;
  /** 诊断：DOM 侧活动序列名 */
  domSeqName?: string;
  /** 诊断：QE 的 CTI 时码 */
  qeTimecode?: string;
  /** 诊断：QE 的 CTI 帧号 */
  qeFrames?: number;
  /** 诊断：QE 的 CTI 秒数 */
  qeSecs?: number;
  /** 诊断：CTI 是否与 UI 播放头同步 */
  ctiSynced?: boolean;
  /** 诊断：导出后 CTI 的帧号（若被重置成 0，说明导出的是它自己设定的位置） */
  ctiAfterFrames?: number;
  /** 诊断：DOM 播放头秒数 */
  domSecs?: number;
  /** 诊断：真实帧率 */
  fps?: number;
  /** 诊断：序列的时间显示格式（影响 CTI.timecode 的形态） */
  domVideoDisplayFormat?: number;
  /** 诊断：QE 序列入点时码 */
  qeInTimecode?: string;
  /** 诊断：QE 序列入点帧号 */
  qeInFrames?: number;
  /** 诊断：QE 序列出点时码 */
  qeOutTimecode?: string;
  /** 诊断：QE 序列出点帧号 */
  qeOutFrames?: number;
  /** 诊断：序列总帧数 */
  qeTotalFrames?: string;
}

/**
 * 抓视频（按序列入出点导出片段）参数。
 *
 * 走 `sequence.exportAsMediaDirect(outputPath, presetPath, 1)`：
 * Premiere 内置导出管线，**不依赖 AME**；第三参 1 = ENCODE_IN_TO_OUT。
 */
export interface ExportSequenceClipArgs {
  /** 输出文件绝对路径（含 .mp4） */
  outputPath: string;
  /** 导出预设（.epr）绝对路径 */
  eprPath: string;
}

/** 抓视频结果 */
export interface ExportSequenceClipResult {
  ok: boolean;
  error?: string;
  /** 实际写出的文件路径（host 回传的 fsName） */
  path?: string;
  /** 入出点片段时长（秒） */
  durationSeconds?: number;
  /** 序列画幅宽（面板用于「首次抓视频自动填画幅比」） */
  width?: number;
  /** 序列画幅高 */
  height?: number;
}

// ---------- 生成记录 ----------

/**
 * 记录状态。
 *
 * 与 RocX（UXP 版）保持同名同义：
 *   pending   等待中（含「准备素材」「提交中」两段，见 pendingStage）
 *   generating 生成中
 *   generated 已生成（结果已落盘，尚未导入工程）
 *   imported  已导入工程
 *   failed    失败
 */
export type GenerationRecordStatus =
  | "pending"
  | "generating"
  | "generated"
  | "imported"
  | "failed";

/** 记录里的生成参数（对齐 RocX 的 params 嵌套结构） */
export interface GenerationParams {
  /** provider id，目前只有 kling */
  provider: string;
  model: string;
  /** 画幅比例，如 "16:9" */
  ratio: string;
  /** 时长（秒）；图片记录固定为 0 */
  duration: number;
  /** 分辨率，如 "1080p"；图片记录是 "1k" / "2k" / "4k" */
  resolution: string;
  /** 目标工具：text_to_video / image_to_video / omni_ref_video / text_to_image / image_to_image */
  tool: string;
  /** 图片生成张数（视频记录为空） */
  count?: number;
}

/**
 * 记录类型。
 *
 * 缺省按视频处理 —— 老记录里没有这个字段。
 */
export type GenerationKind = "video" | "image";

/**
 * 记录里的参考素材（对齐 RocX 的 ReferenceItem）。
 *
 * 注意：这里的 `localPath` 是**落盘的原始路径**，
 * 不是可灵 CDN 直链 —— 直链只用于提交时加速，有 TTL，不适合长期存档。
 */
export interface GenerationReference {
  type: KlingReferenceType;
  /** 本地绝对路径 */
  localPath: string;
  /** 文件名（列表显示用） */
  fileName: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 缩略图（data URL，写盘时剥离） */
  thumbDataUrl?: string;
}

/** 记录里的错误信息（对齐 RocX 的 error 结构） */
export interface GenerationError {
  message: string;
  /** 错误分类（来自 errorMap 的归类，如 insufficient_credits） */
  errorType?: string;
}

/** 单条生成记录 */
export interface GenerationRecord {
  id: string;
  /** 记录类型（缺省 video，兼容老记录） */
  kind?: GenerationKind;
  /** 提示词 */
  prompt: string;
  /** 生成参数 */
  params: GenerationParams;
  /** 参考素材 */
  references: GenerationReference[];
  status: GenerationRecordStatus;
  /**
   * pending 阶段的细分（仅 status === "pending" 时有意义）。
   *
   * pending 里其实包含两段完全不同的等待：
   * 准备素材（素材预上传）与提交任务（CLI 提交命令）。
   * 拆开显示后用户能看出到底卡在哪一步。
   */
  pendingStage?: "preparing" | "submitting";
  /** 可灵任务 id */
  taskId?: string;
  /** 同一次任务复用的 trace id */
  traceId?: string;
  /** 生成结果远端地址 */
  resultUrl?: string;
  /**
   * 已下载到本地的结果文件（图片一次生成多张时是多个）。
   *
   * ⚠ workFile 仍是**第一张**（预览 / 用作参考用），workFiles 是全量。
   */
  workFiles?: string[];
  /** 已下载到本地的结果文件 */
  workFile?: string;
  /** 已导入工程的素材路径 */
  importedFile?: string;
  /** 缩略图（data URL，写盘时剥离） */
  thumbDataUrl?: string;
  /** 实扣灵感值 */
  creditsConsumed?: number;
  /** 失败信息 */
  error?: GenerationError;
  /** 任务首次提交时刻 */
  submittedAt?: string;
  /** 最后一次轮询时刻 */
  lastPolledAt?: string;
  /** 创建时刻 */
  createdAt: string;
  /** 更新时刻 */
  updatedAt: string;
  /** 归属工程路径（落盘路由依据） */
  projectPath?: string;
}

/** 一个工程的全部生成记录 */
export interface ProjectRecords {
  projectPath?: string;
  records: GenerationRecord[];
  /** 记录实际落盘位置 */
  storageMode?: "primary" | "fallback";
}

