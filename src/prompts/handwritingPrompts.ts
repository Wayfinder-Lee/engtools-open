import type { ClassStats, EssayType, Stage } from '../types';

// ─── 应用文写作 — 学案生成 Prompt ────────────────────

function getPracticalWritingCriteria(stage: Stage): string {
  const examName = stage === 'junior' ? '中考' : '高考';
  const wordRule = stage === 'junior' ? '词数是否达到 80-100 词的要求' : '词数是否符合题目要求';
  const tenseRule = stage === 'junior'
    ? '\n- **时态符合体裁**：日记/记叙经历类应为一般过去时，建议/计划类应为一般现在时或一般将来时；全文时态混乱应作为扣分点指出'
    : '';
  return `## 应用文写作评价标准
- **体裁格式**：书信/通知/演讲稿/倡议书/日记/报道等格式是否正确（称呼、落款、日期等）
- **语气得体**：是否根据对象（同学/老师/编辑/公众）和目的（建议/邀请/感谢/申请/道歉/通知/倡议）选择恰当的语气和措辞
- **要点覆盖**：题干列出的所有内容要点是否全部覆盖，有无遗漏；${wordRule}${tenseRule}
- **结构清晰**：开头-主体-结尾三段式是否完整，段落衔接是否自然（注意：${examName}应用文篇幅短、段落少，简单的衔接手段如First/Second/Finally已足够，不要轻易判定为"缺乏过渡"）
- **语言质量**：句式是否多样，词汇是否恰当，有无语法错误`;
}

function getContinuationWritingCriteria(): string {
  return `## 读后续写评价标准
- **情节承接**：续写部分是否合理承接前文情节和两段首句，逻辑是否通顺
- **人物一致性**：人物性格、行为方式是否与原文保持一致
- **情感逻辑**：情感推进是否自然合理，是否有层次感
- **主题升华**：结尾是否有恰当的主题升华，是否与文章内核呼应
- **描写丰富度**：动作、情绪、心理、环境、语言描写是否充分
- **语言质量**：句式是否多样，有无语法错误，词数是否达标

## 审题分析（续写专项）
除通用审题外，还须重点分析以下续写特有维度（填入 continuationAnalysis 字段）：
- p1ConnectsToOpening：第二段续写开头是否衔接了题目给出的第一段段首句（boolean）
- p1EndConnectsToP2：第一段末尾是否能自然过渡到第二段段首句（boolean）
- hasThemeHighlight：文章末尾是否有主旨升华 / 主题点题（boolean）
- onlyTwoParagraphs：学生是否只写了 2 段（没有在题目要求的 2 段之外自行额外分段）（boolean）
- detail：对以上四个维度的综合说明（2-3 句中文）

## 描写多样性分析
在 continuationAnalysis.descriptionDiversity 字段中填入描写多样性分析（对象结构）：
- action: boolean, dialogue: boolean, emotion: boolean, environment: boolean
- comment: 1 句中文评价
同时在 overallComment 文本中加入 1 句描写多样性的总结（如"该生描写以动作为主，缺少情绪和环境描写"），注意 overallComment 是纯文本字符串，不要把对象放进去。`;
}

function getScoringRubric(essayType: EssayType, stage: Stage): string {
  // 2026-10 重写（去聚类）：旧版判据抽象且 JSON 示例锚定 9/9/18，25 分制读后续写实测扎堆 18
  //（官方六档版 18 恰为次高档门槛、五档版为四档中点，模型无档内锚点即回归区间中值）。
  // 新版四件套：①scoreBreakdown 维度分先进 JSON 且键序在 score 之前（自回归键序=思考顺序，
  // 把「先证据后打分」变成结构强制）②五档档内取分规则 + 「18 分特别说明」③一弱一强校准锚例
  // ④OCR 噪声豁免（输入是 OCR 文本，不豁免会系统性压语言分）。锚点布局：续写 12/16/20、
  // 应用文 7/10/13 三点互斥锚——18/9 等旧引力位无锚，只被规则「定义」不被示例「示范」。
  const notes = `
### 评分注意事项
- 鼓励只体现在评语措辞，绝不体现在分数与定档；分数必须忠实于锚点表。
- 通篇简单句零错误不因「安全」给高分；因尝试较高级句式出现的小错不降档。
- 学生原文经 OCR 识别，个别形近字母错误可能是识别噪声：语言维度只统计成体系的语言错误（时态、主谓一致、搭配等），孤立的疑似 OCR 噪声不计为拼写错误。`;

  if (essayType === 'practical') {
    const juniorTitle = stage === 'junior'
      ? '（中考书面表达满分 15 分；各地中考分值不一，以当地中考考试说明为准）'
      : '（应用文满分 15 分）';
    const juniorNote = stage === 'junior'
      ? `\n- 初中生以简单句为主不压档：语言分看准确与错误多少，不看句式高级；课标词汇内准确流畅即可进四/五档；亮点句式全文 2-4 处即达标。`
      : '';
    return `## 评分标准与评分程序${juniorTitle}

### 评分程序（严格按顺序执行，禁止跳步先出总分）
1. 摘证据（内部完成，不必输出）：对照题干逐条勾出已覆盖/遗漏的要点；错误清单并数出影响理解的处数；格式（称呼/落款）与语气是否得体；衔接手段清单。
2. 分维度打分：内容 x/6、语言 x/6、结构 x/3（整数），先输出 scoreBreakdown 三个维度分，再输出总分 score。
3. 定档：三维之和对照锚点表定档；维度之间矛盾（如内容高档语言低档）时，按更低的一档定位档内位置。
4. 档内取分并复查：按档内取分规则落到具体分数（禁止不加判断取档内中间值）；逐条核对定档硬触发器，命中即执行；自查 score = 三维之和。

### 评分维度
- 内容（6 分）：题干要点覆盖（漏一个主要要点即内容缺陷）、要点扩展、任务完成度
- 语言（6 分）：词汇与语法的准确性、恰当性与多样性；错误数量及是否影响理解
- 结构（3 分）：三段式完整、衔接成分、格式规范（篇幅短，First/Second/Finally 已是有效衔接，不因过渡简单扣分）

### 维度分档对照（每维按证据所属档取分；允许相邻档跨档，任意两维相差不超过 1 个档次）
| 档次 | 内容(/6) | 语言(/6) | 结构(/3) |
|------|------|------|------|
| 五档 | 6 | 5-6 | 3 |
| 四档 | 5 | 4 | 2 |
| 三档 | 3-4 | 3 | 1-2 |
| 二档 | 2 | 2 | 1 |
| 一档 | 0-1 | 0-1 | 0 |

### 五档锚点表
| 档次 | 区间 | 判据 |
|------|------|------|
| 五档 | 13-15 | 覆盖全部要点且有适当扩展；应用较多语法结构与词汇，些许错误恰因尝试复杂结构所致；连接成分有效，格式与语气得体 |
| 四档 | 10-12 | 覆盖全部主要内容（至多漏 1-2 个次要点）；语法词汇基本准确；应用简单连接成分，达到写作目的 |
| 三档 | 7-9 | 要点有遗漏但主体齐；语言可用但平淡（简单句为主）；有些错误但不影响理解 |
| 二档 | 4-6 | 漏掉或未写清部分主要内容；语法单调、词汇有限；错误较多且影响理解 |
| 一档 | 1-3 | 明显遗漏主要内容或写入无关内容；错误极多严重影响理解。未传达任何信息/全抄题目 → 0 分 |

### 档内取分规则（反默认分，必须执行）
- 五档：14-15 = 要点全+复杂结构准确+语气格式得体；13 = 刚进档（复杂结构有小错但意图明显）
- 四档：12 = 接近五档；11 = 稳定达档；10 = 刚进档（要点或语气有一处明显不足）
- 三档：9 = 接近四档；8 = 中段；7 = 刚进档
- 二档：5-6 = 勉强达意；4 = 理解吃力；一档：2-3 = 零星可读；1 = 几乎无效
- **9 分不是默认分**：给 8-9 须有「要点主体齐 + 语言平淡多小错」的明确画像；要点齐全且语言可用的应给 11+，语言流畅有亮点的敢给 13-14。
${stage === 'junior' ? `
### 定档硬触发器
- 漏掉题干要点 → 至多三档
- 时态与体裁严重不符（记叙经历通篇现在时）→ 语言维度至多 2 分
- 格式错误（书信缺称呼或落款）→ 酌情降 1-3 分
- 词数明显不足（少于 60 词）→ 至多三档，并扣 2 分
- 通篇中文拼音/未作答/全抄 → 0-1 分` : `
### 定档硬触发器
- 漏掉主要要点（目的/时间/地点/行动号召之一）→ 至多三档
- 格式错误（书信缺称呼或落款）→ 酌情降 1-3 分
- 词数明显不足（少于 60 词）→ 至多三档，并扣 2 分
- 大段照抄题干提示语 → 至多二档`}
${stage === 'junior' ? `
### 校准锚例（仅供定档对照；禁止照抄进范文或练习）
- 锚例 A（弱，5 分，二档）：“Last weekend I very happy. I play football with my friends. We was exciting. Then I do my homework and watch TV.” —— 时态混乱（play/do/watch 现在时记过去事）、We was 主谓错误、无衔接 → 内容 2 + 语言 2 + 结构 1 = 5。
- 锚例 B（强，12 分，四档上段）：“Last Saturday, I visited the museum with my classmates. We saw many old things and took photos there. It was so interesting that I forgot the time.” —— 要点齐、时态一致、so...that 亮点 → 内容 6 + 语言 4 + 结构 2 = 12。` : `
### 校准锚例（仅供定档对照；禁止照抄进范文或练习）
- 锚例 A（弱，7 分，三档）：“Dear Mr. Smith, I am write to invite you to our English drama night. It will hold on June 15th in our school hall. There will have many wonderful shows. I hope you can come. Li Hua” —— 要点基本齐（目的/时间/地点），但语法错误多（am write / will hold / There will have）、无亮点 → 内容 4 + 语言 2 + 结构 1 = 7。
- 锚例 B（强，13 分，五档刚进档）：“Dear Mr. Smith, On behalf of the Students’ Union, I warmly invite you to judge our English drama night on June 15th. We would be honored by your presence and grateful for your guidance. Li Hua” —— 要点齐全、复杂结构准确、语域得体 → 内容 6 + 语言 5 + 结构 2 = 13；距 14-15 还差一处细节扩展。`}
${notes}${juniorNote}

### 分数输出要求
- scoreBreakdown（content/language/cohesion 三个整数，之和 = score）放在 score 之前输出；score 为 0-15 整数，maxScore: 15。
- overallComment 按「①最突出的 1 个优点 ②定档结论与一句依据（如：定四档下段（10/15），要点全但句式平淡、错误偏多）③最需要改进的 1 个方面」组织。`;
  }
  return `## 评分标准与评分程序（读后续写满分 25 分）

### 评分程序（严格按顺序执行，禁止跳步先出总分）
1. 摘证据（内部完成，不必输出）：情节如何呼应原文人物/地点/线索/伏笔；两段是否围绕所给段首句展开；语法/拼写/搭配错误清单及影响理解的处数；使用的衔接手段；描写类型覆盖（动作/对话/心理/情绪/环境）。
2. 分维度打分：内容 x/10、语言 x/10、衔接 x/5（整数），先输出 scoreBreakdown 三个维度分，再输出总分 score。
3. 定档：三维之和对照锚点表定档；维度之间矛盾（如内容高档语言低档）时，按更低的一档定位档内位置。
4. 档内取分并复查：按档内取分规则落到具体分数（禁止不加判断取档内中间值）；逐条核对定档硬触发器，命中即执行；自查 score = 三维之和。

### 评分维度
- 内容（10 分）：与原文融洽度（人物/地点/线索/伏笔的呼应）、两段围绕段首句展开程度、丰富性与完整性、描写多样性
- 语言（10 分）：词汇与语法结构的准确性、恰当性、多样性；错误数量及是否影响理解
- 衔接（5 分）：段首句利用、段间过渡、连接成分使用、全文连贯

### 维度分档对照（每维按证据所属档取分；允许相邻档跨档，任意两维相差不超过 1 个档次）
| 档次 | 内容(/10) | 语言(/10) | 衔接(/5) |
|------|------|------|------|
| 五档 | 9-10 | 9-10 | 5 |
| 四档 | 7-8 | 7-8 | 4 |
| 三档 | 5-6 | 5-6 | 3 |
| 二档 | 3-4 | 3-4 | 2 |
| 一档 | 1-2 | 1-2 | 1 |

### 五档锚点表
| 档次 | 区间 | 判据 |
|------|------|------|
| 五档 | 21-25 | 须全部满足：①呼应原文人物/地点/线索/伏笔 ②两段围绕段首句自然展开且续写完整 ③有高级词汇或复杂句式且使用准确 ④描写至少覆盖三类 ⑤无影响理解的错误，结尾有情感落点或主题升华 |
| 四档 | 16-20 | 情节总体合理完整，语言基本准确、有小错但不影响理解；未满足五档全部判据 |
| 三档 | 11-15 | 情节平铺直叙或局部脱节，简单句为主句式变化少，小错成串但大意可懂，两段篇幅失衡或词数不足 |
| 二档 | 6-10 | 情节与原文明显脱节或逻辑重大问题，词汇语法单调，错误成片部分影响理解 |
| 一档 | 1-5 | 与原文基本脱节、情节混乱，错误极多严重影响理解，几乎无衔接。未作答或全抄原文 = 0 分 |

### 档内取分规则（反默认分，必须执行）
- 五档：22-25 仅给「情节与语言双优且有升华」；21 = 刚进本档（单项略平）
- 四档：19-20 = 接近五档（情节完整+语言流畅，仅缺升华或缺一类描写）；17-18 = 稳定完成任务、无硬伤也无任何亮点；16 = 刚达本档（有一处可见瑕疵：衔接生硬/情节仓促/错误略多/描写单一）
- 三档：14-15 = 接近四档（达意通顺但句式与情节皆平淡）；11-13 = 小错成串或篇幅明显不足
- 二档：8-10 = 勉强达意；6-7 = 理解明显吃力
- 一档：3-5 = 尚有零星可读句；1-2 = 几乎无效输出

### 定档硬触发器（任一命中直接执行，语言质量不能补救）
- 情节与所给段首句矛盾、未围绕段首句展开或无实质推进（一两句凑数收尾、与段首句无关的新内容）→ 至多二档
- 大段照搬原文（超过续写篇幅 30%）→ 至多一档；整篇照抄 → 0 分
- 两段合计词数少于 100 词 → 至多三档，并从总分中扣 2 分
- 影响理解的错误约每 100 词 ≥ 5 处 → 不得进入四档

### 关于 18 分的特别说明
18 分不是默认分。只有「情节稳定合理 + 语言基本流畅 + 无硬伤也无任何亮点」同时成立才给 17-18；描写只有动作和对话（缺心理与环境）属于内容维度第四档下限的证据，通常对应 16-17 分；只要有一项出色（心理描写生动、伏笔回扣巧妙、亮点句式准确）就应给 19-20。

### 校准锚例（仅供定档对照；禁止把锚例语言照抄进范文或练习）
- 锚例 A（弱，12 分，三档）：“On hearing the news, I rushed to the hospital. My grandfather lie in bed, looking very weak. I hold his hand and said, ‘Don’t worry. You will get well soon.’ He smiled at me happy.” —— 情节跟得上、读者能懂，但通篇简单句、时态与词形错误成串（lie/hold/happy）、无描写 → 内容 5 + 语言 5 + 衔接 2 = 12。
- 锚例 B（强，20 分，四档上限）：“The moment her fingers brushed the yellowed photograph, tears welled up in her eyes. Just then, slow but familiar footsteps echoed down the hallway — Grandpa, leaning on his stick, stood quietly at the door, smiling.” —— 细节描写充分（动作+环境+神态）、衔接自然、语言准确多样；但情节推进单薄、无主旨升华 → 内容 8 + 语言 8 + 衔接 4 = 20，够不着五档。
${notes}

### 分数输出要求
- scoreBreakdown（content/language/cohesion 三个整数，之和 = score）放在 score 之前输出；score 为 0-25 整数，maxScore: 25。
- overallComment 按「①最突出的 1 个优点 ②定档结论与一句依据（如：定四档下段（16/25），描写单一、句式平淡）③最需要改进的 1 个方面」组织。`;
}

function getLevelAdjustRules(stage: Stage): string {
  if (stage === 'junior') {
    return `## 词汇难度控制（严格遵守，绝对禁止违规）
根据学生得分严格控制用词难度：
- **得分 ≥ 12/15（书面表达）**：词汇升级/句式工坊模块可以使用少量中考真题进阶词（仍须在课标三级词汇附近），用于优生积累，每篇不超过 2 个；**但范文升级版的词汇必须始终限制在课标三级词汇（中考约 1600 词）以内**（范文只示范句式，不引入生词）
- **得分 < 12/15**：**绝对禁止**使用超出课标三级词汇表的高中/超纲词汇（如 invigorating, exhilarating, meticulously, jubilant, ecstatic, eloquent, exquisite）、罕见形容词副词。全部词汇必须限制在中考 1600 词范围内。范文、词汇升级、句式工坊均须严格遵守
- **评分判断标准**：若学生原文中基础词都有拼写/用法错误，其水平必然 < 12 分档，绝对不得给出超纲词。**宁可词汇保守，不可拔苗助长**

## 难度校准（根据学生得分档次调整内容）
- 一/二档（基础弱）：词汇升级给最基础的替换（good→nice）；句式工坊以纠错为目标；范文保留原文结构仅修正错误
- 三档（中等）：词汇给中考高频替换词（good→wonderful）；句式引入宾语从句/状语从句/被动语态；范文适度提升
- 四/五档（优秀）：可使用初中范围内的地道表达（good→excellent）和 not only...but also / so...that... 等结构；句式展示定语从句（基础）/感叹句/比较级；范文全面升级（仍不超出初中语法范围）`;
  }
  return `## 词汇难度控制（严格遵守，绝对禁止违规）
根据学生得分严格控制用词难度：
- **得分 ≥ 12/15（应用文）或 ≥ 20/25（读后续写）**：词汇升级/句式工坊模块可以使用少量高级/地道词汇，用于优生积累，每篇不超过 2 个；**但范文升级版的词汇必须始终限制在高考 3500 词以内**（范文只示范句式，不引入生词）
- **得分 < 12/15 或 < 20/25**：**绝对禁止**使用以下类型的词汇：六级/考研难度词（如 invigorating, exhilarating, meticulously, jubilant, ecstatic, exuberant, eloquent, exquisite）、罕见形容词副词。全部词汇必须限制在高考 3500 词范围内。范文、词汇升级、句式工坊均须严格遵守
- **评分判断标准**：若学生原文中基础词都有拼写/用法错误，其水平必然 < 12 分档，绝对不得给出超纲词。**宁可词汇保守，不可拔苗助长**

## 难度校准（根据学生得分档次调整内容）
- 一/二档（基础弱）：词汇升级给最基础的替换（good→nice）；句式工坊以纠错为目标；范文保留原文结构仅修正错误
- 三档（中等）：词汇给常用课纲高级词（good→beneficial）；句式引入定语从句/状语从句；范文适度提升
- 四/五档（优秀）：可使用少量地道表达（good→favorable）；句式展示倒装/强调/虚拟；范文全面升级`;
}

// ─── 共享的 9 模块学案结构（含内容量限制）────────────────

function getWorksheetStructure(essayType: EssayType, stage: Stage): string {
  const isPractical = essayType === 'practical';
  const isJunior = stage === 'junior';
  const vocabCeiling = isJunior
    ? `- **词汇限制（极其重要，违反即不合格）**：范文的全部词汇必须限制在**《义务教育英语课程标准（2022年版）》三级词汇（中考约 1600 词）以内**（课标词的构词法派生词 -ly/-ful/-less/-tion 等与专有名词不算超纲），让学生只模仿句式、不被生词分心。**绝对禁止**出现初中生不熟悉、超出中考考纲的词，例如 oak、scramble、ascend、composure、bewildered、frantically、invigorating、jubilant、exquisite 等；高级感只通过**句式**（宾语从句、状语从句、基础定语从句、被动语态、比较级、不定式等）体现，绝不通过生僻词汇体现；定语从句全文最多 1 处且仅限 that / which / who 限定性。`
    : `- **词汇限制（极其重要，违反即不合格）**：范文的全部词汇必须限制在**高考大纲 3500 词以内**，让学生只模仿句式、不被生词分心。**绝对禁止**出现高中生不熟悉、高考词典查不到的词，例如 oak、scramble、ascend、composure、bewildered、frantically、invigorating、jubilant、exquisite 等；高级感只通过**句式**（定语从句、非谓语、倒装、强调、虚拟语气等）体现，绝不通过生僻词汇体现。`;
  return `## 学案生成要求

请按以下 8 个模块结构生成学案（使用中文讲解，英文示例和练习），输出为严格的 JSON 对象。
学案目标打印为 A4 纸正反 2 页，请严格控制内容量。

### 0. 审题分析（不可省略）
对照题干要求，分析学生的作文：
- isOffTopic：是否偏题（boolean）
- offTopicDetail：如偏题，具体说明偏在哪里；如不偏题，写"未偏题"（≤ 1 句）
- coveredPoints：已覆盖的题干要点（字符串数组，每条 ≤ 8 字）
- missedPoints：遗漏的题干要点（字符串数组，每条 ≤ 8 字）
- overallComment：审题总体评价（1 句）

### 一、作文总评
简要评价（2-4 句，共 ≤ 120 字），必须依次包含：①最突出的 1 个优点；②定档结论（档次 + 档内位置 + 分数，如「定四档下段（16/25）」）与一句依据；③最需要改进的 1 个方面。评价须与维度证据一致，不得与档位矛盾。

### 二、错误分类诊断（不可省略）
分四类列出具体错误，每项 explanation ≤ 15 字：
- grammar：语法错误（固定 3 条），original → corrected → explanation
- vocabulary：词汇不当（固定 3 条），original → suggestion → explanation
- sentence：句式问题（固定 2 条），original → improvement → explanation
- logic：逻辑/连贯问题（固定 1 条），issue → explanation

### 三、重点语法突破（可压缩）
选取本篇作文中**最突出的 1 个**语法弱点，仅做规则讲解（不含练习）：
- rules：1 条规则，含 title、explanation（≤ 40 字）、1-2 个 examples

### 四、词汇升级训练（可压缩）
从作文中选出 **3-4 个**可升级的基础词汇（items），每个给出 original + **1-2 个**替换词（upgrades，标注 word 和 context）。

### 五、句式提升工坊（可压缩）
选取 **1-2 个**比较弱的句子（items），每个以表格形式呈现：original → analysis（≤ 15 字）→ improved → highlights（≤ 12 字）。

### 六、范文升级版（固定格式）
将学生作文全文改写为升级版范文，保留原文的核心观点，修正语法和词汇问题，提升句式多样性。
${vocabCeiling}
${isPractical ? `（modelEssay 为纯文本字符串）
- 正文部分 **6-8 句**，每句 ${isJunior ? '8-15' : '10-20'} 词，总正文词数控制在 **${isJunior ? '80-100' : '80-110'} 词**${isJunior ? '（中考书面表达词数标准）' : ''}
- **段落结构（应用文，用 \\\\n\\\\n 分隔，共 5 段）—— 严格总分总结构，无论学生原文如何都必须遵守**：
  - 第 1 段：称呼（Dear X, / To X,）—— 独立成段，不编号
  - 第 2 段：开头总述（1-2 句）—— 交代背景、引出信件主题
  - 第 3 段：主体展开（3-4 句）—— 详细描述内容、感受
  - 第 4 段：总结收尾（1-2 句）—— 总结感受、点题升华
  - 第 5 段：署名（Yours, / Sincerely, + Li Hua / Li Ming）—— 独立成段，不编号
- 句子编号 ①②③④⑤⑥⑦⑧ 跨段连续，关键改进处行末加【xxx】
- **范文开头多样化**：避免所有学生使用相同句式开头，可选用：${isJunior ? '时间状语开头、情感词开头、介词短语开头等' : '分词短语开头、时间状语开头、情感词开头等'}` : `（modelEssay 为表格对象，含 paragraph1 和 paragraph2 两个数组）
- **绝对禁止**出现 Dear, Yours, Sincerely, Li Hua, 称呼、署名、落款等任何书信格式元素！！！读后续写是记叙文，不是书信！！！
- **每个数组元素为对象 { sentence, function }**：
  - sentence：续写句子的英文原文，**不包含题目给出的段首句**（段首句不写入表格）
  - function：叙事功能 + 技法批注，格式为"功能（技法）"，如"动作描写（现在分词作状语）""衔接上文（分词短语开头）""主旨升华（Not until 倒装句）"。技法批注必写，说明该句用到的核心语法/句式
- **五定句式（必须全部包含，缺一不可）**：
  1. **衔接句 × 3**：第 1 段首句「衔接上文」、第 1 段末句「衔接后文」（引出第 2 段段首句）、第 2 段首句「衔接上文」
  2. **结局句 × 1**：第 2 段的故事结局
  3. **主旨升华句 × 1**：第 2 段结尾的主题升华/点题
- **每段必须 4-5 句**（绝不能只有 3 句），可在五定句之间自由加入描写过渡句（动作/心理/语言/环境/情绪），两段合计 8-10 句
- **每段词数控制在 70-80 词（约 75 词）**，每句 15-20 词，描写要具体充实，不要写得太短、太空
- **范文开头多样化**：避免所有学生使用相同句式开头`}

### 七、巩固练习 / 范文默写（弹性+智能选取）
从升级版范文正文中选取句子设计默写练习。选取规则（按优先级）：
${isPractical ? `1. **开头句**（必选）—— 范文正文的第 ① 句
2. **结尾句**（必选）—— 范文正文的最后一句
3. **高分句式句**（优先）—— ${isJunior
      ? '包含宾语从句、状语从句（when/if/because/so that）、被动语态、比较级、不定式、感叹句、not only...but also、so...that... 等初中高分句式的句子'
      : '包含非谓语、倒装、虚拟语气、强调句、定语从句、名词性从句、with 复合结构等的句子'}
4. 如果范文正文有 6 句，选 4 句默写；如果有 7-8 句，选 5-6 句
**不要选取称呼和署名。**` : `1. **结尾句/主旨升华句**（必选）—— 范文正文的最后一句（主旨升华句）
2. **高分句式句**（优先）—— 包含非谓语、倒装、虚拟语气、强调句、定语从句、名词性从句、with 复合结构等的句子
3. 如果范文正文有 6-7 句，选 3-4 句默写；如果有 8-10 句，选 4-5 句
**只从范文表格的句子中选取**（表格中已不含段首句，故无需额外排除段首句）。`}每个句子包含：
- cn：该句的中文翻译
- pattern：该句使用的核心句式名称（${isJunior
      ? '如"宾语从句""if 条件状语从句""被动语态""so...that... 结构""感叹句""not only...but also 并列结构"等初中语法名称'
      : '如"现在分词短语作状语""Not only 引导的部分倒装句""表语从句 + 非限制性定语从句""虚拟语气""强调句""with 复合结构"等'}）
- en：该句的英文原文（与 modelEssay 中对应句子的英文一致）`;
}

function getJsonExample(essayType: EssayType, stage: Stage): string {
  const juniorPracticalExample = `## 输出 JSON 结构示例
{
  "studentName": "张三",
  "promptAnalysis": {
    "isOffTopic": false,
    "offTopicDetail": "未偏题",
    "coveredPoints": ["学校的体育场馆", "主要的运动项目", "我喜欢的项目"],
    "missedPoints": [],
    "overallComment": "审题准确，三个要点均已覆盖，词数达标，格式符合书信要求。"
  },
  "overallComment": "要点齐全、格式正确，但无内容扩展，句式以简单句为主，时态和拼写错误成片——定四档下段（10/15）；建议用连接词整合简单句并做要点扩展。",
  "scoreBreakdown": { "content": 5, "language": 3, "cohesion": 2 },
  "score": 10,
  "maxScore": 15,
  "errorDiagnosis": {
    "grammar": [{"original": "There is many sports", "corrected": "There are many sports", "explanation": "主谓一致错误，sports为复数应用are"}],
    "vocabulary": [{"original": "good", "suggestion": "wonderful / great", "explanation": "good过于平淡，可用更生动的形容词"}],
    "sentence": [{"original": "I like basketball. It is fun.", "improvement": "用 because 合并为一个句子", "explanation": "两个简单句零散，可用连接词整合"}],
    "logic": [{"issue": "第二段突然从运动跳到饮食，缺少过渡", "explanation": "段落间缺乏衔接，建议用 First / What's more"}]
  },
  "grammarBreakthrough": {
    "rules": [{"title": "主谓一致", "explanation": "主语和谓语在人称和数量上保持一致...", "examples": [{"en": "There are many students in the classroom.", "cn": "教室里有很多学生。"}]}]
  },
  "vocabularyUpgrade": {
    "items": [{"original": "good", "upgrades": [{"word": "wonderful", "context": "形容经历美好"}, {"word": "excellent", "context": "形容水平极高"}]}]
  },
  "sentenceImprovement": {
    "items": [{"original": "I like playing basketball. It makes me happy.", "analysis": "两个简单句，缺少连接", "improved": "I like playing basketball best because it makes me happy and healthy.", "highlights": "because 原因状语从句连接两句"}]
  },
  "modelEssay": "Dear Mr. Green,\\n\\n① I am sorry to tell you that I cannot return your English book this Friday.【宾语从句】 ② I have not finished reading it because I was busy with the school sports meeting last week.【because 原因状语从句】\\n\\n③ The book is very interesting, and I have learned a lot from it. ④ I think I can finish reading it next Tuesday. ⑤ Is it OK if I give the book back to you next Wednesday morning?【if 条件状语从句】\\n\\n⑥ Thank you for lending me the book. ⑦ I will keep it clean and return it on time.\\n\\nYours, Li Hua",
  "consolidationExercises": [
    {"cn": "我很抱歉地告诉你，我这周五不能把你的英语书还给你。", "pattern": "宾语从句", "en": "I am sorry to tell you that I cannot return your English book this Friday."},
    {"cn": "如果我下周三早上把书还给你，可以吗？", "pattern": "if 条件状语从句", "en": "Is it OK if I give the book back to you next Wednesday morning?"},
    {"cn": "谢谢你把书借给我，我会保持它干净并按时归还。", "pattern": "并列句 + will 未来时", "en": "Thank you for lending me the book. I will keep it clean and return it on time."}
  ]
}`;

  const practicalExample = `## 输出 JSON 结构示例
{
  "studentName": "张三",
  "promptAnalysis": {
    "isOffTopic": false,
    "offTopicDetail": "未偏题",
    "coveredPoints": ["学校的体育场馆", "主要的运动项目", "我喜欢的项目"],
    "missedPoints": [],
    "overallComment": "审题准确，三个要点均已覆盖，格式符合书信要求。"
  },
  "overallComment": "要点齐全、结构完整，但句式较为单一，时态和拼写错误较多——定四档下段（10/15）；建议学会用连接词整合简单句。",
  "scoreBreakdown": { "content": 5, "language": 3, "cohesion": 2 },
  "score": 10,
  "maxScore": 15,
  "errorDiagnosis": {
    "grammar": [{"original": "There is many sports", "corrected": "There are many sports", "explanation": "主谓一致错误，sports为复数应用are"}],
    "vocabulary": [{"original": "good", "suggestion": "beneficial / advantageous", "explanation": "good过于口语化，建议使用更正式的形容词"}],
    "sentence": [{"original": "I like basketball. It is fun.", "improvement": "合并为定语从句或使用连接词", "explanation": "两个简单句过于零散，建议整合"}],
    "logic": [{"issue": "第二段突然从运动跳到饮食，缺少过渡", "explanation": "段落间缺乏逻辑衔接，建议加过渡句"}]
  },
  "grammarBreakthrough": {
    "rules": [{"title": "主谓一致", "explanation": "主语和谓语在人称和数量上保持一致...", "examples": [{"en": "There are many students in the classroom.", "cn": "教室里有很多学生。"}]}]
  },
  "vocabularyUpgrade": {
    "items": [{"original": "good", "upgrades": [{"word": "beneficial", "context": "形容事物有益处"}, {"word": "excellent", "context": "形容品质极好"}]}]
  },
  "sentenceImprovement": {
    "items": [{"original": "I like playing basketball. It makes me happy.", "analysis": "两个简单句，缺少逻辑连接", "improved": "I am particularly fond of playing basketball, which never fails to lift my spirits.", "highlights": "使用be fond of升级like，定语从句连接两句，lift spirits使表达更生动"}]
  },
  "modelEssay": "Dear Mr. Green,\\n\\n① I am writing to express my sincere apology for failing to submit the English book report on time. ② The reason for my delay is that I was so caught up in a family gathering yesterday that I completely forgot about the assignment.【so...that...因果链】 ③ By the time I realized, it was late at night.\\n\\n④ To make up for this, not only have I finished reading the book, but I will also submit the report by this Friday.【Not only倒装句升级】 ⑤ I would appreciate it if you could grant me this extension.【虚拟语气】 ⑥ Once again, I sincerely apologize for any inconvenience caused.【过去分词作后置定语】\\n\\nYours sincerely, Li Hua",
  "consolidationExercises": [
    {"cn": "怀着满腔歉意写信给你，我为自己未能按期上交英语读书报告感到非常抱歉。", "pattern": "现在分词短语作状语", "en": "Writing to you with a heart full of regret, I feel terribly sorry that I will fail to hand in the English book report on schedule."},
    {"cn": "我迟到的原因是我昨天得了重感冒，这使我无法集中精力学习。", "pattern": "表语从句 + 非限制性定语从句", "en": "The reason for my delay is that I contracted a severe flu yesterday, which prevented me from concentrating on my study."},
    {"cn": "为了弥补这一点，我不仅已经读完了这本书，而且还会尽快完成报告。", "pattern": "Not only 引导的部分倒装句", "en": "To make up for this, not only have I finished reading the book, but I will also complete the report as soon as possible."}
  ]
}`;

  const continuationExample = `## 输出 JSON 结构示例（读后续写）
{
  "studentName": "李四",
  "promptAnalysis": {
    "isOffTopic": false,
    "offTopicDetail": "未偏题",
    "coveredPoints": ["情节承接合理", "人物性格一致", "两段段首句衔接自然"],
    "missedPoints": ["心理/环境描写", "有力的主旨升华"],
    "overallComment": "续写情节合理承接前文，两段结构清晰，人物性格前后一致。"
  },
  "overallComment": "情节承接合理、两段衔接自然，但描写以动作和对话为主，缺少心理与环境描写，句式以简单句为主、时态和冠词小错多处——定四档下段（16/25）；建议补充心理描写并补一个情感落点。",
  "scoreBreakdown": { "content": 6, "language": 6, "cohesion": 4 },
  "score": 16,
  "maxScore": 25,
  "continuationAnalysis": {
    "p1ConnectsToOpening": true,
    "p1EndConnectsToP2": true,
    "hasThemeHighlight": false,
    "onlyTwoParagraphs": true,
    "detail": "第一段衔接首句自然，段尾顺利过渡到第二段首句；结尾平铺收束，缺少有力的主旨升华。建议增加心理描写并补情感落点。",
    "descriptionDiversity": { "action": true, "dialogue": true, "emotion": false, "environment": false, "comment": "描写以动作和对话为主，缺少心理活动和环境烘托" }
  },
  "errorDiagnosis": {
    "grammar": [{"original": "He run quickly", "corrected": "He ran quickly", "explanation": "时态不一致，续写需用过去时"}],
    "vocabulary": [{"original": "very happy", "suggestion": "delighted / overjoyed", "explanation": "very happy过于平淡，可替换为描写情绪的词"}],
    "sentence": [{"original": "He opened the door. He saw his mother.", "improvement": "Opening the door, he caught sight of his mother.", "explanation": "两句合并，使用分词短语作状语"}],
    "logic": [{"issue": "第一段末直接跳到与第二段首句无关的情节", "explanation": "段落衔接应自然过渡到下一段段首句"}]
  },
  "grammarBreakthrough": {
    "rules": [{"title": "续写中谓语的时态一致性", "explanation": "读后续写整体使用一般过去时叙述，除直接引语外所有谓语动词应保持过去时。", "examples": [{"en": "He opened the door and stepped into the darkness.", "cn": "他打开门，走进黑暗中。"}]}]
  },
  "vocabularyUpgrade": {
    "items": [{"original": "walk", "upgrades": [{"word": "pace", "context": "紧张地来回踱步"}, {"word": "tiptoe", "context": "蹑手蹑脚地走"}]}]
  },
  "sentenceImprovement": {
    "items": [{"original": "He was scared and didn't know what to do.", "analysis": "简单描述情绪，缺少画面感", "improved": "A chill ran down his spine as he stood frozen, his mind going blank.", "highlights": "A chill ran down... + 独立主格his mind going blank"}]
  },
  "modelEssay": {
    "paragraph1": [
      {"sentence": "Taking a deep breath, I slowly turned the handle and pushed it open, only to find the room completely dark.", "function": "衔接上文（现在分词作状语 + only to find）"},
      {"sentence": "My heart pounded wildly in my chest, my palms sweating despite the cold air.", "function": "情绪描写（独立主格结构）"},
      {"sentence": "Just as I was about to retreat, a faint light caught my attention from the corner, and I noticed a familiar figure sitting there silently.", "function": "动作描写（时间状语从句 + 现在分词作宾补）"},
      {"sentence": "Gathering all my courage, I stepped forward, whispering, 'I'm back.'", "function": "衔接后文（现在分词作状语 + 直接引语）"}
    ],
    "paragraph2": [
      {"sentence": "It was Mom, who had been waiting for me all along.", "function": "衔接上文（强调句 + 非限制性定语从句）"},
      {"sentence": "Tears welled up in her eyes as she opened her arms wide.", "function": "情绪描写（as 引导的时间状语从句）"},
      {"sentence": "Not until that moment did I truly understand the depth of her love and the pain I had caused.", "function": "故事结局（Not until 引导的部分倒装句）"},
      {"sentence": "I buried my face in her shoulder, realizing that home would always be my safe harbor.", "function": "主旨升华（现在分词作伴随状语 + 主题点题）"}
    ]
  },
  "consolidationExercises": [
    {"cn": "我深吸一口气，慢慢转动手柄推开门，却发现房间里一片漆黑。", "pattern": "现在分词短语作状语 + only to find", "en": "Taking a deep breath, I slowly turned the handle and pushed it open, only to find the room shrouded in complete darkness."},
    {"cn": "直到那一刻，我才真正理解了她爱得有多深、我给她带来了多大的痛苦。", "pattern": "Not until 引导的倒装句", "en": "Not until that moment did I truly understand the depth of her love and the pain I had caused."},
    {"cn": "我扑进母亲的怀抱，深深明白家永远是我最安全的港湾。", "pattern": "现在分词短语作伴随状语 + 主题升华", "en": "I threw myself into Mom's arms, knowing deep down that home would always be my safe harbor."}
  ]
}`;

  if (essayType === 'practical' && stage === 'junior') return juniorPracticalExample;
  return essayType === 'practical' ? practicalExample : continuationExample;
}

// ─── 主 Prompt 构建函数 ──────────────────────────────

interface BuildPromptParams {
  studentName: string;
  gradeLevel: string;
  essayType: EssayType;
  essayPrompt: string;
  essayText: string;
  stage: Stage;
  promptSummary?: string;
  opening1?: string;
  opening2?: string;
  /** 老师审阅上一版学案后的修改要求（备注重新生成） */
  teacherNote?: string;
}

export function buildHandwritingWorksheetPrompt(params: BuildPromptParams): string {
  const { studentName, gradeLevel, essayType, essayPrompt, essayText, stage, promptSummary, opening1, opening2, teacherNote } = params;

  const criteria = essayType === 'practical'
    ? getPracticalWritingCriteria(stage)
    : getContinuationWritingCriteria();

  const essayTypeLabel = essayType === 'practical'
    ? (stage === 'junior' ? '书面表达（应用文）' : '应用文写作')
    : '读后续写';

  // Build prompt display: for continuation, use summary only (not full text)
  const promptDisplay = essayType === 'continuation' && promptSummary
    ? `## 题干概括
${promptSummary}

## 两段段首句（题目给出，学生必须以此开头）
- 第一段段首句：${opening1 || '（未提供）'}
- 第二段段首句：${opening2 || '（未提供）'}`
    : essayPrompt;

  const persona = stage === 'junior'
    ? '你是一位经验丰富的初中英语写作教学专家，熟悉《义务教育英语课程标准（2022年版）》三级词汇表（约 1600 词，含二级 505 词 + 初中新增 1095 词）和中考书面表达评分标准。请根据下面学生的英语作文，创建一份《个性化书面表达提升学案》。'
    : '你是一位经验丰富的高中英语写作教学专家。请根据下面学生的英语作文，创建一份《个性化书面表达提升学案》。';

  return `${persona}

## 学生信息
- 姓名：${studentName}
- 年级：${gradeLevel}
- 作文类型：${essayTypeLabel}
${stage === 'junior' ? `
## 年级适配（按学生年级控制语法与词汇范围）
- 初一：语法限于 be 动词/一般现在时/现在进行时/一般过去时/情态动词，词汇以七年级已学（约 830-880 词）为限
- 初二：可含比较等级 / will / 过去进行时 / 现在完成时，词汇约 1420-1480 词
- 初三：全档（含宾语从句/被动语态/定语从句辨认），词汇 1600-1800 词
- 讲解、范文升级版、巩固练习的句式与词汇难度均须匹配该年级水平` : ''}

${promptDisplay}

${criteria}
${essayType === 'continuation' && opening1 && opening2 ? `
## 段首句规定（必须严格遵守）
题目给出的两段段首句为（学生必须以此开头，但**段首句不写入范文表格**）：
- 第一段段首句：${opening1}
- 第二段段首句：${opening2}

范文表格 paragraph1 的首句（衔接上文）必须承接第一段段首句的内容，paragraph2 的首句（衔接上文）必须承接第二段段首句的内容。段首句本身不写入范文表格，也不需要默写。
` : ''}
${getScoringRubric(essayType, stage)}

${getLevelAdjustRules(stage)}

## 重要说明
学生作文是通过手写 OCR 识别得到的文本，可能存在少量识别错误（如形近字母混淆、空格异常等）。请在理解时自动修正这些 OCR 错误，但要**保留学生的原始语法错误、词汇错误和写作问题**，因为这些正是学案需要诊断和改进的内容。
${teacherNote?.trim() ? `
## 老师备注（本次生成的特别要求，优先级最高）
老师已审阅该生此前的学案，提出以下修改要求。请在保持学案全部章节与 JSON 字段完整的前提下，按备注要求调整对应内容；备注与本提示其他规则冲突时，以备注为准：

${teacherNote.trim()}
` : ''}
## 学生原始作文（共 ${essayText.split(/\n\n+/).filter(Boolean).length} 段）
${essayText.split(/\n\n+/).filter(Boolean).map((p, i) => `【第${i + 1}段】${p.trim()}`).join('\n\n')}

${getWorksheetStructure(essayType, stage)}

${getJsonExample(essayType, stage)}

## 注意事项
- 审题分析要对照题干逐条检查，不可遗漏任何要点
- 错误分类诊断中的例句必须来自学生原文
- 范文升级版要保留原文的核心意思和结构，不可完全重写为新话题
- 所有练习要针对该生的实际弱点设计，不可使用泛泛的模板题目
- 语言要亲切鼓励，符合教育场景；但亲切只体现在评语措辞，绝不体现在分数与定档——分数必须忠实于评分标准的锚点表
- ${essayType === 'practical' ? '应用文要注意格式规范（称呼、落款、日期等）' : '【读后续写特别警告】绝对禁止在范文（modelEssay）、巩固练习或任何其他字段中出现：Dear、Yours、Sincerely、Li Hua、称呼、署名、落款等书信格式内容！读后续写是记叙文，不是书信！modelEssay 必须是表格对象，只能有 paragraph1 和 paragraph2 两个数组，不允许出现第 3 段！'}
- 请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
}

// ─── 班级讲评报告 Prompt（④ 讲评报告，整班一次调用）──

export interface ClassReportPromptParams {
  stage: Stage;
  essayType: EssayType;
  gradeLevel: string;
  essayPrompt: string;
  promptSummary?: string | null;
  opening1?: string;
  opening2?: string;
  /** 客观统计（客户端现算，随 user content 下发，system 里只立口径规则） */
  stats: ClassStats;
  /** 全班匿名摘要行（buildStudentDigests 产出） */
  digests: string[];
  /** 高分学生原文（具名，仅供亮点摘句；pickHighlightTexts 产出） */
  highlightTexts: { studentName: string; text: string }[];
}

export function buildClassReportSystemPrompt(params: ClassReportPromptParams): string {
  const persona = params.stage === 'junior'
    ? '你是一位经验丰富的初中英语写作教学专家，熟悉中考书面表达评分标准。全班同学的作文已完成批改，请基于批改数据生成一份《班级讲评报告》，供老师准备作文评讲课使用。'
    : '你是一位经验丰富的高中英语写作教学专家。全班同学的作文已完成批改，请基于批改数据生成一份《班级讲评报告》，供老师准备作文评讲课使用。';

  return `${persona}

## 口径说明
- 档位为五档制：第五档最高、第一档最低
- 「客观统计」由程序从批改数据算出，分数可能经老师人工核对修改——你的全部叙述必须与统计口径一致，不得编造或夸大频次
- 学生摘要行匿名编号（学生1、学生2…为录入顺序），共性问题取证只能引用摘要行中出现的例句

## 内容要求（逐节硬规则）
### commonProblems（共性问题，3-6 条，按「出现频次 × 严重度」降序）
- 每条必须引用「全班学生摘要」中出现的真实学生原句作为错例（quote=原句，corrected=改正），禁止编造例句
- **匿名铁律：本节任何位置不得出现任何学生姓名**，表述一律用「有同学写道…」「部分同学…」
- description（2-4 句中文）说明现象、影响与频次依据，频次表述必须与客观统计一致
- severity：多数学生存在且显著拉分 → high；部分学生存在 → medium；少数学生存在 → low

### suggestions（建设性意见，3-5 条）
- 面向下一轮训练的具体可操作建议：写出可布置的练习形式、数量、检查方式
- 禁止「加强语法教学」「多加练习」式空话；每条建议应针对某条共性问题或统计所见的薄弱维度

### highlights（亮点展示，2-4 条）
- sentence 必须逐字摘自「高分学生原文（具名）」部分，禁止改写、拼凑或自创
- studentName 使用原文部分给出的真实姓名（本节是表扬，允许点名）
- comment（1-2 句中文）说明好在哪里、其他同学可以迁移什么技法

### lessonPlan（评讲课建议，4-6 条）
- 一节评讲课的环节安排，每条格式「环节名（建议时长）：做法」，总时长约 40-45 分钟
- 环节须覆盖：整体数据反馈、共性问题精讲、亮点欣赏、学生活动（如当堂改错）、小结

## 自检清单（输出前逐条核对）
1. commonProblems 中没有出现任何学生姓名
2. 每条 commonProblems 的错例都能在「全班学生摘要」中找到出处
3. highlights 每个句子都能在「高分学生原文」中逐字找到
4. lessonPlan 每条都有建议时长
5. 高分学生原文部分的姓名只出现在 highlights，不得泄漏到其他任何字段

## 输出格式（严格 JSON）
{
  "commonProblems": [
    {
      "title": "一般过去时动词未变形",
      "description": "客观统计中语法类错误频次最高，叙事段落普遍出现动词原形直用，是语言维度的最大失分点……",
      "severity": "high",
      "examples": [
        { "quote": "I play football with my friends last weekend.", "corrected": "I played football with my friends last weekend.", "note": "时间状语 last weekend 提示过去时，play 应为 played" }
      ]
    }
  ],
  "suggestions": [
    "布置 10 句「时间状语 + 动词」过去时改错专项，收齐后课上 5 分钟快讲高频错例。"
  ],
  "highlights": [
    { "studentName": "张三", "sentence": "The moment her fingers brushed the yellowed photograph, tears welled up in her eyes.", "comment": "动作细节 + 神态描写，画面感强；全班可迁移「The moment + 从句」开头。" }
  ],
  "lessonPlan": [
    "数据概览（3 分钟）：投影五档分布与平均分，先肯定整体亮点。",
    "共性问题精讲（15 分钟）：逐条投出错例，学生先改再对答案。"
  ]
}

## 注意事项
- 语言专业、克制，共性问题对事不对人；亮点点评具体、可迁移
- 请严格按照 JSON 格式返回，不要包含任何额外的解释文字。`;
}

export function buildClassReportUserContent(params: ClassReportPromptParams): string {
  const { stage, essayType, gradeLevel, essayPrompt, promptSummary, opening1, opening2, stats, digests, highlightTexts } = params;
  const essayTypeLabel = essayType === 'practical'
    ? (stage === 'junior' ? '书面表达（应用文）' : '应用文写作')
    : '读后续写';

  // 题干展示：续写用摘要（同 buildHandwritingWorksheetPrompt 口径）
  const promptDisplay = essayType === 'continuation' && promptSummary
    ? `题干概括：${promptSummary}
两段段首句（题目给出）：第一段 ${opening1 || '（未提供）'} / 第二段 ${opening2 || '（未提供）'}`
    : essayPrompt;

  const s: string[] = [];
  s.push('## 题目信息');
  s.push(`- 作文类型：${essayTypeLabel}`);
  s.push(`- 年级：${gradeLevel}`);
  s.push(promptDisplay);

  s.push('');
  s.push('## 客观统计（已由程序算出，叙述须与其一致）');
  s.push(`- 参与统计 ${stats.studentCount} 人${stats.excludedCount > 0 ? `（另有 ${stats.excludedCount} 份生成失败未计入，不要用「全班」轻易覆盖他们）` : ''}${stats.pendingCount > 0 ? `（另有 ${stats.pendingCount} 份尚未生成，未计入——统计只覆盖已生成的部分）` : ''}`);
  if (stats.avgScore != null) {
    s.push(`- 有分数 ${stats.scoredCount} 人：平均分 ${stats.avgScore}，最高 ${stats.maxScore}，最低 ${stats.minScore}${stats.scoreScale ? `（满分 ${stats.scoreScale}）` : ''}`);
  } else {
    s.push('- 无有效分数（老师尚未核对出分数）');
  }
  if (stats.bandDistribution) {
    const names = ['一档（最低）', '二档', '三档', '四档', '五档（最高）'];
    s.push(`- 五档分布：${stats.bandDistribution.map((n, i) => `${names[i]} ${n} 人`).join('，')}`);
  }
  const bd = stats.avgBreakdown;
  if (bd.content != null || bd.language != null || bd.cohesion != null) {
    const cohesionLabel = essayType === 'continuation' ? '衔接' : '结构';
    s.push(`- 分项均分：内容 ${bd.content ?? '—'}，语言 ${bd.language ?? '—'}，${cohesionLabel} ${bd.cohesion ?? '—'}`);
  }
  s.push(`- 错误频次：语法 ${stats.errorCounts.grammar}，词汇 ${stats.errorCounts.vocabulary}，句式 ${stats.errorCounts.sentence}，逻辑 ${stats.errorCounts.logic}`);
  s.push(`- 偏题 ${stats.offTopicCount} 人，遗漏要点共 ${stats.missedPointCount} 处`);

  s.push('');
  s.push('## 全班学生摘要（匿名，学生N 为录入顺序；共性问题取证只能引用此节例句）');
  s.push(digests.length ? digests.join('\n') : '（无）');

  s.push('');
  s.push('## 高分学生原文（具名，仅供 highlights 摘句；姓名不得出现在报告其他任何字段）');
  if (highlightTexts.length) {
    s.push(highlightTexts.map(h => `【${h.studentName}】\n${h.text}`).join('\n\n'));
  } else {
    s.push('（无有效高分原文，highlights 返回空数组 []）');
  }

  return s.join('\n');
}
