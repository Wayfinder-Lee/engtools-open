/**
 * 听力模板音频清单。
 *
 * 模板文件放在站点静态资源目录 public/audio-templates/ 下（构建时原样拷贝到
 * dist/，部署后由 fetch 相对路径加载，不经任何服务器处理）。放入新素材后
 * 在 AUDIO_TEMPLATES 里登记一条即可出现在「听力剪辑」工具的模板栏，
 * 点击即插入到时间线的播放头 / 选区起点位置。
 */
export interface AudioTemplate {
  /** 文件名（含扩展名），对应 public/audio-templates/ 下的文件 */
  file: string;
  /** 模板栏按钮与片段列表里显示的名字 */
  name: string;
  /** 可选的一句话说明（悬停提示） */
  description?: string;
}

export const AUDIO_TEMPLATES: AudioTemplate[] = [
  // 示例（放好文件后取消注释即可生效）：
  // { file: 'gap-5s.mp3', name: '5 秒答题间隔', description: '替换题目间过长的静音' },
];
