# -*- coding: utf-8 -*-
"""
M5 工具落地页生成器：public/landing/tools/ 下 6 个独立静态 HTML。
- 图片位=占位框（含给 William 的拍摄/截图说明），替换时把占位 <div class="shot-ph"> 换成
  <img src="./images/<name>.jpg" alt="..."> 即可（目录建议 public/landing/tools/images/）。
- 重新生成：python3 scripts/gen-tool-pages.py
- 部署：public/landing/ 整目录随静态资源上传，无需改脚本。
"""
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'landing' / 'tools'
SITE = 'https://www.engtools.cn'

CSS = """:root{--bg:#faf6f1;--bg-raised:#fffdf9;--fg:#2e241c;--fg2:#5c5347;--muted:#8a7f70;--accent:#d97757;--accent-t:#a64a28;--soft:#f6e7de;--border:#e8e0d4;--radius:14px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--fg);line-height:1.75}
a{color:var(--accent-t)}
.wrap{max-width:920px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--border);background:var(--bg-raised)}
header .wrap{display:flex;align-items:center;justify-content:space-between;padding:14px 20px}
.logo{font-weight:700;font-size:16px;color:var(--fg);text-decoration:none}
.hero{padding:56px 0 40px}
.kicker{color:var(--accent-t);font-weight:600;font-size:14px;letter-spacing:.04em}
h1{font-size:clamp(24px,5vw,36px);line-height:1.3;margin:8px 0 12px}
.tagline{color:var(--fg2);font-size:16px;max-width:640px}
.cta{display:inline-block;margin-top:22px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;padding:11px 28px;border-radius:999px}
.cta:hover{background:#c4643f}
h2{font-size:20px;margin:44px 0 14px}
.shot{background:var(--bg-raised);border:1px dashed var(--border);border-radius:var(--radius);padding:14px}
.shot img{width:100%;border-radius:10px;display:block}
.shot-ph{min-height:300px;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;text-align:center;color:var(--muted);font-size:14px;padding:24px}
.shot-ph b{color:var(--fg2)}
.shot-cap{font-size:13px;color:var(--muted);margin-top:8px}
ol.steps,ul.feats{padding-left:22px;color:var(--fg2)}
ol.steps li,ul.feats li{margin:8px 0}
details{background:var(--bg-raised);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin:10px 0}
summary{cursor:pointer;font-weight:600}
details p{color:var(--fg2);margin-top:8px;font-size:14.5px}
.tools{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.tools a{font-size:13px;text-decoration:none;background:var(--bg-raised);border:1px solid var(--border);border-radius:999px;padding:6px 14px;color:var(--fg2)}
.tools a:hover{border-color:var(--accent);color:var(--accent-t)}
footer{border-top:1px solid var(--border);margin-top:56px;padding:22px 0 30px;color:var(--muted);font-size:13px;text-align:center}
.note{font-size:13px;color:var(--muted);margin-top:8px}
"""

def page(name, kicker, title, tagline, shot_desc, shot_alt, steps, feats, faqs, faq_schema):
    interlinks = ''.join(
        f'<a href="./{p["file"]}">{p["label"]}</a>' for p in TOOLS if p['file'] != name
    )
    faq_html = '\n'.join(f'<details><summary>{q}</summary><p>{a}</p></details>' for q, a in faqs)
    feats_html = '\n'.join(f'<li>{f}</li>' for f in feats)
    steps_html = '\n'.join(f'<li>{s}</li>' for s in steps)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title}</title>
<meta name="description" content="{tagline}" />
<link rel="canonical" href="{SITE}/landing/tools/{name}.html" />
<meta property="og:type" content="article" />
<meta property="og:title" content="{title}" />
<meta property="og:description" content="{tagline}" />
<meta property="og:url" content="{SITE}/landing/tools/{name}.html" />
<style>{CSS}</style>
<script type="application/ld+json">
{faq_schema}
</script>
</head>
<body>
<header><div class="wrap">
  <a class="logo" href="/">🛠️ English Teacher's Toolkit</a>
  <a href="/">返回主站 →</a>
</div></header>

<main class="wrap">
  <section class="hero">
    <span class="kicker">{kicker}</span>
    <h1>{title.split(' - ')[0]}</h1>
    <p class="tagline">{tagline}</p>
    <a class="cta" href="/">免费试用（无需绑定 API Key）→</a>
    <p class="note">注册即送体验额度；生成的内容可导出 Word / PDF 打印。</p>
  </section>

  <h2>成品长这样</h2>
  <!-- ══ 图片占位（William 替换）══
       建议图：{shot_desc}
       操作：截图后存为 ./images/{name}.jpg（1200×800 左右），
       然后把下面整个 <div class="shot-ph">…</div> 换成：
       <img src="./images/{name}.jpg" alt="{shot_alt}" /> -->
  <div class="shot">
    <div class="shot-ph">
      <span style="font-size:34px">📷</span>
      <b>【图片占位】{shot_alt}</b>
      <span>{shot_desc}</span>
    </div>
  </div>

  <h2>三步出成品</h2>
  <ol class="steps">
{steps_html}
  </ol>

  <h2>为什么老师用它</h2>
  <ul class="feats">
{feats_html}
  </ul>

  <h2>常见问题</h2>
{faq_html}

  <h2>其他工具</h2>
  <div class="tools">
    {interlinks}
  </div>
</main>

<footer><div class="wrap">
  <p>English Teacher's Toolkit · 面向中学英语教师的 AI 备课工具箱 · <a href="{SITE}">www.engtools.cn</a></p>
  <!-- ICP 备案号下来后填这里 -->
</div></footer>
</body>
</html>
"""

TOOLS = [
    {'file': 'vocab', 'label': '📝 词汇提取'},
    {'file': 'practical', 'label': '✉️ 应用文助手'},
    {'file': 'continuation', 'label': '📖 读后续写助手'},
    {'file': 'worksheet', 'label': '✍️ 个性化学案'},
    {'file': 'copybook', 'label': '✒️ 衡水体字帖'},
    {'file': 'exampaper', 'label': '📄 试卷排版助手'},
]

PAGES = [
    dict(
        name='vocab',
        kicker='词汇提取 · 词汇学案',
        title='英语试卷词汇提取工具 - 一键生成词汇学案与默写清单',
        tagline='把整份高考/中考英语试卷粘贴进来，AI 自动按题型分段、提取重点词汇，生成带音标、释义、高频搭配、记忆法的词汇学案，一键导出 Word / CSV 打印。',
        shot_desc='词汇提取的词汇表界面截图：左侧行题分组（阅读理解A/完形填空…），每行一个词条（单词加粗、音标、★频次、释义、搭配、记忆法），右上角「导出 Docx 学案」按钮可见。',
        shot_alt='词汇提取工具的词汇表成品界面',
        steps=['粘贴试卷原文（或打开词汇提取页后点「用示例试一试」先看效果）', 'AI 自动按题型分段，勾选要提取词汇的段落并设置选词量', '核对/编辑词条，选择词汇表、默写清单等板块，导出 Word / CSV'],
        feats=['自动识别听力、阅读、完形、语法填空等题型段落，按段生成', '每个词条含音标、双语释义、高频搭配、构词记忆法、考频星级', '全部字段可在线编辑，导出前可勾选删减', '支持教师卷/学生卷、紧凑模式，页数预估省纸'],
        faqs=[
            ('支持初中学段（中考）吗？', '支持。切换到初中模式后，词汇范围锚定《义务教育英语课程标准（2022年版）》三级词汇（约1600词），提示词按中考标准生成。'),
            ('生成的词汇可以直接默写吗？', '可以。导出面板可选「默写清单」或「配套材料 → 词汇默写卷（含报词单）」，中文提示+空格作答，直接打印。'),
            ('要收费吗？', '注册即送体验额度，每段提取消耗 5 额度，生成失败自动退回；也可绑定自己的 API Key 使用。'),
        ],
        faq_schema='{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"支持初中学段（中考）吗？","acceptedAnswer":{"@type":"Answer","text":"支持。初中模式词汇范围锚定义务教育课标三级词汇（约1600词）。"}},{"@type":"Question","name":"生成的词汇可以直接默写吗？","acceptedAnswer":{"@type":"Answer","text":"可导出默写清单或词汇默写卷（含报词单），直接打印。"}},{"@type":"Question","name":"要收费吗？","acceptedAnswer":{"@type":"Answer","text":"注册送体验额度，每段 5 额度，失败自动退回。"}}]}',
    ),
    dict(
        name='practical',
        kicker='应用文助手 · 书面表达',
        title='英语应用文范文生成器 - 建议信邀请信学案一键成稿',
        tagline='输入应用文题干，选择基础/套路/拔高三档水平，AI 生成对应层次的范文、逐段写作分析、话题词汇句式、写作模板与分句默写材料，导出 Word 学案直接讲评。',
        shot_desc='应用文助手的学案成品截图：上方三档范文对比（基础/套路/拔高），中部文章分析（体裁/语气/结构/要点覆盖），下方话题词汇句式分组与分句默写区。',
        shot_alt='应用文助手的学案成品界面',
        steps=['粘贴应用文题干（或点体裁模板：建议信/邀请函/申请信/通知）', '选三档层次之一（同一题目可分别生成，给 ABC 三层学生）', '生成范文+写作分析+词汇句式+默写，核对修改后导出 Word 学案'],
        feats=['同一题干三档范文，分层教学不用出三份题', '逐段写作分析：体裁、语气、结构、信息点覆盖', '话题词汇句式可勾选，勾什么导什么', '自带分句默写翻译练习，讲评+巩固一份材料搞定'],
        faqs=[
            ('初中书面表达能用吗？', '能。初中模式按中考书面表达标准生成：80-100词、禁用高中语法点，亮点句式控制在 2-4 处。'),
            ('三档范文是什么意思？', '同一题目分别生成基础级/套路级/拔高级范文，A、B、C 层学生各拿各的学案，不必手动改写。'),
            ('可以只重写其中一段吗？', '可以。范文每段都有「换一个」按钮，只重生成该段；也支持按当前层次整篇重写。'),
        ],
        faq_schema='{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"初中书面表达能用吗？","acceptedAnswer":{"@type":"Answer","text":"能。初中模式按中考标准生成，禁用高中语法点。"}},{"@type":"Question","name":"三档范文是什么意思？","acceptedAnswer":{"@type":"Answer","text":"同一题目生成基础/套路/拔高三档范文，适合分层教学。"}},{"@type":"Question","name":"可以只重写其中一段吗？","acceptedAnswer":{"@type":"Answer","text":"可以，每段有「换一个」按钮，也支持整篇换层次重写。"}}]}',
    ),
    dict(
        name='continuation',
        kicker='读后续写助手 · 高考写作',
        title='读后续写范文生成 - 十句五定法写作支架',
        tagline='粘贴读后续写前文，AI 生成两段衔接自然的续写范文、人物与情节矛盾分析、逐句拆解的「十句五定法」支架，配动作/情绪/语言描写句式库与分句默写，一份学案讲透一道续写。',
        shot_desc='读后续写助手的学案截图：两段续写范文（Paragraph 1/2），人物分析表，剧情矛盾分析，十句五定法逐句表（每句标注功能：动作链/情绪线/主题升华），描写句式库。',
        shot_alt='读后续写助手的十句五定法学案界面',
        steps=['粘贴续写原文与两段段首句（可用示例先试）', 'AI 生成续写范文、人物/冲突分析、十句五定法拆解与描写句式库', '核对修改，导出 Word 学案（含分句默写）'],
        feats=['续写范文严格衔接段首句，情节承接前文伏笔', '十句五定法：每句有明确功能定位，学生照着框架写', '动作/情绪/语言三类描写句式，按需取用', '分句默写把范文的句子变成巩固练习'],
        faqs=[
            ('十句五定法是什么？', '把两段续写拆成十句，每句锁定一个功能（动作推进、情绪反应、环境衬托、主题升华等），学生按框架填内容，解决「不知道写什么」的问题。'),
            ('初中能用吗？', '读后续写为高考题型，初中模式下该工具自动隐藏；初中书面表达请用「应用文助手」。'),
            ('生成失败会计费吗？', '不会。生成失败自动退回额度，可以放心重试。'),
        ],
        faq_schema='{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"十句五定法是什么？","acceptedAnswer":{"@type":"Answer","text":"把两段续写拆成十句，每句锁定动作/情绪/环境/主题等功能，学生按框架写作。"}},{"@type":"Question","name":"初中能用吗？","acceptedAnswer":{"@type":"Answer","text":"读后续写为高考题型，初中模式自动隐藏。"}},{"@type":"Question","name":"生成失败会计费吗？","acceptedAnswer":{"@type":"Answer","text":"失败自动退回额度。"}}]}',
    ),
    dict(
        name='worksheet',
        kicker='书面表达个性化学案 · 作文讲评',
        title='学生手写作文照片一键生成个性化学案 - 作文讲评工具',
        tagline='每个学生拍一张作文答题卡照片上传，AI 逐份 OCR 识别、逐句诊断错误、按时态/句式/用词归类问题，为每位学生生成专属讲评学案与巩固练习，批量打印 PDF / Word。',
        shot_desc='个性化学案的批量流程截图：学生胶囊列表（每人一个✓/⏳状态）、单份学案（错误归类表：时态/逗号粘连/主谓一致…+针对性巩固默写+句式提升）。',
        shot_alt='书面表达个性化学案的批量生成与单个学案界面',
        steps=['设置作文题干，批量上传学生手写作文照片（每生一张）', 'AI 自动识别文字并评定书写质量，逐个核对可改', '一键为全班生成个性化学案，批量打印 PDF 或导出 Word'],
        feats=['一张照片对应一位学生，文件名即姓名，免录入', '错误按类型归类（时态、逗号粘连、非谓语…），讲评有据', '每位学生的学案只针对他自己的问题，真正个性化', '含书写质量评定（衡水体合规度），练字一起抓'],
        faqs=[
            ('学生姓名会泄露吗？', '照片仅用于当次识别，不做其他用途；上传前请确认已获学生/家长同意，也可先遮挡姓名。历史记录只保存在你自己的浏览器里。'),
            ('全班 45 人要多久？', 'OCR 与生成按人批量进行，通常几分钟内完成；失败的个人可单独重试，失败不扣额度。'),
            ('能导出成 Word 吗？', '可以。支持逐个导出 Word 与批量打包 Word，也可直接批量打印为 PDF。'),
        ],
        faq_schema='{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"学生姓名会泄露吗？","acceptedAnswer":{"@type":"Answer","text":"照片仅用于当次识别，历史只存在本机浏览器，上传前可遮挡姓名。"}},{"@type":"Question","name":"全班45人要多久？","acceptedAnswer":{"@type":"Answer","text":"批量进行，通常几分钟；失败可单独重试且不扣额度。"}},{"@type":"Question","name":"能导出成 Word 吗？","acceptedAnswer":{"@type":"Answer","text":"支持单个与批量导出 Word，也可批量打印为 PDF。"}}]}',
    ),
    dict(
        name='copybook',
        kicker='衡水体字帖 · 英语书写',
        title='衡体字帖生成器 - 英语四线三格字帖在线打印',
        tagline='粘贴或 AI 生成英文内容，一键生成衡水体练习纸：四线三格/两线/单线，描红、隔行临摹、空白三种模式，字号字距行距可调，浏览器直接打印或另存 PDF。',
        shot_desc='衡水体字帖打印预览截图：A4 页面，顶部字帖标题与学生姓名栏，正文为四线三格上的圆润字体例词，右侧或下方为线格类型/模式/字号调节面板。',
        shot_alt='衡水体字帖的打印预览界面',
        steps=['粘贴英文内容，或输入主题让 AI 生成（也可用词库里存的词汇例句）', '选线格类型（四线三格/两线/单线）与模式（描红/临摹/空白）', '调字号字距行距，浏览器打印或另存 PDF'],
        feats=['内置衡水体字体，字形圆润规整，贴近高考书写要求', '描红→隔行临摹→空白三档，一套材料完成书写进阶', '「从词库生成」把词汇课学的词直接变成练写内容', '纯本地渲染，不消耗 AI 额度，打印免费'],
        faqs=[
            ('免费吗？', '字帖排版与打印完全免费；只有让 AI 按主题生成练习内容时消耗少量额度（5 额度），用词库生成则免费。'),
            ('可以调大小吗？', '可以，字号、字距、行距、线格类型、墨色深浅全部可调，实时预览。'),
            ('怎么导出 PDF？', '点「打印 / 导出 PDF」，在系统打印对话框中选择「另存为 PDF」目标打印机即可。'),
        ],
        faq_schema='{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"免费吗？","acceptedAnswer":{"@type":"Answer","text":"排版与打印免费；AI 生成内容消耗 5 额度，用词库生成免费。"}},{"@type":"Question","name":"可以调大小吗？","acceptedAnswer":{"@type":"Answer","text":"字号、字距、行距、线格、墨色全部可调，实时预览。"}},{"@type":"Question","name":"怎么导出 PDF？","acceptedAnswer":{"@type":"Answer","text":"打印对话框中选择「另存为 PDF」。"}}]}',
    ),
    dict(
        name='exampaper',
        kicker='试卷排版助手 · 组卷排版',
        title='英语试卷排版软件替代 - AI 解析重排导出 Word',
        tagline='粘贴试卷原文或上传 docx/扫描件/照片，AI 按大题解析题型结构、题号、选项与答案，逐项可改，一键导出 A4/8K/A3 的规整 Word 试卷，可附答案页——把排版时间还给教学。',
        shot_desc='试卷排版助手的三步流程截图：左侧原文粘贴/docx上传入口，中部解析出的大题结构列表（听力/阅读/完形…各块状态），右侧 A4 双栏排版预览与「导出 Word」按钮。',
        shot_alt='试卷排版助手的解析与排版预览界面',
        steps=['粘贴试卷原文，或上传 docx / 扫描件 PDF / 拍照（旧卷直接拍）', 'AI 按大题分块解析：题号、题干、选项、答案自动结构化，逐项可改', '选纸张（A4/8K/A3）与栏数，导出 Word，可附答案页；预览区可直接打印为 PDF'],
        feats=['扫描件、照片也能识别——老卷子不用重新录入', '题号守卫自动提示漏题/幻觉题号，解析更可信', '选项 A/B/C/D 宽度自适应分行，告别手敲空格对齐', '页数凑排（A4/8K/A3 双栏），导出即可印发'],
        faqs=[
            ('和 WPS 排版有什么区别？', 'WPS 是你排；这里是 AI 按结构解析后自动排，你只核对内容。选择对齐、题号连续性、双栏分页都自动处理。'),
            ('扫描的旧试卷能用吗？', '能。扫描件 PDF 与照片走视觉识别逐页转写，每页消耗少量额度，转写后同样解析排版。'),
            ('导出的是什么格式？', 'Word（.docx），可再编辑；预览区支持直接「打印 / 另存为 PDF」得到保排版的 PDF。'),
        ],
        faq_schema='{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"和 WPS 排版有什么区别？","acceptedAnswer":{"@type":"Answer","text":"AI 按结构解析后自动排版，选项对齐、题号检查、双栏分页自动处理。"}},{"@type":"Question","name":"扫描的旧试卷能用吗？","acceptedAnswer":{"@type":"Answer","text":"能，扫描件与照片走视觉识别逐页转写。"}},{"@type":"Question","name":"导出的是什么格式？","acceptedAnswer":{"@type":"Answer","text":"Word（.docx）可再编辑，预览区可直接另存为 PDF。"}}]}',
    ),
]

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for t in PAGES:
        fp = OUT / f"{t['name']}.html"
        fp.write_text(page(**t), encoding='utf-8')
        print('written', fp)

if __name__ == '__main__':
    main()
