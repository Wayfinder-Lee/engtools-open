/**
 * 站级运营常量（单一出处）。
 * 留空/关闭的项，对应 UI 自动隐藏——上线前按需填写即可，无需改组件。
 */
export const SITE = {
  /** 站点正式地址（canonical / og:url 用） */
  url: 'https://www.engtools.cn',

  /**
   * 百度统计站点 ID（hm.js? 后面那串）。
   * 留空 = 不加载统计脚本、track() 为空操作；申请后填入即可（tongji.baidu.com，与百度站长同账号）。
   */
  baiduTongjiId: '',

  /** 反馈/售后联系邮箱。留空 = 反馈区只显示微信群指引。 */
  feedbackEmail: '',

  /** ICP 备案号（如「陇ICP备2026xxxxxx号-1」）。留空 = 页脚不显示备案栏。 */
  icpBeian: '',

  /** 无邮箱时的反馈指引文案（淘宝商品页有客服入口）。 */
  feedbackHint: '通过淘宝商品页的客服入口，或网站页脚的联系方式反馈',

  /**
   * 购买入口（淘宝商品，自动发货）。改 false 即全站隐藏购买引导、引导卡退回「联系管理员」文案。
   * 二维码静态资源在 public/landing/taobao-qr.png（随 landing/ 静态资源目录上传，7 天缓存）。
   */
  purchaseEnabled: true,
  purchaseUrl: 'https://item.taobao.com/item.htm?ft=t&id=1092199557736',
  /** 充值面板扫码用；留空 = 只显示链接不显示二维码。 */
  purchaseQr: '/landing/taobao-qr.png',

  /** 低额度提醒阈值：余额低于该值时顶栏额度 chip 变色。 */
  lowQuotaThreshold: 20,

  /**
   * 单次生成免弹窗确认的额度上限：≤ 该值时按钮上的标价即确认（菁优式「按钮标价」），
   * 超过（如整班批量的个性化学案）弹轻量确认卡防误触。
   */
  smallCostThreshold: 5,
};
