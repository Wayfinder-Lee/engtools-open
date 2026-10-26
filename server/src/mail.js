'use strict';

/**
 * 邮箱验证码发送（nodemailer）。
 * 未配置 SMTP 时降级为 console 输出（本地/测试期可用）。
 */

const nodemailer = require('nodemailer');
const config = require('./config');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!config.smtp.user || !config.smtp.pass) return null;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transporter;
}

/**
 * 发送邮箱验证码。返回 { sent: boolean, preview?: string }。
 */
async function sendVerifyCode(email, code) {
  const t = getTransporter();
  const subject = 'English Teacher Toolkit — 邮箱验证码';
  // 品牌卡片版模板：表格布局 + 全内联样式（QQ/163 对 div+class 支持差）。
  // 配色对齐网站主题（index.css）：暖米白 --bg / 赤陶橙 --accent / 墨字 --fg。
  // ⚠️ 不用图片 logo（QQ/163 默认不显示外链图片），不加退订（事务邮件放了反而降到达率）。
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f5;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #eeeae0;overflow:hidden">
      <tr><td style="height:6px;background:#d97757;font-size:0;line-height:6px">&nbsp;</td></tr>
      <tr><td style="padding:32px 36px 28px;font-family:Georgia,'Songti SC',SimSun,serif">
        <div style="font-size:18px;color:#29261b;letter-spacing:0.5px">English Teacher&rsquo;s Toolkit</div>
        <div style="height:1px;background:#eeeae0;margin:18px 0"></div>
        <h2 style="margin:0 0 12px;font-size:20px;color:#29261b;font-weight:600">邮箱验证码</h2>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#57534a;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
          您正在验证 engtools 账号，请使用以下验证码：
        </p>
        <div style="font-size:42px;font-weight:700;color:#d97757;letter-spacing:12px;font-family:Menlo,Consolas,monospace">${code}</div>
        <p style="margin:20px 0 0;font-size:13px;color:#8a8578;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
          有效期 10 分钟，请尽快使用。
        </p>
      </td></tr>
      <tr><td style="padding:18px 36px 24px;border-top:1px solid #eeeae0;background:#fdfcf9">
        <p style="margin:0 0 6px;font-size:12px;color:#8a8578;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
          如非本人操作，请忽略此邮件。
        </p>
        <p style="margin:0 0 6px;font-size:12px;color:#8a8578;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
          客服邮箱：<a href="mailto:engtools@qq.com" style="color:#a64a28;text-decoration:none">engtools@qq.com</a>
        </p>
        <a href="https://www.engtools.cn" style="font-size:12px;color:#a64a28;text-decoration:none;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">engtools.cn</a>
      </td></tr>
    </table>
  </td></tr>
</table>`;

  if (t) {
    await t.sendMail({ from: config.smtp.from, to: email, subject, html });
    return { sent: true };
  }

  // 降级：打印到日志
  // eslint-disable-next-line no-console
  console.log(`[mail] 未配置 SMTP，验证码打印到控制台: ${email} → ${code}`);
  return { sent: false, preview: code };
}

module.exports = { sendVerifyCode };
