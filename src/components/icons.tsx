import type { ReactNode } from 'react';
import './icons.css';

/**
 * 全站图标体系：手绘 24×24 线稿 SVG，stroke = currentColor（主题/语义色由按钮 CSS 的 color 决定）。
 * 设计约定：
 * - 坐标尽量落在 2–22 安全区内，笔画 1.7、圆角端点，14px 下仍可辨识
 * - 实心小点（打印指示灯、答题卡涂黑项等）用 fill="currentColor" stroke="none" 的 circle
 * - pin/pinFilled 两个名字而不是条件填充，保持 PATHS 静态
 * 模块图标按侧栏组建「形状家族」（组内共享造型语言，区分靠组不靠单图标）：
 *   词汇教学 = 矩形卡面 + 文字行（vocab / wordbank）；写作教学 = 纸面载体 + 同款斜笔（practical / continuation / handwriting）
 *   试卷整理 = 折角文档（exampaper）；课堂素材 = 横向节奏线（copybook 四线三格 / audio 波形）
 * 尺寸刻度：侧栏项 22 · 页头 20 · 主按钮 18 · 常规操作 16 · 迷你钮 14 · logo 24–26 · 拖放区 32
 */
export type IconName =
  // 模块标识（9）
  | 'home' | 'vocab' | 'practical' | 'continuation' | 'handwriting'
  | 'copybook' | 'exampaper' | 'wordbank' | 'audio'
  // 合成语音（TTS）
  | 'voice'
  // 常用操作
  | 'save' | 'history' | 'exportDoc' | 'download' | 'upload' | 'attach' | 'folder'
  | 'print' | 'trash' | 'sparkles' | 'camera' | 'search' | 'eye' | 'warning'
  | 'close' | 'plus' | 'refresh' | 'copy' | 'clipboard'
  | 'scissors' | 'pin' | 'pinFilled' | 'mute' | 'speed' | 'image' | 'mail' | 'phone'
  | 'slideshow' | 'worksheet' | 'cards' | 'package' | 'pen' | 'pencil' | 'eraser' | 'sidebar'
  // 站点信息（侧栏底部）
  | 'shield';

const PATHS: Record<IconName, ReactNode> = {
  /* ── 模块标识 ─────────────────────────────────────────── */

  // 主页：双坡屋顶 + 烟囱 + 门 + 双窗
  home: (<>
    <path d="M4 10.7 12 3.8l8 6.9" />
    <path d="M5.8 9.7v10.5h12.4V9.7" />
    <path d="M15.6 6.3V4h2v3.8" />
    <path d="M10.3 20.2v-5.2h3.4v5.2" />
    <path d="M6.9 12.2h2.1v2.1H6.9zM15 12.2h2.1v2.1H15z" />
  </>),

  // 词汇提取：词卡 + 词条行 + 放大镜锁定一词（词汇组家族 = 矩形卡面 + 文字行，与 wordbank 书架同语言）
  vocab: (<>
    <rect x="4.6" y="3.2" width="11.2" height="17.6" rx="1.5" />
    <path d="M7.2 8h5.8M7.2 11h3.6M7.2 14h1.8" />
    <circle cx="15.9" cy="16.2" r="3" />
    <path d="M18 18.3l2.7 2.7" />
  </>),

  // 应用文：信封 + 斜置钢笔正在书写（写作组家族 = 纸面载体 + 同款斜笔，笔形与 handwriting 一致）
  practical: (<>
    <rect x="3.2" y="5.6" width="13.6" height="10.4" rx="1.4" />
    <path d="M3.6 6.6 10 11.6 16.4 6.6" />
    <path d="M11.7 18.1l7.3-7.3 2.1 2.1-7.3 7.3z" />
    <path d="M11.7 18.1l2.1 2.1-3.2 1.1z" />
  </>),

  // 读后续写：摊开的书 + 右页上的斜笔续写（写作组家族同款笔形；书签带让位给笔）
  continuation: (<>
    <path d="M12 5.2v14.3" />
    <path d="M12 5.2C10 3.9 7.1 3.9 4.6 4.9v14c2.5-1 5.4-1 7.4.3" />
    <path d="M12 5.2c2-1.3 4.9-1.3 7.4-.3v14c-2.5-1-5.4-1-7.4.3" />
    <path d="M6.9 8.6c1.4-.5 2.9-.5 4.1.1M6.9 11.6c1.4-.5 2.9-.5 4.1.1" />
    <path d="M13.7 15.3l4.4-4.4 1.9 1.9-4.4 4.4z" />
    <path d="M13.7 15.3l1.9 1.9-2.9 1z" />
  </>),

  // 个性化学案：练习纸 + 斜置钢笔在纸上书写
  handwriting: (<>
    <path d="M6 3.2h8.4l4 3.4v13.4H6z" />
    <path d="M14.4 3.2v3.4h4" />
    <path d="M8.2 12.4h3.4" />
    <path d="M9.8 16.2l9.9-9.9 2.5 2.5-9.9 9.9z" />
    <path d="M9.8 16.2l2.5 2.5-3.7 1.2z" />
    <path d="M6.4 19.9c.8-.8 1.6.8 2.4 0s1.6.8 2.4 0 .8-.8 1.6 0" />
  </>),

  // 衡水体字帖：钢笔尖（气孔 + 缝）+ 四线三格
  copybook: (<>
    <path d="M7.4 4.2c.5 3.9 2.1 6.6 4.6 9.3 2.5-2.7 4.1-5.4 4.6-9.3" />
    <path d="M7.4 4.2h9.2" />
    <circle cx="12" cy="7.6" r="1.1" />
    <path d="M12 8.7v4.8" />
    <path d="M3.4 15.2h17.2M3.4 17.7h17.2M3.4 20.2h17.2M3.4 22.7h17.2" />
  </>),

  // 试卷排版：答题卡 + 题干线 + 选项圆泡（一项涂黑）
  exampaper: (<>
    <path d="M6 2.6h9.4l3.6 3.6v15.2H6z" />
    <path d="M15.4 2.6v3.6H19" />
    <path d="M8.8 7.4h4.4M8.8 9.6h6.8" />
    <circle cx="9.5" cy="12.6" r=".95" /><circle cx="12.4" cy="12.6" r=".95" /><circle cx="15.3" cy="12.6" r=".95" />
    <circle cx="9.5" cy="15.6" r=".95" />
    <circle cx="12.4" cy="15.6" r=".95" fill="currentColor" stroke="none" />
    <circle cx="15.3" cy="15.6" r=".95" />
    <path d="M8.8 18.6h5" />
  </>),

  // 词库：三本高矮错落的立书 + 书架线
  wordbank: (<>
    <path d="M4.6 4.6h4.6v16.4H4.6z" />
    <path d="M6 7.4h1.8M6 9.6h1.8" />
    <path d="M15.6 6.4h4v14.6h-4z" />
    <path d="M16.8 9h1.6M16.8 11h1.6" />
    <path d="M10.8 9h4.2v12h-4.2z" />
    <path d="M11.9 11.4h2M11.9 13.4h2" />
    <path d="M3 21h18" />
  </>),

  // 听力剪辑：头梁 + 双耳罩 + 中央波形
  audio: (<>
    <path d="M4.6 13.4v-2.2a7.4 7.4 0 0 1 14.8 0v2.2" />
    <rect x="3.4" y="12.8" width="3.4" height="6" rx="1.2" />
    <rect x="17.2" y="12.8" width="3.4" height="6" rx="1.2" />
    <path d="M10 15.4v4M12 13.6v6.2M14 15.4v4" />
  </>),

  /* ── 常用操作 ─────────────────────────────────────────── */

  // 保存（软盘：盘体 + 挡板缝 + 标签纸）
  save: (<>
    <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="1.8" />
    <path d="M8 3.6v5.7h8V3.6" />
    <path d="M12.9 4.6v3.4" />
    <path d="M7.2 13.2h9.6v7.2H7.2z" />
    <path d="M9.2 15.6h5.6M9.2 17.8h3.6" />
  </>),

  // 历史（表盘 + 指针 + 左上逆时针箭头）
  history: (<>
    <circle cx="12" cy="12.6" r="7" />
    <path d="M12 8.8v3.8l2.8 1.6" />
    <path d="M3.2 9.2a9.3 9.3 0 0 1 4-4.9" />
    <path d="M7.2 4.3 4.4 3.9M7.2 4.3 7 7.1" />
  </>),

  // 导出 Word（文档 + 内文线 + 向右离页箭头）
  exportDoc: (<>
    <path d="M4.6 3.4h8.8l4 4v13.2H4.6z" />
    <path d="M13.4 3.4v4h4" />
    <path d="M7.2 10.6h6M7.2 13.4h3.6" />
    <path d="M13.8 16.6h6.6" />
    <path d="M18.4 14.5l2.3 2.1-2.3 2.1" />
  </>),

  // 下载（托盘 + 下箭头）
  download: (<>
    <path d="M12 3.6v10.6" />
    <path d="M7.7 10l4.3 4.2L16.3 10" />
    <path d="M3.6 17v3.4h16.8V17" />
  </>),

  // 上传（托盘 + 上箭头）
  upload: (<>
    <path d="M12 14.4V3.8" />
    <path d="M7.7 8l4.3-4.2L16.3 8" />
    <path d="M3.6 17v3.4h16.8V17" />
  </>),

  // 附件（回形针）
  attach: (<>
    <path d="M20.6 10.9l-8.7 8.7a5.5 5.5 0 0 1-7.8-7.8l8.2-8.2a3.7 3.7 0 0 1 5.2 5.2l-8.2 8.2a1.9 1.9 0 0 1-2.7-2.7l7.8-7.8" />
  </>),

  // 文件夹
  folder: (<>
    <path d="M3.6 5.6h5.7l2 2.4h9.1v11.9H3.6z" />
  </>),

  // 打印（上进纸 + 机身 + 下出纸 + 指示灯）
  print: (<>
    <path d="M7.2 3.4h9.6v4H7.2z" />
    <rect x="3.6" y="7.4" width="16.8" height="7.2" rx="1.4" />
    <path d="M7.2 14.6v6h9.6v-6" />
    <path d="M9.6 17.2h4.8M9.6 19.2h3.2" />
    <circle cx="17.3" cy="10.9" r=".75" fill="currentColor" stroke="none" />
  </>),

  // 删除（带盖垃圾桶 + 三条桶身竖缝）
  trash: (<>
    <path d="M4.6 5.6h14.8" />
    <path d="M9.6 5.6V3.8h4.8v1.8" />
    <path d="M6.2 5.6 7 20.6h10l.8-15" />
    <path d="M9.8 9.2v7.6M12 9.2v7.6M14.2 9.2v7.6" />
  </>),

  // AI 生成（一大两小四芒星）
  sparkles: (<>
    <path d="M11.5 2.8c.5 4 2.2 6.2 6.2 6.7-4 .5-5.7 2.7-6.2 6.7-.5-4-2.2-6.2-6.2-6.7 4-.5 5.7-2.7 6.2-6.7z" />
    <path d="M18.4 13.6c.25 2 1.1 3.1 3.1 3.35-2 .25-2.85 1.35-3.1 3.35-.25-2-1.1-3.1-3.1-3.35 2-.25 2.85-1.35 3.1-3.35z" />
    <path d="M6 15.9c.2 1.6.9 2.5 2.5 2.7-1.6.2-2.3 1.1-2.5 2.7-.2-1.6-.9-2.5-2.5-2.7 1.6-.2 2.3-1.1 2.5-2.7z" />
  </>),

  // 拍照（机身 + 取景凸起 + 双环镜头 + 闪光点）
  camera: (<>
    <rect x="3" y="7" width="18" height="12.6" rx="1.9" />
    <path d="M8.4 7l.9-2.3h5.4l.9 2.3" />
    <circle cx="12" cy="13.2" r="3.5" />
    <circle cx="12" cy="13.2" r="1.5" />
    <circle cx="17.6" cy="9.8" r=".65" fill="currentColor" stroke="none" />
  </>),

  // 查看 / 预览（放大镜 + 高光弧）
  search: (<>
    <circle cx="10.7" cy="10.7" r="6.2" />
    <path d="M15.2 15.2 20.6 20.6" />
    <path d="M7.3 9.4a3.9 3.9 0 0 1 2-2.2" />
  </>),

  // 眼睛（杏仁形 + 虹膜 + 瞳孔）
  eye: (<>
    <path d="M2.9 12c2.5-4.5 5.4-6.5 9.1-6.5s6.6 2 9.1 6.5c-2.5 4.5-5.4 6.5-9.1 6.5s-6.6-2-9.1-6.5z" />
    <circle cx="12" cy="12" r="3.1" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </>),

  // 警示（圆角三角 + 感叹号）
  warning: (<>
    <path d="M12 3.7l9.2 15.8a1.3 1.3 0 0 1-1.1 2H3.9a1.3 1.3 0 0 1-1.1-2z" />
    <path d="M12 9.6v4.8" />
    <circle cx="12" cy="17.3" r="1" fill="currentColor" stroke="none" />
  </>),

  // 关闭
  close: (<>
    <path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />
  </>),

  // 加号
  plus: (<>
    <path d="M12 5.4v13.2M5.4 12h13.2" />
  </>),

  // 刷新（环形箭头 + 右上角标）
  refresh: (<>
    <path d="M20.5 11.5A8.5 8.5 0 1 1 18 6" />
    <path d="M18 2.5V6h3.5" />
  </>),

  // 复制（两张错位卡片）
  copy: (<>
    <rect x="8.8" y="8.8" width="11.6" height="11.6" rx="1.6" />
    <path d="M5.8 15.4h-.6a1.7 1.7 0 0 1-1.7-1.7V5.2a1.7 1.7 0 0 1 1.7-1.7h8.5a1.7 1.7 0 0 1 1.7 1.7v.6" />
  </>),

  // 配套材料（夹板 + 三行清单）
  clipboard: (<>
    <rect x="4.6" y="4.2" width="14.8" height="17" rx="1.6" />
    <rect x="9" y="2.5" width="6" height="3.4" rx="1" />
    <path d="M8 10.4h8M8 13.6h8M8 16.8h5" />
  </>),

  // 剪切（双环剪刀）
  scissors: (<>
    <circle cx="6" cy="6.6" r="2.5" />
    <circle cx="6" cy="17.4" r="2.5" />
    <path d="M8.1 8.1 19.7 17.6M8.1 15.9 19.7 6.4" />
  </>),

  // 图钉（轮廓：针 + 外张针头）
  pin: (<>
    <path d="M9 3.4h6l-.8 5.6c1.6 1 2.6 2.4 2.9 4.2H6.9c.3-1.8 1.3-3.2 2.9-4.2z" />
    <path d="M12 13.2v8.6" />
  </>),

  // 图钉（已固定：针头实心）
  pinFilled: (<>
    <path d="M9 3.4h6l-.8 5.6c1.6 1 2.6 2.4 2.9 4.2H6.9c.3-1.8 1.3-3.2 2.9-4.2z" fill="currentColor" />
    <path d="M12 13.2v8.6" />
  </>),

  // 静音（喇叭 + 叉）
  mute: (<>
    <path d="M4.4 9.6h3.4l4.8-4.2v13.2l-4.8-4.2H4.4z" />
    <path d="M16 9.4l4.8 4.8M20.8 9.4 16 14.2" />
  </>),

  // 变速（闪电）
  speed: (<>
    <path d="M13.2 2.6 5.6 13.4h5.4l-1 8 7.8-10.8h-5.4z" />
  </>),

  // 合成语音（波形）
  voice: (<>
    <path d="M4 10.2v3.6M8 6.8v10.4M12 3.6v16.8M16 6.8v10.4M20 10.2v3.6" />
  </>),

  // 图片（相框 + 山形 + 太阳）
  image: (<>
    <rect x="3.4" y="4.6" width="17.2" height="15" rx="1.6" />
    <circle cx="15.9" cy="8.9" r="1.5" />
    <path d="M3.9 19.2 9 12.8l3.3 3.8 3-3.4 4.8 5.4" />
  </>),

  // 邮件（信封 + 折线）
  mail: (<>
    <rect x="3" y="5.4" width="18" height="13.2" rx="1.6" />
    <path d="M3.8 6.6 12 13l8.2-6.4" />
    <path d="M3.8 17.4 8.6 13.5M20.2 17.4l-4.8-3.9" />
  </>),

  // 手机（圆角机身 + 听筒缝 + Home 点）
  phone: (<>
    <rect x="6.8" y="2.6" width="10.4" height="18.8" rx="2.2" />
    <path d="M10.4 4.8h3.2" />
    <circle cx="12" cy="18.6" r="1" />
  </>),

  // 幻灯片（投影幕布 + 播放三角 + 支架）
  slideshow: (<>
    <rect x="3" y="4" width="18" height="11.8" rx="1.5" />
    <path d="M10.4 7.2v5.4l4.6-2.7z" />
    <path d="M12 15.8v2.6M8.4 19.6h7.2" />
  </>),

  // 默写卷 / 检测（试卷 + 横线 + 对勾）
  worksheet: (<>
    <path d="M6 2.6h9.4l3.6 3.6v15.2H6z" />
    <path d="M15.4 2.6v3.6H19" />
    <path d="M8.8 10.2h6.4M8.8 13h4" />
    <path d="M8.8 17.6l1.9 1.9 3.6-3.9" />
  </>),

  // 闪卡（两张错位卡片 + 折角）
  cards: (<>
    <path d="M8.8 4.6h10v10h-10z" />
    <path d="M5.2 9.4h10v10h-10z" />
    <path d="M12.4 9.4v2.2h2.2" />
  </>),

  // 打包导出（纸箱 + 十字胶带）
  package: (<>
    <rect x="4.6" y="5.6" width="14.8" height="14.8" rx="1.5" />
    <path d="M12 5.6v14.8M4.6 10.4h14.8" />
  </>),

  // 蘸水笔（斜杆 + 笔尖 + 气孔）
  pen: (<>
    <path d="M21.3 2.7a1.5 1.5 0 0 0-2.1 0l-9.8 9.8 2.1 2.1 9.8-9.8a1.5 1.5 0 0 0 0-2.1z" />
    <path d="M9.4 12.5c-.8 2.3-1.5 4.5-2.4 6.8 2.3-.9 4.6-1.6 6.9-2.4" />
    <circle cx="10.3" cy="14.8" r=".55" fill="currentColor" stroke="none" />
  </>),

  // 铅笔（斜杆 + 笔尖 + 橡皮头界线）
  pencil: (<>
    <path d="M17.9 3.2 20.8 6.1 8.4 18.5l-4 1 1-4z" />
    <path d="M17.2 5.9l1.6-1.6" />
  </>),

  // 清空（板擦 + 擦痕）
  eraser: (<>
    <path d="M4.2 13.8 10.4 7.6l9.4 9.4-4.2 4.2H8.4l-4.2-4.2z" />
    <path d="M16.8 14 9.6 21.2" />
    <path d="M4.6 6.4H8M9.6 3.8H13" />
  </>),

  // 侧栏开关（面板 + 左侧分隔 + 内容短线）
  sidebar: (<>
    <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="1.8" />
    <path d="M9.4 4.6v14.8" />
    <path d="M5.6 8h1.4M5.6 11h1.4M5.6 14h1.4" />
  </>),

  // 隐私与协议（盾牌 + 对勾）
  shield: (<>
    <path d="M12 3.2 5.2 5.7v5.5c0 4.3 2.8 7.3 6.8 9.4 4-2.1 6.8-5.1 6.8-9.4V5.7z" />
    <path d="M9.3 11.7l2 2 3.6-4" />
  </>),
};

export interface IconProps {
  name: IconName;
  /** 像素尺寸，默认 20 */
  size?: number;
  className?: string;
  /** 图标为唯一内容时的可读名称（渲染 <title>）；缺省则 aria-hidden */
  title?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, className, title, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className ? `icon ${className}` : 'icon'}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
